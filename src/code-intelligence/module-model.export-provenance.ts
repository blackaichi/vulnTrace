/**
 * Export provenance: the function an export's value is, the declaration it
 * is rooted at, and whether its export assignment is definitely reached once
 * at module scope.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import type { SourceLocation } from "../domain/graph.js";
import {
  declaresCommonJsAmbientShadow,
  resolveLocalValue,
  unwrapParentheses,
  unwrapValue,
} from "./commonjs-reexports.js";
import {
  isNameAssignedWithin,
  lexicalDeclarationOf,
} from "./named-bindings.js";
import { type SourceIndex, toSourceLocation } from "./source-index.js";
import type { ExportBinding } from "./module-model.js";
import { competingWritesCannotBeObservedApart } from "./module-model.competing-writes.js";
import { firstModuleEvaluationCutoff } from "./module-model.evaluation-cutoff.js";

/**
 * How much a single `module.exports = X` / `export = X` write can be
 * trusted to describe the module's exported value, judged purely
 * syntactically (RWF-014). The three cases differ in WHEN the write runs,
 * which is the only thing that decides whether a later write overwrites
 * it:
 *
 * - `"unconditional"` — the write's own statement is a direct child of the
 *   source file (modulo a chained-assignment climb; see
 *   {@link isDefinitelyReachedExportAssignment}). Module evaluation runs every
 *   such statement, exactly once, in source order. This write DEFINITELY
 *   happens, and definitely happens before every later top-level one.
 * - `"conditional"` — nested inside an `if`/`else`/`try`/`catch`/`finally`/
 *   `switch`/loop/bare block, but still inside the module's own top-level
 *   statement list. It MAY not run; if it does run, it runs at the point
 *   its enclosing top-level statement is reached, so source order still
 *   orders it against the unconditional writes around it.
 * - `"deferred"` — nested inside a function, class body, or class static
 *   block. Source position says NOTHING about when it runs: a
 *   `function configure() { module.exports = fn; }` can be called by an
 *   IMPORTER, long after module evaluation finished, and overwrite an
 *   assignment that appears later in the file. An IIFE is classified here
 *   too — proving that a function expression is invoked immediately is
 *   call-graph work this relation deliberately does not do.
 * - `"bypassable"` — a direct child of the source file exactly as
 *   `"unconditional"` is, but with an earlier top-level statement that can
 *   end module evaluation before it (a module-scope `return`, or an
 *   uncaught `throw`) — so it runs on SOME loads and not others (RWF-015).
 *   Being written at top level is what makes this distinct from
 *   `"conditional"`, and being skippable is what stops it being
 *   `"unconditional"`; see {@link isDefinitelyReachedModuleScopeStatement}.
 */
type WholeModuleExportAuthority =
  "unconditional" | "bypassable" | "conditional" | "deferred";

interface ModuleExportsAssignment {
  readonly rhs: ts.Expression;
  readonly location: SourceLocation;
  /**
   * Whether the assignment is an UNCONDITIONAL module-scope statement —
   * its own statement is a direct child of the source file, not nested
   * inside an `if`/`try`/loop/function body (RWF-003).
   *
   * Deliberately NOT the same test as {@link authority}, which climbs out
   * through chained assignments first: the two differ for exactly one
   * real shape, `exports = module.exports = require("./debug")` (real
   * `debug@2.0.0`), where the inner `module.exports` write is
   * unconditional by execution but its enclosing node is the outer
   * assignment rather than a statement. The re-export relation accepts
   * that shape and the function-identity relation does not — see
   * {@link wholeModuleDefaultExport}'s two gates.
   */
  readonly isModuleScope: boolean;
  /** This write's execution-time authority — see {@link WholeModuleExportAuthority}. */
  readonly authority: WholeModuleExportAuthority;
}

/** Whether a node is a function-like *expression* — the only value shape a `module.exports = X` assignment can directly make callable. */
function isDirectFunctionValue(
  node: ts.Expression,
): node is ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionExpression(node) || ts.isArrowFunction(node);
}

/**
 * The exact source position of the function-like node a *property*
 * export's right-hand side IS, when the right-hand side is one
 * structurally (RWF-011). The property-export counterpart of
 * {@link directExportedFunctionLocation}, and the same kind of fact: a
 * position identifies exactly one AST node, so this is an identity, never
 * a same-file text match.
 *
 * ```text
 * exports.foo = function () {}      -> that FunctionExpression
 * exports.foo = function bar() {}   -> that FunctionExpression
 * exports.foo = async function () {}-> that FunctionExpression
 * exports.foo = () => {}            -> that ArrowFunction
 * exports.Foo = class { m() {} }    -> that class's constructor
 * module.exports = { foo() {} }     -> that MethodDeclaration
 * ```
 *
 * A class expression IS matched here, unlike in
 * {@link directExportedFunctionLocation}: the callable node a class
 * exports is its constructor, and source-index.ts indexes one for every
 * class — the explicit `constructor() {}` member when the class declares
 * it, and otherwise a synthesized entry positioned at the class's own name
 * (or, for an anonymous class, at the class node itself; see
 * `extractImplicitConstructor`). {@link classConstructorNode} reproduces
 * that choice exactly, so the position resolves to the very entry source
 * indexing recorded. This is what keeps `exports.Foo = class { ... }`
 * attributable — and therefore keeps
 * {@link findExportedClassMembers}'s exported-class set populated — once
 * the coincidental name fallback is gone.
 *
 * `undefined` for every other right-hand side, which is the whole point:
 * `exports.foo = registry.impl`, `exports.foo = makeFoo()`,
 * `exports.foo = obj.foo` and `exports.foo = cond ? a : b` name no
 * function node at all, and this relation says so rather than letting the
 * export's public NAME go looking for one.
 */
function directValueFunctionLocation(
  sourceFile: ts.SourceFile,
  value: ts.Expression,
): SourceLocation | undefined {
  const node = unwrapParentheses(value);
  if (isDirectFunctionValue(node)) {
    return toSourceLocation(sourceFile, node);
  }
  if (ts.isClassExpression(node)) {
    return toSourceLocation(sourceFile, classConstructorNode(node));
  }
  return undefined;
}

/**
 * The node source-index.ts positions a class's constructor entry at — the
 * explicit `constructor() {}` member when there is one, and otherwise the
 * class's own name identifier, or the class node itself when it is
 * anonymous. Mirrors `extractConstructor`/`extractImplicitConstructor`
 * there; the two must agree, because {@link mapExportsToFunctions}
 * resolves this position against the index's own entries.
 */
function classConstructorNode(
  node: ts.ClassExpression | ts.ClassDeclaration,
): ts.Node {
  const explicit = node.members.find((member) =>
    ts.isConstructorDeclaration(member),
  );
  return explicit ?? node.name ?? node;
}

/**
 * The position of the callable a DECLARATION denotes, as source-index.ts
 * positions its entry, or `undefined` when the declaration denotes no
 * callable this file defines (a parameter, an import, a destructured
 * element, a variable whose initializer is not a function or class value).
 * Task V-3 (ADR 0011 predicate 4): an entrypoint root is materialized by
 * this position, never by a name.
 */
function declaredCallableLocation(
  sourceFile: ts.SourceFile,
  declaration: ts.Node | undefined,
): SourceLocation | undefined {
  if (declaration === undefined) {
    return undefined;
  }
  if (
    ts.isFunctionDeclaration(declaration) ||
    ts.isFunctionExpression(declaration)
  ) {
    return toSourceLocation(sourceFile, declaration);
  }
  if (ts.isClassDeclaration(declaration) || ts.isClassExpression(declaration)) {
    return toSourceLocation(sourceFile, classConstructorNode(declaration));
  }
  if (ts.isVariableDeclaration(declaration) && declaration.initializer) {
    return directValueFunctionLocation(sourceFile, declaration.initializer);
  }
  return undefined;
}

/**
 * What `name` denotes at `reference`, as a root (task V-3): the position of
 * the callable its declaration defines (`callable`), a declaration that
 * provably defines none (`none`: a variable initialized to a literal), or
 * `unknown` -- no single declaration, a name the file assigns anywhere, a
 * parameter, an import, a destructured element, an alias, or a variable
 * whose initializer has not run yet where the reference reads it (`exports.main = run; var run =
 * function () {}` publishes `undefined`). Only module-scope references are
 * asked, so source order is evaluation order.
 */
type DeclaredRoot =
  | { readonly kind: "callable"; readonly location: SourceLocation }
  | { readonly kind: "none" }
  | { readonly kind: "unknown" };

function declaredRootAt(
  sourceFile: ts.SourceFile,
  reference: ts.Node,
  name: string,
): DeclaredRoot {
  const declaration = lexicalDeclarationOf(reference, name);
  if (declaration === undefined) {
    return { kind: "unknown" };
  }
  // A name the file assigns anywhere -- `run = other`, in a loop, in a
  // closure -- does not hold its declaration's value: the declaration is
  // the stale one, and may neither root nor witness (task V-3's second
  // independent audit, finding 1). Over-approximate: a same-named binding
  // assigned in another scope also refuses, which costs precision only.
  if (isNameAssignedWithin(sourceFile, name)) {
    return { kind: "unknown" };
  }
  if (ts.isVariableDeclaration(declaration)) {
    if (
      declaration.getEnd() > reference.getStart(sourceFile) ||
      declaration.initializer === undefined
    ) {
      return { kind: "unknown" };
    }
    const value = unwrapParentheses(declaration.initializer);
    if (!mayBeCallableValue(value)) {
      return { kind: "none" };
    }
  }
  const location = declaredCallableLocation(sourceFile, declaration);
  return location === undefined
    ? { kind: "unknown" }
    : { kind: "callable", location };
}

/**
 * Whether `value` -- the end of an export's alias chain -- is evaluated
 * before the export reads it: written earlier in the file than an export
 * at module scope, or inside the export's own statement (task V-3). An export inside a function body is asked
 * nothing here; its names resolve to nothing anyway.
 */
function evaluatedBeforeExport(
  index: SourceIndex,
  value: ts.Node,
  exp: ExportBinding,
): boolean {
  if (ts.isFunctionDeclaration(value)) {
    // Hoisted: initialized before any statement of its scope runs.
    return true;
  }
  const site = nodeAtLocation(index.sourceFile, exp.location);
  return (
    site !== undefined &&
    value.getSourceFile() === index.sourceFile &&
    // Inside the export's own statement, or before it.
    value.getStart(index.sourceFile) < site.getEnd()
  );
}

/**
 * The OUTERMOST node that begins at `location` -- the export statement,
 * declaration or specifier a binding's location names, never a token
 * inside it (whose scope chain would begin inside a declaration's own
 * function scope). `undefined` when no node begins there.
 */
function nodeAtLocation(
  sourceFile: ts.SourceFile,
  location: SourceLocation,
): ts.Node | undefined {
  if (location.line === undefined || location.column === undefined) {
    return undefined;
  }
  const position = sourceFile.getPositionOfLineAndCharacter(
    location.line - 1,
    location.column - 1,
  );
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) {
      return;
    }
    const start = node.getStart(sourceFile);
    if (start === position) {
      found = node;
    } else if (start < position && position < node.getEnd()) {
      ts.forEachChild(node, visit);
    }
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

/**
 * Whether `node` runs inside a function's body or parameters, or a class
 * element's initializer -- code whose bindings are not the module's, and
 * that may run later or never. A function DECLARATION's own header (its
 * `export` modifier, its name) is not inside it.
 */
function isInsideFunctionBody(node: ts.Node): boolean {
  let child: ts.Node = node;
  for (
    let current = node.parent as ts.Node | undefined;
    current;
    child = current, current = current.parent
  ) {
    if (ts.isFunctionLike(current)) {
      const inBody =
        "body" in current && (current as { body?: ts.Node }).body === child;
      const inParameters = current.parameters.some(
        (parameter) => parameter === child,
      );
      if (inBody || inParameters) {
        return true;
      }
    } else if (
      ts.isClassStaticBlockDeclaration(current) ||
      (ts.isPropertyDeclaration(current) && current.initializer === child)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The name an importer binds `exp` by: `"default"` for a default or
 * whole-module export, the exported name otherwise; `undefined` for an
 * `export *` (task V-3, a `{file, symbol}` entrypoint's selector).
 */
export function canonicalExportName(exp: ExportBinding): string | undefined {
  return exp.kind === "default" ? "default" : exp.exportedName;
}

/**
 * The callable positions an export binding's PROVENANCE names declare at
 * the export's own site (task V-3; PRM-25, PRM-31).
 *
 * Each name is resolved lexically from the site -- the declaration the
 * site's scope chain owns -- so a nested function, a class method or a
 * property function that merely shares the spelling is never one. An
 * export written inside a function body resolves nothing: its names are
 * collected by a whole-file, name-keyed walk that need not agree with the
 * scope the write runs in, so no position is claimed for them and the
 * requirement they would satisfy fails closed.
 */
function provenanceNameLocations(
  index: SourceIndex,
  exp: ExportBinding,
  provenanceNames: readonly string[],
): SourceLocation[] {
  const site = nodeAtLocation(index.sourceFile, exp.location);
  if (site === undefined || isInsideFunctionBody(site)) {
    return [];
  }
  const found: SourceLocation[] = [];
  for (const name of new Set(provenanceNames)) {
    const declared = declaredRootAt(index.sourceFile, site, name);
    const location =
      declared.kind === "callable" ? declared.location : undefined;
    if (
      location !== undefined &&
      !found.some(
        (known) =>
          known.line === location.line && known.column === location.column,
      )
    ) {
      found.push(location);
    }
  }
  return found;
}

/**
 * The positive provenance a CommonJS *property* export
 * (`exports.X = RHS` / `module.exports.X = RHS`) establishes for its own
 * value (RWF-011).
 *
 * Before this, a property export carried NEITHER of these facts, and
 * {@link mapExportsToFunctions} fell back to searching the file for a
 * function whose own name equalled the EXPORTED name. That fallback is
 * unsound in exactly the way this whole relation exists to prevent: the
 * public property name an export is published under is not provenance for
 * any local symbol, so
 *
 * ```js
 * function parse(input) { return "safe:" + input; }   // unrelated decoy
 * const registry = { impl: require("./lib/parse") };
 * exports.parse = registry.impl;                      // the REAL value
 * ```
 *
 * bound `exports.parse` to the decoy, and proving the decoy unreachable
 * produced a complete, correct — and completely wrong-target — Family C
 * NOT_AFFECTED for a vulnerability that is reachable at runtime.
 *
 * Two shapes, both of which the right-hand side itself establishes:
 *
 * - **A bare identifier** (`exports.foo = foo`,
 *   `exports.publicName = internal`, `exports.Klass = Klass`) names a
 *   local symbol explicitly, so it becomes {@link ExportBinding.localName}
 *   — the RHS's OWN text, never the exported name. `exports.publicName =
 *   internal` therefore looks up `internal`, which is both correct and
 *   something the exported-name fallback could never do. RWF-013's
 *   refusal is unaffected and still consulted first, so a reassigned
 *   identifier stays refused rather than becoming newly attributable.
 *
 *   The identifier is read off {@link unwrapValue}'s result rather than
 *   the raw right-hand side (RWF-012), so real `ini@1.3.5`'s
 *   `exports.parse = exports.decode = decode` publishes `parse` under the
 *   local name `decode` — the same name, from the same expression, that
 *   `exports.decode` itself already resolved through. This is still the
 *   RHS's own text: the value of `exports.decode = decode` IS `decode`,
 *   by the language's own rules, so no new name-coincidence surface is
 *   created. The chained assignment is otherwise invisible here — it is
 *   neither an identifier nor a function node, which is exactly why
 *   `parse` carried no provenance at all before.
 * - **A directly-referenced function/class value** becomes
 *   {@link ExportBinding.localFunctionLocation} via
 *   {@link directValueFunctionLocation}, an exact identity. This also
 *   repairs a wrong-target case the name search got silently wrong:
 *   `function foo() {}` alongside `exports.foo = function () {}` indexes
 *   TWO functions named `foo` (source-index.ts names the anonymous one
 *   after the property it is assigned to), and the name search returned
 *   whichever came first in the file — the decoy.
 *
 *   RWF-012 additionally lets that value be reached through a chain of
 *   local aliases (`exports.foo = b`, `const b = a`,
 *   `const a = function () {}`) via
 *   {@link chasedValueFunctionLocation}. Every hop carries the same
 *   module-scope single-assignment proof the one-hop form always did, and
 *   the result is still an exact function-node position — never a name
 *   match.
 *
 * Gated on the assignment being an unconditional module-scope statement,
 * for the same reason {@link directExportedFunctionLocation} is: this
 * module has no control-flow semantics, and
 * `commonJsPropertyExportRhs`'s last-write-wins map picks the last
 * assignment in SOURCE order. Binding a right-hand side that sits inside
 * an `if`/`try`/loop/function body would be choosing a branch
 * arbitrarily, which is the same manufactured certainty in a different
 * shape.
 */
function propertyExportProvenance(
  index: SourceIndex,
  rhs: ts.Expression | undefined,
): Pick<
  ExportBinding,
  "localName" | "localFunctionLocation" | "exportAttributionWithdrawn"
> {
  if (rhs === undefined) {
    return {};
  }
  if (!isDefinitelyReachedExportAssignment(rhs)) {
    // A right-hand side EXISTS but this file cannot prove the write runs,
    // so no provenance is published — the same refusal
    // {@link ambiguousWholeModuleExport} makes for the whole-module form,
    // and it must be marked for the same reason (RWF-021). Without the
    // marker, root selection cannot tell this apart from a property export
    // that genuinely names no callable, and dropping the root reproduces
    // the false NOT_AFFECTED for `exports.run = main` exactly as it did
    // for `module.exports = main`.
    return { exportAttributionWithdrawn: true };
  }
  const value = unwrapValue(rhs);
  return {
    localName: ts.isIdentifier(value) ? value.text : undefined,
    localFunctionLocation:
      directValueFunctionLocation(index.sourceFile, value) ??
      chasedValueFunctionLocation(index, value),
  };
}

/**
 * {@link directValueFunctionLocation} applied to the far end of an alias
 * chain rather than to the expression itself — RWF-012's function-identity
 * half.
 *
 * ```js
 * const impl = function () {};
 * const a = impl;
 * const b = a;
 * exports.parse = b;   // -> that FunctionExpression's own position
 * ```
 *
 * Only a `"value"` chain answers: `"refused"` (a reassigned hop, a cycle,
 * a rejected binding) and `"unmodeled"` (a `function` declaration, an
 * import, a free name) both leave the export exactly as unattributed as
 * before, which is an unresolved target and therefore UNKNOWN — never a
 * verdict. See {@link resolveLocalValue} for the per-hop obligation.
 *
 * Gated on {@link declaresCommonJsAmbientShadow} because it is the chase
 * over LOCAL bindings that this guard protects (RWF-004a): in a file that
 * declares its own `module`/`exports`/`require`, a module-scope binding is
 * not the ambient-CommonJS fact the chase assumes it is. The guard is
 * applied only to the chased path — a directly-referenced function value
 * needs no chase and keeps the behaviour it had before RWF-012.
 */
function chasedValueFunctionLocation(
  index: SourceIndex,
  value: ts.Expression,
): SourceLocation | undefined {
  if (!ts.isIdentifier(value) || declaresCommonJsAmbientShadow(index)) {
    return undefined;
  }
  const resolved = resolveLocalValue(index, value);
  return resolved.kind === "value"
    ? directValueFunctionLocation(index.sourceFile, resolved.value)
    : undefined;
}

/**
 * {@link isDefinitelyReachedModuleScopeStatement} for an export
 * assignment's right-hand side — `exports.X = rhs`, `module.exports = rhs`
 * — climbing out through CHAINED assignments first.
 *
 * `exports.parse = exports.decode = decode` (real ini, and a staple
 * CommonJS idiom for publishing one function under two names) parses as
 * `exports.parse = (exports.decode = decode)`, so the inner assignment's
 * enclosing node is the outer ASSIGNMENT, not the statement. Asking about
 * it directly reports "not module scope" and refuses a binding whose
 * provenance is in fact perfect: the whole chain is one unconditional
 * top-level statement, and `decode` is a bare identifier naming a local
 * function. Real `debug@2.0.0`'s `node.js` opens with the same idiom for
 * the whole-module form (`exports = module.exports = require('./debug')`).
 *
 * Only assignment links are climbed, and only from the right-hand side —
 * exactly the positions whose value IS the value being assigned. Anything
 * else between the assignment and the source file (an `if`, a `try`, a
 * function body, a comma expression) still means the assignment may not
 * run, and still refuses.
 *
 * This is the ONE test every export-provenance fact is gated on, because
 * every one of them reads a LAST-WRITE-WINS map keyed by source order
 * (`commonJsPropertyExportRhs`, `findLastModuleExportsAssignment`,
 * commonjs-reexports.ts's own `propertyRhsByName`). Last-write-wins is
 * Node's real semantics for straight-line module-scope code and nothing
 * else: for
 *
 * ```js
 * if (cond) { exports.parse = require("pkg-a").parse; }
 * else      { exports.parse = require("pkg-b").parse; }
 * ```
 *
 * the map keeps only `pkg-b`, so a fact derived from it silently asserts
 * that `pkg-a`'s function is NOT what this export holds — a branch chosen
 * arbitrarily, presented as certainty. That is a false NOT_AFFECTED
 * whenever `pkg-a` is the finding's own package: its target resolves to a
 * real node that nothing then points at, and Family C proves it
 * unreachable with `reachableSubgraphComplete: true` (reproduced directly;
 * see the RWF-004b conditional-branch regressions). This module has no
 * control-flow semantics and must not pretend to.
 *
 * Note this deliberately does NOT make `exports.parse` itself
 * attributable: its own right-hand side is the inner assignment
 * expression, not an identifier or a function node, so
 * {@link propertyExportProvenance} finds nothing to bind and the export
 * stays unresolved. Resolving THROUGH an assignment expression's value is
 * a separate relation and is not attempted here.
 */
function isDefinitelyReachedExportAssignment(rhs: ts.Expression): boolean {
  const node = exportAssignmentStatementNode(rhs);
  return (
    node !== undefined &&
    isDefinitelyReachedModuleScopeStatement(node) &&
    competingWritesCannotBeObservedApart(rhs)
  );
}

/**
 * {@link isDefinitelyReachedExportAssignment} minus its reachability half
 * (RWF-015): whether the assignment is written as a top-level statement at
 * all, regardless of whether module evaluation can still be running by the
 * time that statement is reached.
 *
 * The two differ for exactly the shape RWF-015 exists for, and the
 * difference is what {@link WholeModuleExportAuthority} reports as
 * `"bypassable"` rather than silently folding into `"conditional"` —
 * "written at top level, but an earlier top-level statement can end module
 * evaluation first" is a different fact about the file than "written
 * inside an `if`", and an analyzer whose refusals are read by humans
 * should say which one it saw.
 */
function isTopLevelExportAssignment(rhs: ts.Expression): boolean {
  const node = exportAssignmentStatementNode(rhs);
  return node !== undefined && isUnconditionalModuleScopeStatement(node);
}

/**
 * The node whose STATEMENT position decides when an export assignment
 * runs: the assignment itself, or — for a chained
 * `exports.a = exports.b = value` — the outermost assignment it is the
 * right-hand side of. See {@link isDefinitelyReachedExportAssignment}'s
 * doc comment for why the climb exists and why only assignment links are
 * climbed.
 */
function exportAssignmentStatementNode(
  rhs: ts.Expression,
): ts.Node | undefined {
  let node: ts.Node | undefined = rhs.parent;
  if (node === undefined) {
    return undefined;
  }
  let parent = node.parent as ts.Node | undefined;
  while (
    parent !== undefined &&
    ts.isBinaryExpression(parent) &&
    parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
    parent.right === node
  ) {
    node = parent;
    parent = node.parent as ts.Node | undefined;
  }
  return node;
}

/** Whether `node`'s own statement is a direct child of the source file (module scope, unconditional). */
function isUnconditionalModuleScopeStatement(node: ts.Node): boolean {
  const parent = node.parent as ts.Node | undefined;
  if (!parent) {
    return false;
  }
  if (ts.isSourceFile(parent)) {
    // `export = X;` — an ExportAssignment is itself a statement.
    return true;
  }
  return (
    ts.isExpressionStatement(parent) &&
    parent.parent !== undefined &&
    ts.isSourceFile(parent.parent)
  );
}

/**
 * {@link isUnconditionalModuleScopeStatement} PLUS the thing being a
 * top-level statement does not by itself establish (RWF-015): that module
 * evaluation actually gets this far.
 *
 * Node wraps every CommonJS module in a function, so a module-scope
 * `return` is legal and ends module evaluation on the spot; an uncaught
 * module-scope `throw` ends it too, propagating out of the `require()`
 * that triggered the load. Either one leaves whatever `module.exports`
 * already held as the module's exported value, and leaves every top-level
 * statement below it unexecuted:
 *
 * ```js
 * if (flag) {
 *   module.exports = dangerousOp;
 *   return;
 * }
 * module.exports = safeOp;      // <- syntactically unconditional; NOT always run
 * ```
 *
 * The final write here is a direct child of the source file, so
 * {@link isUnconditionalModuleScopeStatement} accepts it and RWF-014's
 * authority rule ("the last write must be unconditional") accepted it too
 * — and the module then exported `dangerousOp` on every run with the flag
 * set. Reproduced end to end on the commit before this one, as a
 * NOT_AFFECTED carrying a complete Family C proof over a function the
 * module exports whenever the early branch is taken; see
 * fixtures/commonjs-early-exit-whole-module-export/.
 *
 * So the property every export-provenance gate actually needs is not "is
 * this statement unconditional" but "is this statement DEFINITELY
 * REACHED", and the two come apart exactly when some earlier top-level
 * statement can complete abruptly. {@link firstModuleEvaluationCutoff}
 * finds the first such statement in one linear pass; everything starting
 * before it definitely runs (module evaluation executes top-level
 * statements in order, and nothing above it can abort), and everything
 * from it onward may not. That comparison is the whole reachability
 * model: no control-flow graph, no path enumeration, no dataflow, and no
 * evaluation of the flag.
 */
function isDefinitelyReachedModuleScopeStatement(node: ts.Node): boolean {
  if (!isUnconditionalModuleScopeStatement(node)) {
    return false;
  }
  const sourceFile = node.getSourceFile();
  const cutoff = firstModuleEvaluationCutoff(sourceFile);
  return cutoff === undefined || node.getStart(sourceFile) < cutoff;
}

/**
 * Whether a resolved export value could be a callable at runtime (P0-Z
 * round 3).
 *
 * Deliberately a NEGATIVE test: everything is assumed callable-capable
 * unless it is one of the few literal forms that provably is not. Getting
 * this wrong in the permissive direction costs an UNKNOWN; getting it
 * wrong in the restrictive direction costs a false NOT_AFFECTED, because
 * a binding wrongly classified "not callable" emits no requirement and
 * its unmaterialized root goes unnoticed.
 */
function mayBeCallableValue(value: ts.Expression): boolean {
  return !(
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isStringLiteralLike(value) ||
    ts.isRegularExpressionLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(value) && value.text === "undefined")
  );
}

export {
  isDirectFunctionValue,
  directValueFunctionLocation,
  classConstructorNode,
  declaredCallableLocation,
  declaredRootAt,
  evaluatedBeforeExport,
  nodeAtLocation,
  isInsideFunctionBody,
  provenanceNameLocations,
  propertyExportProvenance,
  isDefinitelyReachedExportAssignment,
  isTopLevelExportAssignment,
  isUnconditionalModuleScopeStatement,
  mayBeCallableValue,
};
export type { WholeModuleExportAuthority, ModuleExportsAssignment };
