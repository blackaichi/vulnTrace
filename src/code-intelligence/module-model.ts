import ts from "typescript";
import type { SourceLocation } from "../domain/graph.js";
import {
  commonJsModuleReExportOrigin,
  commonJsPropertyExportRhs,
  commonJsPropertyReExportOrigin,
  declaresCommonJsAmbientShadow,
  refusesLocalIdentifierProvenance,
  resolveCommonJsReExportExpression,
  resolveLocalValue,
  unwrapParentheses,
  unwrapValue,
  type CommonJsReExportOrigin,
} from "./commonjs-reexports.js";
import {
  type IndexedExport,
  type IndexedFunction,
  type SourceIndex,
  toSourceLocation,
} from "./source-index.js";

export type ModuleSyntax = "esm" | "commonjs";

/**
 * A binding's semantic shape, unified across ESM and CommonJS so downstream
 * consumers (TASK-016 Module Resolution, TASK-017 Symbol Binding) can treat
 * `import foo from "x"` and `const foo = require("x")` identically — both
 * bind the whole module to one local name — while still knowing which
 * syntax produced it via {@link ModuleSyntax} (see docs/SDD.md § 17's
 * convergence examples).
 */
export type BindingKind = "default" | "named" | "namespace" | "side-effect";

export interface ImportBinding {
  readonly specifier: string;
  readonly kind: BindingKind;
  readonly syntax: ModuleSyntax;
  readonly localName?: string;
  /** The original exported name, when it differs from `localName` (aliasing). */
  readonly importedName?: string;
  readonly location: SourceLocation;
}

export type ExportKind = "named" | "default" | "namespace" | "re-export";

export interface ExportBinding {
  readonly kind: ExportKind;
  readonly syntax: ModuleSyntax;
  readonly exportedName?: string;
  readonly localName?: string;
  /** The source module, for re-exports (`export { a } from "./x"`). */
  readonly specifier?: string;
  /**
   * For a CommonJS export whose value came from a `require()` of another
   * module (RWF-004a/RWF-004b): where that value originates. `undefined`
   * for every export defined locally, and for every CommonJS export whose
   * right-hand side has no single statically-known origin (a dynamic
   * specifier, a chained alias) — see {@link CommonJsReExportOrigin} and
   * commonjs-reexports.ts.
   *
   * Also `undefined` for an export assignment this file cannot prove runs
   * unconditionally, once, at module scope — see
   * {@link isDefinitelyReachedExportAssignment}, whose doc comment carries the
   * reasoning and the false NOT_AFFECTED it prevents. Every provenance
   * field on this interface is gated on that same test, for the same
   * reason: they all read a last-write-wins map.
   *
   * Deliberately separate from {@link specifier}, which carries the ESM
   * `export { a } from "./x"` form: the two are different syntaxes read
   * out of different AST shapes, and each is resolved by its own relation
   * in call-graph.ts's `resolveReExportChain`. Both now reach across
   * package boundaries (RWF-004b), each landing on whatever installed
   * instance Node's own resolution of its specifier reaches from the file
   * that spells it.
   */
  readonly commonJsReExport?: CommonJsReExportOrigin;
  /**
   * The exact source position of the function-like expression this binding's
   * exported value IS, when the export assignment structurally *references*
   * one (RWF-003; see docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 5's R-3,
   * tests/validation/FINDINGS.md RWF-003).
   *
   * This is the export's CONCRETE FUNCTION IDENTITY, deliberately kept
   * separate from {@link localName}, which is a *name* the export can be
   * looked up by. The two answer different questions and neither implies
   * the other:
   *
   * - `module.exports = function () {}` has an identity but NO name — the
   *   whole point of RWF-003. Before this field existed the export was
   *   simply unattributable, because the only mechanism available was a
   *   name lookup and there was no name to look up.
   * - `module.exports = function internalName() {}` has both, and they
   *   disagree about what they mean: `internalName` is the function's own
   *   INTERNAL name, not the public binding an importer sees (which is the
   *   canonical `"default"`). Matching on it happens to work, but only
   *   because no other function in the file shares that text.
   *
   * A position is not a guess and cannot collide: exactly one AST node
   * begins at a given offset in a file, and source-index.ts records every
   * function-like node under that same position (see `extractFunction`'s
   * `toSourceLocation`). So `mapExportsToFunctions` resolving through this
   * field is an identity, where resolving through {@link localName} is a
   * same-file name search that can land on a different function that
   * merely shares the text.
   *
   * `undefined` whenever the exported value is not a directly-referenced
   * function — including every shape this deliberately refuses to guess at:
   * a conditionally-assigned export, a file that shadows the CommonJS
   * ambient names, an alias chain longer than one hop, and any value that
   * is not statically a function at all. See
   * {@link directExportedFunctionLocation}.
   */
  readonly localFunctionLocation?: SourceLocation;
  /**
   * Whether this export's value is an identifier whose same-file binding
   * the local-provenance model EXAMINED AND REFUSED (RWF-013, widened by
   * RWF-013b; see `classifyLocalBinding` in commonjs-reexports.ts).
   *
   * Purely internal analysis state: never serialized, never surfaced in
   * evidence, and read by exactly one consumer —
   * {@link mapExportsToFunctions}, which must not fall back to a
   * name-only function search for such an export.
   *
   * This exists because {@link localFunctionLocation} being `undefined`
   * is NOT sufficient to decide that question, and treating it as if it
   * were is what made the defect look fixable without a new field.
   * `undefined` there is the answer for every export RWF-003's identity
   * relation does not model at all, most of which the older name-based
   * attribution handles perfectly well and soundly:
   *
   * ```text
   * function fn() {}          module.exports = fn   -- an un-reassigned function
   *                                                    DECLARATION, still bound by name
   * const C = class {};       module.exports = C    -- a class, attributed by
   *                                                    name via its constructor
   * exports.foo = function () {}                    -- a property export, which
   *                                                    this relation never covered
   * ```
   *
   * Suppressing the fallback on `undefined` alone would silently drop all
   * of those. So the two facts are carried separately: a *location* says
   * "the export IS this function node", and this flag says "the file's own
   * text contradicts any claim about what this name holds". Only the
   * second one is grounds for refusing to guess.
   *
   * The refused shapes, and what each one taught:
   *
   * ```js
   * let fn = function () {};   // RWF-013: indexed under the name "fn"
   * fn = other;                // ...and immediately stale
   * module.exports = fn;       // binds "fn" -> the STALE node, by name
   *
   * function fn() {}           // RWF-013b: the SAME defect, and the
   * fn = other;                // declaration form is irrelevant to it --
   * module.exports = fn;       // JavaScript reassigns this just as freely
   * ```
   *
   * The second shape is why the underlying question is "does this file
   * write to this name?", asked before and independently of "how was this
   * name declared?". Restricting the refusal to variable bindings left
   * reassigned `function`/`class` declarations attributing their stale
   * node, which reproduced a false NOT_AFFECTED carrying a complete
   * Family C proof.
   *
   * Deliberately independent of the module-scope and ambient-shadow
   * guards that gate {@link localFunctionLocation}: a conditional
   * assignment or a file that shadows `module`/`exports`/`require` has
   * strictly LESS provenance for the same identifier, never more.
   */
  readonly localIdentifierProvenanceRefused?: boolean;
  readonly location: SourceLocation;
}

/**
 * The unified import/export model for one module (see docs/SDD.md § 15-17).
 * Built from a {@link SourceIndex} (TASK-014) rather than re-parsing:
 * TASK-014 extracts per-syntax-construct facts; this normalizes them into
 * one shape regardless of which syntax was used.
 */
export interface ModuleModel {
  readonly filePath: string;
  readonly imports: readonly ImportBinding[];
  readonly exports: readonly ExportBinding[];
}

function toImportBinding(imp: SourceIndex["imports"][number]): ImportBinding {
  if (imp.bindingKind === "commonjs") {
    const kind: BindingKind = imp.importedName
      ? "named"
      : imp.localName
        ? "default"
        : "side-effect";
    return {
      specifier: imp.specifier,
      kind,
      syntax: "commonjs",
      localName: imp.localName,
      importedName: imp.importedName,
      location: imp.location,
    };
  }

  return {
    specifier: imp.specifier,
    kind: imp.bindingKind,
    syntax: "esm",
    localName: imp.localName,
    importedName: imp.importedName,
    location: imp.location,
  };
}

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
): Pick<ExportBinding, "localName" | "localFunctionLocation"> {
  if (rhs === undefined || !isDefinitelyReachedExportAssignment(rhs)) {
    return {};
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
  return node !== undefined && isDefinitelyReachedModuleScopeStatement(node);
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
 * Memoizes {@link firstModuleEvaluationCutoff} per source file. Keyed on
 * the `ts.SourceFile` node itself and weakly held, so the entry dies with
 * the AST it describes and a re-parse of the same path never reads a stale
 * answer. The wrapper object distinguishes "computed, and the answer is
 * `undefined`" (the common case — most files contain no top-level abrupt
 * completion at all) from "not yet computed".
 */
const moduleEvaluationCutoffs = new WeakMap<
  ts.SourceFile,
  { readonly start: number | undefined }
>();

/**
 * The start position of the FIRST top-level statement of `sourceFile` that
 * can end module evaluation before the statement after it begins, or
 * `undefined` when no top-level statement can (RWF-015).
 *
 * Only the first one is needed. Module evaluation runs top-level
 * statements in order, so this position partitions the file: a top-level
 * statement starting before it is reached on every load, and one starting
 * at or after it is reached only on the loads where nothing above it
 * completed abruptly. That is exactly the question
 * {@link isDefinitelyReachedModuleScopeStatement} asks, and answering it
 * with one number rather than a per-statement predicate is what keeps the
 * whole model a single comparison.
 *
 * Deliberately NOT computed over the whole file: it walks each top-level
 * statement's subtree only until it finds an abrupt completion, and stops
 * at the first statement that has one — so it is linear in the file at
 * worst and usually reads much less.
 */
function firstModuleEvaluationCutoff(
  sourceFile: ts.SourceFile,
): number | undefined {
  const cached = moduleEvaluationCutoffs.get(sourceFile);
  if (cached !== undefined) {
    return cached.start;
  }

  const scanExpressions = mayContainClassDefinitionTimeEvaluation(sourceFile);
  let start: number | undefined;
  for (const statement of sourceFile.statements) {
    if (mayEndModuleEvaluation(statement, scanExpressions)) {
      start = statement.getStart(sourceFile);
      break;
    }
  }

  moduleEvaluationCutoffs.set(sourceFile, { start });
  return start;
}

/**
 * Whether evaluating this one top-level statement can end module
 * evaluation rather than falling through to the next statement (RWF-015;
 * widened by RWF-016, RWF-017, RWF-018, RWF-019 and RWF-020).
 *
 * Three constructs qualify — all of them ABRUPT COMPLETIONS, and the third
 * only when {@link isDefinitelyAbruptCallStatement},
 * {@link isDefinitelyAbruptStaticFieldInitializer},
 * {@link isDefinitelyAbruptComputedClassElementKey} or
 * {@link isDefinitelyAbruptClassHeritage} has PROVEN it is one,
 * never merely suspected it might be:
 *
 * - **`return`** — legal at CommonJS module scope because Node evaluates
 *   the module inside a wrapper function, and ends module evaluation
 *   wherever it appears. A `return` reached by this walk is necessarily a
 *   module-scope one: `return` is a syntax error anywhere but a function
 *   body, and function bodies are not walked into.
 * - **`throw`** whose exception is not caught inside this same statement.
 *   An uncaught module-scope throw propagates out of the `require()` that
 *   started the load, so nothing below it runs either.
 * - **a call to `bail()`** whose callee this file's own text proves is
 *   an exact, non-reassigned local function/arrow that can only ever
 *   itself throw (RWF-016; see {@link isDefinitelyAbruptCallStatement}) —
 *   written either as a bare statement (`bail();`, RWF-016), as a
 *   variable declaration's initializer (`const x = bail();`, RWF-017,
 *   which the language evaluates when the declaration executes), or as a
 *   class STATIC FIELD's initializer (`class C { static x = bail(); }`,
 *   RWF-018, which the language evaluates when the class DEFINITION
 *   executes — see {@link isDefinitelyAbruptStaticFieldInitializer}), or
 *   as any class element's COMPUTED KEY (`class C { [bail()] = 1; }`,
 *   `class C { [bail()]() {} }`, RWF-019, which the language likewise
 *   evaluates when the class DEFINITION executes, for static and instance
 *   elements alike — see
 *   {@link isDefinitelyAbruptComputedClassElementKey}), or as a class's
 *   `extends` HERITAGE expression (`class C extends bail() {}`, RWF-020,
 *   which ClassDefinitionEvaluation evaluates FIRST, before any element
 *   exists — see {@link isDefinitelyAbruptClassHeritage}). Such
 *   a call is exactly as terminal as the literal `throw` inside `bail`'s
 *   body would be if inlined at the call site, and is caught by an
 *   enclosing `try`/`catch` under the identical rule
 *   {@link isCaughtWithin} already applies to a literal `throw`.
 *
 * What is deliberately NOT modeled, because the answer would need
 * semantics this relation does not have:
 *
 * - **`process.exit()`, `assert(...)`, or any other call whose callee is
 *   not an exact local definitely-abrupt function.** Whether a call
 *   returns is a property of the function it reaches, not of the call
 *   syntax in general. Treating an arbitrary call as a possible terminator
 *   would make almost every real module's exports unattributable and would
 *   still be a guess; RWF-016's exception is narrow by construction
 *   because it is not a guess — see {@link cannotCompleteNormally}.
 * - **`break` / `continue`.** These transfer control WITHIN the enclosing
 *   loop, switch or labeled statement — which, for a top-level `break`,
 *   is inside this same statement. Execution continues with the next
 *   top-level statement either way, so they are not module-terminating and
 *   are not treated as such. (Outside a loop/switch/label they are a
 *   syntax error, so there is no third case.)
 *
 * The walk stops at every function-like node — function and method bodies,
 * arrow bodies, accessors — because a `return`/`throw` inside one belongs
 * to THAT function's execution, which may be an importer calling it long
 * after this module finished loading, or may never happen at all:
 *
 * ```js
 * function configure() { throw new Error("not configured"); }
 * module.exports = b;   // still definitely reached; `configure` has not run
 * ```
 *
 * Class bodies are NOT skipped, for the symmetric reason: a
 * `static { ... }` block, a `static x = ...` FIELD INITIALIZER, any
 * element's COMPUTED KEY and the class's own `extends` HERITAGE
 * expression all run at class-definition time, i.e. during
 * module evaluation, so an abrupt completion in any of them really can
 * abort the load (RWF-018, RWF-019, RWF-020). Method and accessor BODIES inside
 * that same class body are skipped by the function-like test, as they
 * should be — but their computed KEYS are not, which is why
 * {@link isDefinitelyAbruptComputedClassElementKey} is asked before that
 * test rather than after it. And so — for the opposite reason — the
 * per-instance execution of an INSTANCE field initializer is skipped,
 * which {@link isDefinitelyAbruptStaticFieldInitializer} declines to act
 * on even though that same element's computed key is acted on.
 *
 * An IIFE is skipped along with every other function expression. That is
 * the conservative direction here rather than the risky one: skipping it
 * can only make this relation report FEWER cutoffs, so the worst case is
 * a bypassable write treated as definitely reached — which is precisely
 * the unsound direction. It is accepted deliberately and narrowly: a
 * `throw` inside an IIFE does abort module evaluation, but an IIFE's
 * `return` does not, and telling the two apart means proving the function
 * expression is invoked immediately — call-graph work, and the same line
 * {@link classifyWholeModuleExportAuthority} already draws by classifying
 * an IIFE-nested write as `"deferred"`. A module that guards its exports
 * with a throwing IIFE and then rewrites `module.exports` below it is not
 * a shape this analyzer claims to model; see RWF-015's remaining-limitations
 * note in tests/validation/FINDINGS.md.
 */
function mayEndModuleEvaluation(
  statement: ts.Statement,
  scanExpressions: boolean,
): boolean {
  let found = false;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }
    // Asked BEFORE the function-like stop below, and that order is the
    // whole point: a computed METHOD/ACCESSOR key (`[bail()]() {}`) hangs
    // off a node that IS function-like, so testing it after the stop would
    // never see it. The stop still applies to the element's BODY, which is
    // what it is for — see {@link isDefinitelyAbruptComputedClassElementKey}.
    if (
      isDefinitelyAbruptComputedClassElementKey(node) &&
      !isCaughtWithin(node, statement)
    ) {
      found = true;
      return;
    }
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (
      ts.isReturnStatement(node) ||
      (ts.isThrowStatement(node) && !isCaughtWithin(node, statement)) ||
      ((isDefinitelyAbruptCallStatement(node) ||
        isDefinitelyAbruptStaticFieldInitializer(node) ||
        isDefinitelyAbruptClassHeritage(node)) &&
        !isCaughtWithin(node, statement))
    ) {
      found = true;
      return;
    }
    if (scanExpressions || mayContainNestedStatements(node)) {
      ts.forEachChild(node, visit);
    }
  }

  visit(statement);
  return found;
}

/**
 * Whether `node` is one of the constructs that can hold STATEMENTS — the
 * only places a `return`/`throw` can be, once function bodies are excluded
 * (RWF-015).
 *
 * This is what keeps {@link firstModuleEvaluationCutoff} off the hot path
 * of large files. `return` and `throw` are statements, and a statement can
 * only appear in a statement position: a block, an `if` arm, a loop or
 * `with` body, a `switch` clause, a `try`/`catch`/`finally` block, or a
 * labeled statement. It can never appear inside an EXPRESSION — with two
 * exceptions, and both are handled elsewhere: a function body (skipped
 * deliberately, see {@link mayEndModuleEvaluation}) and a class `static`
 * block (the reason for the `scanExpressions` escape hatch, since a class
 * EXPRESSION can sit anywhere an expression can).
 *
 * So descending only through these is not an approximation — it reaches
 * every node that could hold the thing being looked for, and skips the
 * expression trees that make up the bulk of a real file. On the
 * scan-performance suite's single-file fixture (9,001 top-level
 * statements, nearly all of them object literals and call expressions)
 * walking expressions too cost ~190ms per module model, multiplied by
 * every model a scan builds; this walk is a per-statement kind check.
 */
function mayContainNestedStatements(node: ts.Node): boolean {
  return (
    ts.isBlock(node) ||
    ts.isIfStatement(node) ||
    ts.isIterationStatement(node, false) ||
    ts.isSwitchStatement(node) ||
    ts.isCaseBlock(node) ||
    ts.isCaseClause(node) ||
    ts.isDefaultClause(node) ||
    ts.isTryStatement(node) ||
    ts.isCatchClause(node) ||
    ts.isLabeledStatement(node) ||
    ts.isWithStatement(node)
  );
}

/**
 * Whether this file could contain a class element that EXECUTES at
 * class-definition time — a `static { ... }` block (RWF-015) or a
 * `static x = ...` field initializer (RWF-018) — and therefore needs
 * {@link mayEndModuleEvaluation}'s full expression walk to be classified
 * correctly.
 *
 * Those two are the only constructs that run code inside an EXPRESSION
 * without a function body around them: a static block is the only place a
 * statement can sit there, and a static field initializer the only place
 * an expression is evaluated there. Neither can exist unless the token
 * `static` appears in the file, so the same one-line text test gates both.
 * It is a sound over-approximation: a `static` in a comment, a string, or
 * an ordinary static METHOD modifier costs that one file the fast walk and
 * changes no answer, while a file containing no `static` at all provably
 * has neither — which makes the cheap statement-position walk exactly
 * complete rather than merely close.
 */
function mayContainClassStaticEvaluation(sourceFile: ts.SourceFile): boolean {
  return /\bstatic\b/.test(sourceFile.text);
}

/**
 * Whether this file could contain ANY construct that executes at
 * class-definition time — the gate {@link firstModuleEvaluationCutoff}
 * uses, widened from {@link mayContainClassStaticEvaluation} by RWF-019.
 *
 * RWF-015/018's `static` test was complete for the two constructs known
 * then (a `static { ... }` block and a `static x = ...` field
 * initializer), because neither can be written without that token.
 * RWF-019 adds a third, and it has no `static` in it at all:
 *
 * ```js
 * class C { [bail()] = 1; }   // computed KEY -- runs at class-definition time
 * ```
 *
 * RWF-020 adds a fourth, the class's own `extends` expression, which has
 * no `static` in it either:
 *
 * ```js
 * class C extends bail() {}   // heritage -- runs at class-definition time
 * ```
 *
 * All four do share the `class` keyword, though — there is no other way
 * to write a class in the language — so one token still gates all of them,
 * and `class` is the token that actually names the construct doing the
 * executing. It stays a sound over-approximation in the same way the
 * narrower test was: a `class` in a comment or a string costs that one
 * file the full expression walk and changes no answer, while a file
 * containing no `class` at all provably has no class-definition-time
 * evaluation to find, which keeps the cheap statement-position walk
 * exactly complete rather than merely close.
 *
 * Deliberately NOT shared with {@link reassignedModuleReachableNames},
 * which keeps the narrower `static` gate. Widening a walk that looks for
 * ABRUPT COMPLETIONS can only find more cutoffs, i.e. refuse more exports
 * — the safe direction. Widening the walk that looks for REASSIGNMENTS
 * runs the other way: a name it newly marks as reassigned makes
 * {@link resolveExactLocalCallable} refuse a callee and REMOVES a cutoff,
 * which would turn a refused export into an attributed one. RWF-019 is a
 * soundness fix and takes no movement in that direction, so the two gates
 * are separate on purpose.
 */
function mayContainClassDefinitionTimeEvaluation(
  sourceFile: ts.SourceFile,
): boolean {
  return /\bclass\b/.test(sourceFile.text);
}

/**
 * Whether `node`'s abrupt completion is caught by a `try`/`catch` lying
 * between it and `boundary` (RWF-015; widened by RWF-016) — the one piece
 * of real control-flow semantics this model needs, and the reason a file
 * that merely CONTAINS a `throw` does not lose its exports:
 *
 * ```js
 * try { if (flag) { throw err; } } catch { }
 * module.exports = b;   // still definitely reached -- the throw is handled
 * ```
 *
 * A `throw` counts as caught only when an enclosing `try` has a `catch`
 * clause AND the throw is inside that `try`'s own block. Both halves
 * matter and both are the conservative reading:
 *
 * - a `try { ... } finally { ... }` with no `catch` does not stop the
 *   exception, so a throw inside it still ends module evaluation;
 * - a throw inside a CATCH or FINALLY clause is not caught by its own
 *   `try` — `catch (e) { throw e; }` rethrows, and the rethrow ends module
 *   evaluation exactly as the original would have.
 *
 * Both of those keep working when nested, because the walk continues
 * outward: a rethrow inside an inner `catch` that itself sits in an outer
 * `try`'s block is caught by the outer one, and reported as caught.
 *
 * `boundary` is the top-level statement being classified. There is never a
 * `try` above it — a `try` spanning several statements IS a single
 * top-level `TryStatement`, and its contents are walked as part of it — so
 * the boundary is a stop condition rather than a semantic limit.
 *
 * `node` was a `ts.ThrowStatement` for every RWF-015 call site; RWF-016
 * widens the parameter to `ts.Node` so the exact same ancestry walk can
 * also answer the question for a definitely-abrupt CALL statement (e.g.
 * `bail();`), which propagates its callee's abrupt completion out to
 * whichever `try` (if any) encloses the call, exactly as a literal `throw`
 * would. The walk itself only ever inspects `node.parent`, so it is
 * correct for either input unchanged.
 */
function isCaughtWithin(node: ts.Node, boundary: ts.Statement): boolean {
  let child: ts.Node = node;
  let parent: ts.Node | undefined = node.parent as ts.Node | undefined;

  while (parent !== undefined) {
    if (
      ts.isTryStatement(parent) &&
      parent.catchClause !== undefined &&
      parent.tryBlock === child
    ) {
      return true;
    }
    if (parent === boundary) {
      return false;
    }
    child = parent;
    parent = parent.parent as ts.Node | undefined;
  }

  return false;
}

/**
 * Whether an operator token assigns to its left-hand side (`=`, `+=`,
 * `??=`, ...). Local copy of the same test commonjs-reexports.ts's
 * `collectFacts` uses, kept independent rather than exported/shared: this
 * relation and that one answer different questions and coupling their
 * implementations would make either one harder to change without risking
 * the other.
 */
function isAssignmentOperatorToken(kind: ts.SyntaxKind): boolean {
  return (
    kind >= ts.SyntaxKind.FirstAssignment &&
    kind <= ts.SyntaxKind.LastAssignment
  );
}

/** Every identifier a binding name introduces, however nested (`{ a, b: [c] }`). */
function bindingNameIncludes(name: ts.BindingName, target: string): boolean {
  if (ts.isIdentifier(name)) {
    return name.text === target;
  }
  for (const element of name.elements) {
    if (
      ts.isBindingElement(element) &&
      bindingNameIncludes(element.name, target)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether `list` declares `name`, through any binding pattern. */
function declarationListDeclares(
  list: ts.VariableDeclarationList,
  name: string,
): boolean {
  for (const decl of list.declarations) {
    if (bindingNameIncludes(decl.name, name)) {
      return true;
    }
  }
  return false;
}

/** Marks every identifier `target` assigns to, however nested (`[a] = ...`, `({ b } = ...)`). Property mutation (`x.y = ...`) is excluded: it changes the object, not the binding. */
function markLocallyReassigned(target: ts.Node, into: Set<string>): void {
  if (ts.isIdentifier(target)) {
    into.add(target.text);
    return;
  }
  if (ts.isPropertyAccessExpression(target)) {
    return;
  }
  ts.forEachChild(target, (child) => markLocallyReassigned(child, into));
}

/**
 * Every name reassigned (`name = ...`, `name += ...`, `++name`, a
 * destructuring assignment target, a `for..of`/`for..in` loop variable)
 * ANYWHERE within the region module evaluation can reach WITHOUT calling
 * into a function (RWF-016) — the exact same reach model
 * {@link mayEndModuleEvaluation} already uses (a `return`/`throw`
 * anywhere in this same region ends module evaluation; a reassignment
 * anywhere in it can run before a later call), for the identical reason:
 * a reassignment that only runs if some OTHER function is called first is
 * not something this relation reasons about, exactly as it does not
 * reason about a THROW inside one (see {@link mayEndModuleEvaluation}'s
 * own doc comment) or about a transitive call chain (RWF-016's own
 * remaining-limitations note in tests/validation/FINDINGS.md). Missing
 * such a reassignment only ever makes this relation MORE conservative —
 * it may still treat a callee as definitely abrupt when a deferred
 * reassignment would in fact have changed what the name holds by the time
 * the call runs — never less sound: the worst case is an UNKNOWN this
 * relation could have avoided attributing away from, never a wrongly
 * attributed later export.
 *
 * Restricting the walk to this reach model (rather than the whole file,
 * any scope, the way {@link classifyLocalBinding}'s single-assignment
 * proof does for a completely different question) is also what keeps it
 * cheap: like {@link mayEndModuleEvaluation}, it never descends into a
 * function body or an expression tree, so a file dominated by
 * call-expression statements and object literals (real modules, and the
 * scan-performance suite's own synthetic worst case) costs one
 * statement-kind check per top-level statement, never a walk of the whole
 * expression forest underneath them.
 */
const reassignedModuleReachableNamesBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlySet<string>
>();

function reassignedModuleReachableNames(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const cached = reassignedModuleReachableNamesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const scanExpressions = mayContainClassStaticEvaluation(sourceFile);
  const reassigned = new Set<string>();

  /**
   * Checks a bare EXPRESSION-statement's own top-level shape for an
   * assignment/increment/decrement — `bail = other;`, `bail += 1;`,
   * `bail++;`. This is deliberately the ONLY place an expression is
   * inspected: an `ExpressionStatement` is not itself a container
   * {@link mayContainNestedStatements} descends into (by design — see its
   * own doc comment), so without this direct check a top-level
   * reassignment would never be seen at all. An assignment BURIED inside a
   * larger expression (`foo(bail = other)`) is deliberately not chased
   * further than this — missing one only makes this relation treat a
   * callee as definitely abrupt when a reassignment would in fact have
   * changed it, which costs precision, never soundness (see this
   * function's own doc comment).
   */
  function checkAssignmentLike(expr: ts.Expression): void {
    const unwrapped = unwrapParentheses(expr);
    if (
      ts.isBinaryExpression(unwrapped) &&
      isAssignmentOperatorToken(unwrapped.operatorToken.kind)
    ) {
      markLocallyReassigned(unwrapped.left, reassigned);
    } else if (
      (ts.isPrefixUnaryExpression(unwrapped) ||
        ts.isPostfixUnaryExpression(unwrapped)) &&
      (unwrapped.operator === ts.SyntaxKind.PlusPlusToken ||
        unwrapped.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      markLocallyReassigned(unwrapped.operand, reassigned);
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) {
      return;
    }
    if (ts.isExpressionStatement(node)) {
      checkAssignmentLike(node.expression);
    } else if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer)
    ) {
      markLocallyReassigned(node.initializer, reassigned);
    }
    if (
      scanExpressions ||
      mayContainNestedStatements(node) ||
      ts.isSourceFile(node)
    ) {
      ts.forEachChild(node, visit);
    }
  }

  visit(sourceFile);
  reassignedModuleReachableNamesBySourceFile.set(sourceFile, reassigned);
  return reassigned;
}

/**
 * The module-TOP-LEVEL callable named `name` this file's own text can read
 * a body out of directly (RWF-016) — the call-target candidate half of
 * {@link resolveExactLocalCallable}'s proof, before reassignment and
 * shadowing are even considered:
 *
 * - a module-TOP-LEVEL `function bail() {}` declaration, or
 * - a module-TOP-LEVEL `const bail = function () {}` / `const bail = () =>
 *   {}` — deliberately restricted to `const`, mirroring
 *   commonjs-reexports.ts's own `isConstDeclaration` gate for the same
 *   reason: a `const` can be reassigned nowhere in the language.
 *
 * `undefined` for every other shape sharing the name: a `let`/`var`
 * binding, a destructured binding, an import, a class, or any initializer
 * that isn't a function/arrow expression.
 *
 * Cheap and already properly scoped without any extra work: this only
 * ever iterates `sourceFile.statements` itself (never recursing into a
 * nested block or an expression), so it costs one shape check per
 * top-level statement.
 */
const topLevelCallableCandidatesBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlyMap<
    string,
    ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  >
>();

function topLevelCallableCandidates(
  sourceFile: ts.SourceFile,
): ReadonlyMap<
  string,
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
> {
  const cached = topLevelCallableCandidatesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const candidates = new Map<
    string,
    ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
  >();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      candidates.set(statement.name.text, statement);
    } else if (
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    ) {
      for (const decl of statement.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || decl.initializer === undefined) {
          continue;
        }
        const initializer = unwrapParentheses(decl.initializer);
        if (
          ts.isFunctionExpression(initializer) ||
          ts.isArrowFunction(initializer)
        ) {
          candidates.set(decl.name.text, initializer);
        }
      }
    }
  }

  topLevelCallableCandidatesBySourceFile.set(sourceFile, candidates);
  return candidates;
}

/**
 * Whether `fn` is `async` or a generator (RWF-016) — either one means
 * calling it can never itself be the abrupt completion this relation
 * models:
 *
 * - an `async` function's body runs synchronously only up to its first
 *   `await`/return/throw, but a synchronous `throw` inside one is caught
 *   by the implicit promise wrapper and turned into a REJECTED PROMISE,
 *   not a synchronous exception. The call `bail()` returns normally (with
 *   a promise) and module evaluation continues; only an unawaited
 *   rejection surfaces later, asynchronously, which cannot invalidate a
 *   synchronous later export write.
 * - a generator function's body does not run AT ALL when called — calling
 *   `bail()` only constructs a generator object; the body (and any throw
 *   in it) executes on `.next()`, if ever.
 *
 * Treating either as definitely abrupt would be exactly the unsound
 * over-inference RWF-016 exists to avoid.
 */
function isAsyncOrGeneratorCallable(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  const isGenerator =
    (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) &&
    fn.asteriskToken !== undefined;
  const isAsync =
    ts.canHaveModifiers(fn) &&
    (ts
      .getModifiers(fn)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ??
      false);
  return isGenerator || isAsync;
}

/** The statement list `node` directly, LEXICALLY owns as its own scope's body — never a NESTED block's statements. `undefined` for anything that owns no such list. */
function ownStatementsOf(node: ts.Node): readonly ts.Statement[] | undefined {
  if (ts.isBlock(node) || ts.isSourceFile(node)) {
    return node.statements;
  }
  if (ts.isCaseClause(node) || ts.isDefaultClause(node)) {
    return node.statements;
  }
  return undefined;
}

/**
 * Whether `ancestor` — one node on the walk from a call site up toward the
 * module's own top level — itself directly declares a binding named
 * `name` (RWF-016), shadowing anything declared further out. Checked
 * against a `catch` clause's own parameter, a `for`/`for..of`/`for..in`
 * loop's own declaration, and — for every other scope-bearing ancestor —
 * that scope's OWN statement list (never a further-nested block's, which
 * the walk will visit on its own next iteration).
 */
function scopeDeclares(ancestor: ts.Node, name: string): boolean {
  if (ts.isCatchClause(ancestor)) {
    return (
      ancestor.variableDeclaration !== undefined &&
      bindingNameIncludes(ancestor.variableDeclaration.name, name)
    );
  }
  if (
    (ts.isForOfStatement(ancestor) || ts.isForInStatement(ancestor)) &&
    ts.isVariableDeclarationList(ancestor.initializer)
  ) {
    return declarationListDeclares(ancestor.initializer, name);
  }
  if (
    ts.isForStatement(ancestor) &&
    ancestor.initializer !== undefined &&
    ts.isVariableDeclarationList(ancestor.initializer)
  ) {
    return declarationListDeclares(ancestor.initializer, name);
  }

  const statements = ownStatementsOf(ancestor);
  if (statements === undefined) {
    return false;
  }
  for (const statement of statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return true;
    }
    if (
      ts.isVariableStatement(statement) &&
      declarationListDeclares(statement.declarationList, name)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * The exact function/arrow node a module-scope call `name()`, made from
 * `callee`'s position, proves it invokes (RWF-016) — `undefined` for
 * every case this relation is not willing to guess about.
 *
 * Three independent proofs must all hold:
 *
 * 1. **No real lexical shadow.** Walking from `callee` up to (but not
 *    including) the source file, no intervening scope may declare `name`
 *    — a `catch` parameter, a `for` loop variable, or a block/case-clause
 *    declaration ({@link scopeDeclares}). This is genuine JS lexical
 *    scoping, not a whole-file guess: it is bounded by `callee`'s own
 *    nesting depth, which {@link mayEndModuleEvaluation}'s own reach model
 *    already keeps shallow (a call site inside a function body is never
 *    even offered to this relation — see its call site in
 *    `isDefinitelyAbruptCallStatement`).
 * 2. **Never reassigned** within the reach {@link mayEndModuleEvaluation}
 *    already models ({@link reassignedModuleReachableNames}) — a
 *    `function bail() {}` declaration can be reassigned too, and a `const`
 *    candidate is exempted by construction (see
 *    {@link topLevelCallableCandidates}'s own doc comment).
 * 3. **A supported module-TOP-LEVEL callable shape actually exists**
 *    ({@link topLevelCallableCandidates}), and is neither `async` nor a
 *    generator ({@link isAsyncOrGeneratorCallable}).
 *
 * Deliberately ONE hop: `name` must itself be bound directly to a
 * function/arrow, never to another identifier
 * (`const x = bail; x();` resolves nothing here — see the module-level
 * doc comment's ALIASES note). Chaining hops is exactly the alias
 * resolution RWF-016 is scoped not to introduce.
 */
function resolveExactLocalCallable(
  callee: ts.Identifier,
):
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | undefined {
  const name = callee.text;

  for (
    let ancestor: ts.Node | undefined = callee.parent as ts.Node | undefined;
    ancestor !== undefined && !ts.isSourceFile(ancestor);
    ancestor = ancestor.parent as ts.Node | undefined
  ) {
    if (scopeDeclares(ancestor, name)) {
      return undefined;
    }
  }

  const sourceFile = callee.getSourceFile();
  if (reassignedModuleReachableNames(sourceFile).has(name)) {
    return undefined;
  }

  const candidate = topLevelCallableCandidates(sourceFile).get(name);
  if (candidate === undefined || isAsyncOrGeneratorCallable(candidate)) {
    return undefined;
  }
  return candidate;
}

/**
 * The three-way answer to "how does executing this ONE statement, in
 * isolation, end" (RWF-016) — the primitive
 * {@link cannotCompleteNormally} is built out of:
 *
 * - `"throws"` — every path through this statement ends in an uncaught
 *   `throw`; the statement never returns and never falls through.
 * - `"returns"` — at least one path reaches a `return`, which is a NORMAL
 *   completion for the function's caller (see RWF-016's case D/E in
 *   tests/validation/FINDINGS.md): a definitely-abrupt determination must
 *   refuse the instant one of these is reachable, regardless of what else
 *   the body contains.
 * - `"normal"` — neither of the above is proven: the statement may fall
 *   through to whatever follows it. This is also the conservative default
 *   for every construct this relation does not model (loops, `switch`,
 *   plain expressions/declarations) — see {@link cannotCompleteNormally}'s
 *   doc comment for why looping constructs in particular are deliberately
 *   never classified any other way.
 */
type AbruptOutcome = "throws" | "returns" | "normal";

/**
 * Merges the two outcomes of an `if`/`else` pair (RWF-016). A `"returns"`
 * on EITHER side wins outright — a reachable `return` is a normal
 * completion for the caller no matter which branch it is in. Otherwise the
 * statement is `"throws"` only if BOTH sides are, and `"normal"`
 * otherwise (at least one side may fall through).
 */
function mergeAbruptOutcomes(
  a: AbruptOutcome,
  b: AbruptOutcome,
): AbruptOutcome {
  if (a === "returns" || b === "returns") {
    return "returns";
  }
  if (a === "throws" && b === "throws") {
    return "throws";
  }
  return "normal";
}

/**
 * {@link AbruptOutcome} for one statement (RWF-016). Recurses only through
 * the handful of constructs this relation actually models — `throw`,
 * `return`, a block, an `if`/`else`, a `try`/`catch` with no `finally`,
 * and a labeled statement (unwrapped to the statement it labels, since a
 * label alone changes nothing about how the statement itself completes).
 *
 * Everything else — loops, `switch`, plain expression/variable statements,
 * `debugger`, an empty statement, a `try` WITH a `finally` — answers
 * `"normal"` by construction: not "this statement completes normally" but
 * "this relation proves nothing about how it completes", which is the
 * safe default for {@link classifyAbruptSequence}'s purposes either way
 * (a sequence only ever needs to know whether a statement forces
 * `"throws"`/`"returns"`, never whether it forces `"normal"`).
 */
function classifyAbruptOutcome(statement: ts.Statement): AbruptOutcome {
  if (ts.isThrowStatement(statement)) {
    return "throws";
  }
  if (ts.isReturnStatement(statement)) {
    return "returns";
  }
  if (ts.isBlock(statement)) {
    return classifyAbruptSequence(statement.statements);
  }
  if (ts.isIfStatement(statement)) {
    const thenOutcome = classifyAbruptOutcome(statement.thenStatement);
    const elseOutcome = statement.elseStatement
      ? classifyAbruptOutcome(statement.elseStatement)
      : "normal";
    return mergeAbruptOutcomes(thenOutcome, elseOutcome);
  }
  if (ts.isTryStatement(statement)) {
    // A `finally` can override any completion inside the `try`/`catch`
    // (a `return`/absence of a throw in `finally` swallows an exception
    // entirely) — reasoning about that safely is more control-flow work
    // than RWF-016 is scoped to build, so a `finally` refuses outright.
    if (statement.finallyBlock !== undefined) {
      return "normal";
    }
    const tryOutcome = classifyAbruptSequence(statement.tryBlock.statements);
    if (statement.catchClause === undefined) {
      return tryOutcome;
    }
    // The `catch` only ever runs when the `try` block throws on every
    // path; when it might not (`"returns"` or `"normal"`), the `catch`'s
    // own body is irrelevant to how the `try` statement as a whole
    // completes.
    if (tryOutcome !== "throws") {
      return tryOutcome;
    }
    return classifyAbruptSequence(statement.catchClause.block.statements);
  }
  if (ts.isLabeledStatement(statement)) {
    return classifyAbruptOutcome(statement.statement);
  }
  return "normal";
}

/**
 * {@link AbruptOutcome} for a LIST of statements executed in order
 * (RWF-016) — a function body, a block, a `try`/`catch` arm. Walks the
 * list once: the first statement that forces `"throws"` or `"returns"`
 * decides the whole sequence (nothing after it can change that a path
 * through the sequence reaches it), and a statement that answers
 * `"normal"` simply means execution may continue to the next one. Reaching
 * the end of the list without either means the sequence may fall off the
 * end — an implicit `return undefined` — so the sequence itself is
 * `"normal"`.
 */
function classifyAbruptSequence(
  statements: readonly ts.Statement[],
): AbruptOutcome {
  for (const statement of statements) {
    const outcome = classifyAbruptOutcome(statement);
    if (outcome !== "normal") {
      return outcome;
    }
  }
  return "normal";
}

/**
 * Whether `fn`'s body, on EVERY modeled execution path, propagates an
 * abrupt completion (a `throw`) to its caller — never returns, never falls
 * off its own end (RWF-016). This is the callee-side half of RWF-016's
 * proof obligation; {@link resolveExactLocalCallable} is the call-site
 * half establishing exact identity, and {@link isDefinitelyAbruptCallStatement}
 * is where the two meet.
 *
 * `false` — never `true` by omission — for every function this relation
 * does not have a definite proof for, including:
 *
 * - a conditional throw with no matching abrupt `else`/rethrow (`if
 *   (flag) throw err;` with nothing after, or with normal code after);
 * - any `return`, reachable on any path, anywhere in the body — a
 *   `return` is what the CALLER experiences as a normal completion, so a
 *   `bail` that sometimes returns can never poison a later export
 *   (`if (flag) return; throw err;` is NOT abrupt — see
 *   {@link classifyAbruptOutcome}'s `"returns"` handling);
 * - a `try`/`catch` whose `catch` does not itself always rethrow, or that
 *   has a `finally`;
 * - a `while (true) {}` or any other loop that never returns for an
 *   entirely different reason (never terminating) — deliberately NOT
 *   inferred as abrupt. This relation proves abrupt completion from
 *   SYNTAX (an uncaught `throw` reachable on every path), never from
 *   nontermination, which would require reasoning this relation
 *   deliberately does not attempt (see RWF-016's remaining-limitations
 *   note in tests/validation/FINDINGS.md);
 * - an `async`/generator function ({@link isAsyncOrGeneratorCallable});
 * - an arrow function with a concise (non-block) body — `() => expr` can
 *   only ever complete by returning the expression's value, so it is
 *   trivially never abrupt and its body is not even inspected.
 */
function cannotCompleteNormally(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  if (isAsyncOrGeneratorCallable(fn)) {
    return false;
  }
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) {
    return false;
  }
  return classifyAbruptSequence(body.statements) === "throws";
}

/**
 * Whether evaluating `expression` — exactly as written, with no
 * surrounding operator or branch to get in the way — necessarily invokes a
 * callee this file's own text proves can only ever throw (RWF-016's
 * proof, factored out by RWF-017 so both call POSITIONS can share it).
 *
 * Only a directly-written `CallExpression` with a plain identifier callee
 * qualifies; `unwrapParentheses` is applied first because parentheses
 * change nothing about evaluation:
 *
 * ```text
 * bail()                   -- qualifies, when resolveExactLocalCallable +
 *                             cannotCompleteNormally both prove out
 * (bail())                 -- qualifies: parentheses are transparent
 * obj.bail()               -- refused: not a plain identifier callee
 * registry[name]()         -- refused: not a plain identifier callee
 * flag && bail()           -- refused: the call may not be evaluated
 * flag ? bail() : other    -- refused: the call may not be evaluated
 * foo(bail())              -- refused: see the note below
 * (bail(), value)          -- refused: see the note below
 * ```
 *
 * The last two ARE evaluated under ordinary JS evaluation order, but
 * recognising them means walking arbitrary expression trees with a real
 * evaluation-order model rather than a shape test, and getting that
 * subtly wrong in the permissive direction is exactly the failure this
 * relation exists to prevent. They are deliberately left unmodeled and
 * recorded as precision limitations in tests/validation/FINDINGS.md.
 *
 * `bail?.()` is NOT special-cased, and needs no special case: the optional
 * call short-circuits only on a nullish callee, and
 * {@link resolveExactLocalCallable} only ever returns a hoisted local
 * function declaration or a never-reassigned `const`-bound function
 * expression — neither of which can be nullish at the call site. The call
 * therefore always happens, exactly as the plain form does.
 */
function isDefinitelyAbruptCall(expression: ts.Expression): boolean {
  const unwrapped = unwrapParentheses(expression);
  if (
    !ts.isCallExpression(unwrapped) ||
    !ts.isIdentifier(unwrapped.expression)
  ) {
    return false;
  }
  const target = resolveExactLocalCallable(unwrapped.expression);
  return target !== undefined && cannotCompleteNormally(target);
}

/**
 * Whether executing `list` — the declaration list of a `const`/`let`/`var`
 * statement — necessarily invokes a definitely-abrupt local callee before
 * the declaration can complete (RWF-017).
 *
 * A declarator's INITIALIZER is evaluated as part of executing the
 * declaration, so the call in `const x = bail();` happens whenever the
 * statement is reached — the same execution fact RWF-016 already relies on
 * for `bail();`, in a different syntactic position. Which is the whole
 * point: abrupt module-evaluation behavior is a property of execution
 * semantics, not of whether the `CallExpression` happens to be wrapped in
 * an `ExpressionStatement`.
 *
 * Declarators are scanned LEFT TO RIGHT, which is the order the language
 * evaluates them in, and the FIRST one whose initializer is proven
 * definitely abrupt answers the whole statement:
 *
 * ```text
 * const a = bail(), b = safe();          -- abrupt: `a`'s initializer throws
 * const a = safe(), b = bail(), c = x();  -- abrupt: `b` is reached only if
 *                                            `a` completed normally, and
 *                                            then `b` throws, so `c` never
 *                                            runs either way
 * let x;                                  -- no initializer: nothing is
 *                                            evaluated, keep scanning
 * const a = safe();                       -- not PROVEN abrupt: may fall
 *                                            through, keep scanning
 * ```
 *
 * The middle case is the one worth stating explicitly, because it is why
 * scanning left to right needs no expression evaluator: every declarator
 * before the abrupt one either completed normally (so the abrupt one is
 * reached and throws) or was itself abrupt (so the statement never
 * completes either way). Both readings agree, so the statement cannot
 * complete normally without needing to know which one holds.
 *
 * A binding PATTERN is fine too — `const { x } = bail();` and
 * `const [x] = bail();` both evaluate the right-hand side before any
 * destructuring happens, and only the right-hand side is inspected here.
 * Nothing about destructuring semantics is modeled beyond that guaranteed
 * RHS evaluation.
 */
function declarationListCannotCompleteNormally(
  list: ts.VariableDeclarationList,
): boolean {
  for (const declaration of list.declarations) {
    if (
      declaration.initializer !== undefined &&
      isDefinitelyAbruptCall(declaration.initializer)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether `node` is a class STATIC FIELD whose initializer necessarily
 * invokes a definitely-abrupt local callee, so that evaluating the
 * enclosing class ends module evaluation rather than completing (RWF-018).
 *
 * ```js
 * class C { static x = bail(); }   // qualifies
 * const C = class { static x = bail(); };  // qualifies -- same evaluation
 * class C { x = bail(); }          // does NOT qualify: instance field
 * class C { static x; }            // does NOT qualify: no initializer
 * ```
 *
 * **Why a static field is module-evaluation time.** Evaluating a class
 * DEFINITION — a declaration or an expression alike — runs each static
 * element in declaration order as part of that evaluation, static blocks
 * and static field initializers together. So a `class` sitting at module
 * scope executes its static field initializers during module evaluation,
 * exactly as a `static { ... }` block does, and a throw out of one
 * propagates out of the class definition and out of the `require()` that
 * started the load. Nothing below the class runs — including a later
 * `module.exports = safeOp`, which a cyclic importer therefore never sees.
 *
 * **Why an INSTANCE field is not.** An instance field initializer is
 * installed on the class and evaluated per-INSTANCE, during construction.
 * Evaluating `class C { x = bail(); }` defines `C` and runs nothing;
 * `bail()` executes only if someone later writes `new C()`, which is a
 * caller's decision made after this module finished loading — the same
 * reason {@link mayEndModuleEvaluation} skips function bodies. Conflating
 * the two would withdraw authority from exports that really are reached.
 *
 * **Ordering needs no model.** {@link firstModuleEvaluationCutoff} records
 * the enclosing top-level STATEMENT's start, so which static field throws
 * — first, middle or last — cannot change the answer: static elements run
 * in declaration order, every one of them during this same class
 * definition, and any abrupt one means the class definition does not
 * complete. `static a = safe(); static b = bail(); static c = later();`
 * and `static a = bail(); static b = safe();` therefore agree, with no
 * intra-class control-flow graph.
 *
 * Everything about the CALL is RWF-016/017's, reused verbatim through
 * {@link isDefinitelyAbruptCall}: the exact non-reassigned local callee
 * ({@link resolveExactLocalCallable}), the always-throws body proof
 * ({@link cannotCompleteNormally}), the `async`/generator exclusions, and
 * the parentheses normalization that makes `static x = (bail());` work.
 * A caught class-evaluation throw is likewise handled by the existing
 * {@link isCaughtWithin} at the call site in {@link mayEndModuleEvaluation}
 * — `try { class C { static x = bail(); } } catch {}` keeps a later
 * export's authority, and a rethrowing `catch` withdraws it.
 *
 * Only the field's INITIALIZER is inspected, and only when it is that call
 * written directly. A COMPUTED KEY (`static [bail()] = 1`) is deliberately
 * NOT recognised here even though it is also evaluated at class-definition
 * time: computed keys evaluate for instance members and methods too, which
 * makes them a different rule with a different scope — RWF-019's
 * {@link isDefinitelyAbruptComputedClassElementKey}, which covers every
 * class element rather than being folded in behind a static-field name.
 * Nor is an initializer the call merely
 * appears somewhere inside (`static x = foo(bail())`, `[bail()]`,
 * `` `${bail()}` ``) — that is the same arbitrary-expression-evaluation
 * boundary {@link isDefinitelyAbruptCall} already draws and documents.
 */
function isDefinitelyAbruptStaticFieldInitializer(node: ts.Node): boolean {
  return (
    ts.isPropertyDeclaration(node) &&
    node.initializer !== undefined &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ===
      true &&
    isDefinitelyAbruptCall(node.initializer)
  );
}

/**
 * Whether `node` is a class element whose COMPUTED PROPERTY NAME
 * necessarily invokes a definitely-abrupt local callee, so that evaluating
 * the enclosing class ends module evaluation rather than completing
 * (RWF-019).
 *
 * ```js
 * class C { static [bail()] = 1; }     // qualifies
 * class C { [bail()] = 1; }            // qualifies -- NOT static, and that is the point
 * class C { [bail()]() {} }            // qualifies
 * class C { static [bail()]() {} }     // qualifies
 * class C { get [bail()]() {} }        // qualifies
 * class C { set [bail()](v) {} }       // qualifies
 * const C = class { [bail()] = 1; };   // qualifies -- same evaluation
 * class C { x = bail(); }              // does NOT qualify: instance field VALUE (RWF-018's line)
 * class C { m() { bail(); } }          // does NOT qualify: method BODY
 * class C { bail() {} }                // does NOT qualify: not a computed key
 * ```
 *
 * **Why a computed key is class-DEFINITION time, whatever the element is.**
 * A computed property name is evaluated by ClassDefinitionEvaluation, in
 * declaration order, as each element is defined — the key has to exist
 * before the element can be installed on the class or its prototype. That
 * is true for every element form, because installing ANY of them needs a
 * property key: a static field, an instance field, a method, a getter, a
 * setter, an `async` method, a generator method. So a class sitting at
 * module scope evaluates every computed key it writes during module
 * evaluation, and a throw out of one propagates out of the class
 * definition and out of the `require()` that started the load. Nothing
 * below the class runs — including a later `module.exports = safeOp`,
 * which a cyclic importer therefore never sees.
 *
 * **This is exactly what makes RWF-019 a different rule from RWF-018, not
 * a widening of it.** RWF-018's static/instance distinction is about WHEN
 * the VALUE runs, and it is real:
 * `class C { x = bail(); }` defines `C` and runs nothing, because an
 * instance field initializer is stored and executed per-INSTANCE during
 * construction. The KEY of that very same element is a separate
 * expression in a separate position, and it runs immediately either way:
 * `class C { [bail()] = 1; }` throws at definition time even though
 * `class C { x = bail(); }` does not. Requiring `static` here — the shape
 * test {@link isDefinitelyAbruptStaticFieldInitializer} correctly
 * applies to INITIALIZERS — would therefore miss the majority of the
 * family. Both facts are proven in one real `node` process in
 * fixtures/commonjs-circular-import-computed-class-key-throw-ground-truth/.
 *
 * The same reasoning is why a METHOD's or ACCESSOR's deferred body is
 * untouched by this: `[bail()]() { ... }` executes `bail()` when the class
 * is defined and the BODY only when someone calls the method, and this
 * predicate reads the name node alone. {@link mayEndModuleEvaluation}'s
 * function-like stop still skips the body; this test is simply asked
 * before that stop, since a `MethodDeclaration` IS function-like.
 *
 * **Ordering needs no model**, for the same reason RWF-018 needed none:
 * {@link firstModuleEvaluationCutoff} records the enclosing top-level
 * STATEMENT's start, so which computed key throws — first, middle or last
 * — cannot change the answer. Keys evaluate in declaration order, every
 * one of them during this same class definition, so
 * `[safe()] = 1; [bail()] = 2; [later()] = 3;` needs no intra-class
 * control-flow graph: the class definition does not complete either way.
 *
 * Scope is deliberately narrow in three directions:
 *
 * - only a genuine `ts.ComputedPropertyName` counts, read off the AST.
 *   `class C { bail() {} }` and `class C { "bail()" = 1; }` are ordinary
 *   names and are not computed keys, whatever their text looks like;
 * - only class elements count. The parent must be a `ClassDeclaration` or
 *   `ClassExpression`, which is what excludes an OBJECT LITERAL's computed
 *   key (`{ [bail()]: 1 }`) and its methods — `MethodDeclaration` is the
 *   same node KIND in both, and an object literal is an ordinary
 *   expression belonging to the arbitrary-expression-evaluation boundary
 *   {@link isDefinitelyAbruptCall} draws, not to class evaluation;
 * - only the key expression written DIRECTLY as that call qualifies, via
 *   {@link isDefinitelyAbruptCall} — which also gives RWF-019 the
 *   parentheses normalization that makes `[(bail())]` work, the exact
 *   non-reassigned local callee ({@link resolveExactLocalCallable}), the
 *   always-throws body proof ({@link cannotCompleteNormally}) and the
 *   `async`/generator exclusions, all reused verbatim. `[foo(bail())]`,
 *   `` [`${bail()}`] `` and `[(bail(), "x")]` are all evaluated at
 *   runtime and all deliberately unrecognised: that is the same
 *   arbitrary-expression-evaluation boundary RWF-017 recorded, and
 *   `[flag && bail()]` / `[flag ? bail() : "x"]` show why it is not safe
 *   to guess past it — those genuinely may not call `bail` at all.
 *
 * A caught class-evaluation throw is handled by the existing
 * {@link isCaughtWithin} at the call site in {@link mayEndModuleEvaluation},
 * exactly as for RWF-018: `try { class C { [bail()] = 1; } } catch {}`
 * keeps a later export's authority, and a rethrowing `catch` withdraws it.
 * A class DEFINED inside a function/method/arrow body is never offered to
 * this predicate at all, because that walk stops at function-like nodes
 * before reaching it — the class definition is deferred until the enclosing
 * function runs, so it must not poison module evaluation.
 */
function isDefinitelyAbruptComputedClassElementKey(node: ts.Node): boolean {
  return (
    ts.isClassElement(node) &&
    node.name !== undefined &&
    ts.isComputedPropertyName(node.name) &&
    node.parent !== undefined &&
    ts.isClassLike(node.parent) &&
    isDefinitelyAbruptCall(node.name.expression)
  );
}

/**
 * Whether `node` is a class's `extends` HERITAGE clause whose expression
 * necessarily invokes a definitely-abrupt local callee, so that evaluating
 * the enclosing class ends module evaluation rather than completing
 * (RWF-020).
 *
 * ```js
 * class C extends bail() {}            // qualifies
 * const C = class extends bail() {};   // qualifies -- same evaluation
 * class C extends (bail()) {}          // qualifies -- parentheses are transparent
 * class C extends baseFactory() {}     // does NOT qualify: the call returns
 * class C extends null {}              // does NOT qualify: no call at all
 * class C extends Base {}              // does NOT qualify: no call at all
 * ```
 *
 * **Why the heritage expression is class-DEFINITION time, and the FIRST
 * thing that runs.** ClassDefinitionEvaluation evaluates the heritage
 * expression before it does anything else with the class: the superclass
 * value has to exist before the prototype chain can be built, before any
 * element can be installed on it, and therefore before any computed key
 * (RWF-019), static field initializer (RWF-018) or static block (RWF-015)
 * runs. So a `class` sitting at module scope evaluates its `extends`
 * expression during module evaluation, and a throw out of that expression
 * propagates out of the class definition and out of the `require()` that
 * started the load. The class binding is never created and nothing below
 * the class runs — including a later `module.exports = safeOp`, which a
 * cyclic importer therefore never sees. Measured, in order, under real
 * `node` in
 * fixtures/commonjs-circular-import-class-heritage-throw-ground-truth/:
 * a throwing heritage leaves the element list entirely unevaluated, while
 * a harmless one lets every element run.
 *
 * **Why this is a third rule rather than a widening of RWF-018/019.** Both
 * of those read an expression written on a class ELEMENT — a
 * `PropertyDeclaration`'s initializer, a `ClassElement`'s
 * `ComputedPropertyName`. A heritage expression is on no element at all;
 * it hangs off the class's `heritageClauses`, is evaluated strictly before
 * every element, and is the only class-definition-time expression that
 * still runs when the class body is completely EMPTY — which is exactly
 * the shape (`class C extends bail() {}`) that neither predecessor could
 * see.
 *
 * **What is deliberately NOT inferred: the heritage VALUE.** RWF-020 asks
 * only whether evaluating the heritage CALL itself completes. Whether the
 * resulting value is a valid superclass is a separate semantic question
 * this model does not answer, and three real cases turn on it — all three
 * measured in the same fixture, all three throwing a `TypeError` for a
 * reason RWF-020 does not and must not claim:
 *
 * ```js
 * async function bail() { throw x; }
 * class C extends bail() {}   // the CALL returns a Promise; the class
 *                             // definition then fails on "not a constructor"
 * function* bail() { throw x; }
 * class C extends bail() {}   // the CALL returns a generator object without
 *                             // running the body at all; same TypeError
 * function n() { return 1; }
 * class C extends n() {}      // the CALL returns 1; same TypeError
 * ```
 *
 * The `async`/generator exclusions come free and unchanged from
 * {@link cannotCompleteNormally} via {@link isDefinitelyAbruptCall}, which
 * already refuses both — an `async` function's `throw` becomes a rejected
 * promise and a generator's body does not run on call. Reaching the same
 * refusal by a different route (the returned value being an invalid
 * superclass) would be new value/type interpretation, so it is left out;
 * the invalid-heritage-result family is recorded as a separate open
 * finding in tests/validation/FINDINGS.md rather than folded in here.
 *
 * Everything about the CALL is RWF-016/017's, reused verbatim through
 * {@link isDefinitelyAbruptCall}: the exact non-reassigned local callee
 * ({@link resolveExactLocalCallable}), the always-throws body proof
 * ({@link cannotCompleteNormally}), the `async`/generator exclusions, and
 * the parentheses normalization that makes `extends (bail())` work.
 * `extends foo(bail())`, `extends (bail(), Base)`,
 * `extends (bail() || Base)`, `extends (flag ? bail() : Base)` and
 * `extends new Bail()` are all left unrecognised at that same
 * arbitrary-expression boundary — the first two really do always evaluate
 * `bail`, the next two genuinely may not, and telling them apart needs the
 * evaluation-order model {@link isDefinitelyAbruptCall} deliberately does
 * not have.
 *
 * Scope is narrow in two further directions:
 *
 * - only an `extends` clause counts. A TypeScript `implements` clause is
 *   erased and evaluates nothing, and an INTERFACE's `extends` clause is a
 *   list of types, not expressions — hence the `ts.isClassLike` check on
 *   the parent, which admits a `ClassDeclaration` and a `ClassExpression`
 *   and nothing else;
 * - a class defined inside a function, method, arrow or accessor body is
 *   never offered to this predicate at all, because
 *   {@link mayEndModuleEvaluation}'s walk stops at function-like nodes
 *   first. `function configure() { class C extends bail() {} }` defers the
 *   whole class definition, heritage included, so it must not poison
 *   module evaluation — confirmed in the same fixture.
 *
 * A caught class-evaluation throw is handled by the existing
 * {@link isCaughtWithin} at the call site in {@link mayEndModuleEvaluation},
 * exactly as for RWF-018 and RWF-019:
 * `try { class C extends bail() {} } catch {}` keeps a later export's
 * authority, and a rethrowing `catch` withdraws it.
 */
function isDefinitelyAbruptClassHeritage(node: ts.Node): boolean {
  return (
    ts.isHeritageClause(node) &&
    node.token === ts.SyntaxKind.ExtendsKeyword &&
    node.parent !== undefined &&
    ts.isClassLike(node.parent) &&
    node.types.some((type) => isDefinitelyAbruptCall(type.expression))
  );
}

/**
 * Whether executing `node` — one statement — necessarily invokes a local
 * callee that RWF-016 proves can only ever throw, so that the statement
 * cannot complete normally and module evaluation ends there (uncaught).
 *
 * Two statement positions qualify, and they qualify for the SAME reason —
 * evaluating the statement necessarily performs the call:
 *
 * ```text
 * bail();                  -- RWF-016: a bare expression statement
 * const x = bail();        -- RWF-017: a variable declaration whose
 * let x = bail();             initializer is that call (`const`/`let`/`var`
 * var x = bail();             alike -- this is about the CALL SITE's
 *                             enclosing declaration, not about how `bail`
 *                             itself was declared)
 * if (bail()) { ... }      -- refused: the call is not itself a statement,
 *                             and this relation models statements
 * for (let x = bail();;) {} -- refused: a `for` initializer is a
 *                             declaration LIST, not a VariableStatement,
 *                             and loops are deliberately left to the
 *                             conservative treatment RWF-015 already gives
 *                             them (see FINDINGS.md)
 * ```
 *
 * These are the only constructs {@link mayEndModuleEvaluation} treats as
 * able to end module evaluation, alongside the pre-existing `return`/
 * uncaught-`throw` pair.
 */
function isDefinitelyAbruptCallStatement(node: ts.Node): boolean {
  if (ts.isExpressionStatement(node)) {
    return isDefinitelyAbruptCall(node.expression);
  }
  if (ts.isVariableStatement(node)) {
    return declarationListCannotCompleteNormally(node.declarationList);
  }
  return false;
}

/**
 * {@link WholeModuleExportAuthority} for one `module.exports = X` /
 * `export = X` write (RWF-014).
 *
 * `node` is the write itself (the assignment expression, or the
 * `ExportAssignment`); `rhs` is its right-hand side, which is what
 * {@link isDefinitelyReachedExportAssignment} needs in order to climb out
 * through a chained assignment first.
 *
 * The `"deferred"` walk stops at the source file and asks only about node
 * KINDS, never about names or call sites — a function/class body between
 * the write and the file means the write's execution time is not tied to
 * module evaluation at all.
 */
function classifyWholeModuleExportAuthority(
  node: ts.Node,
  rhs: ts.Expression,
): WholeModuleExportAuthority {
  if (isDefinitelyReachedExportAssignment(rhs)) {
    return "unconditional";
  }
  // Written as a top-level statement, but some earlier top-level statement
  // can end module evaluation before this one runs (RWF-015). Checked
  // before the `"deferred"` walk because the two are mutually exclusive: a
  // direct child of the source file has no function or class body between
  // it and the file.
  if (isTopLevelExportAssignment(rhs)) {
    return "bypassable";
  }
  for (
    let ancestor: ts.Node | undefined = node.parent as ts.Node | undefined;
    ancestor !== undefined && !ts.isSourceFile(ancestor);
    ancestor = ancestor.parent as ts.Node | undefined
  ) {
    if (
      ts.isFunctionLike(ancestor) ||
      ts.isClassLike(ancestor) ||
      ts.isClassStaticBlockDeclaration(ancestor)
    ) {
      return "deferred";
    }
  }
  return "conditional";
}

/**
 * Every `module.exports = X` (or TypeScript's `export = X`) write in the
 * file, in SOURCE ORDER, each carrying its own
 * {@link WholeModuleExportAuthority}.
 *
 * `ts.forEachChild` visits children in syntactic order and this walk is
 * pre-order, so the emitted sequence is already ordered by source start
 * position (an ancestor starts before its descendants, and siblings are
 * visited in order) — no sort is needed, and the whole pass stays one
 * linear traversal.
 *
 * This deliberately collects CONDITIONAL and DEFERRED writes too, which
 * the pre-RWF-014 `findLastModuleExportsAssignment` also did — but that
 * function returned whichever write it saw LAST and let every consumer
 * treat it as the module's exported value. Keeping them visible is the
 * point: they are exactly the evidence
 * {@link selectAuthoritativeWholeModuleExport} needs in order to REFUSE.
 */
function collectModuleExportsAssignments(
  sourceFile: ts.SourceFile,
): readonly ModuleExportsAssignment[] {
  const found: ModuleExportsAssignment[] = [];

  function record(node: ts.Node, rhs: ts.Expression): void {
    found.push({
      rhs,
      location: toSourceLocation(sourceFile, node),
      isModuleScope: isUnconditionalModuleScopeStatement(node),
      authority: classifyWholeModuleExportAuthority(node, rhs),
    });
  }

  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left) &&
      ts.isIdentifier(node.left.expression) &&
      node.left.expression.text === "module" &&
      node.left.name.text === "exports"
    ) {
      record(node, node.right);
    } else if (ts.isExportAssignment(node) && node.isExportEquals) {
      record(node, node.expression);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/**
 * The ONE `module.exports = X` write that provably decides the module's
 * exported value, or `undefined` when no single write can be proven to
 * (RWF-014) — the single authority gate every whole-module export fact
 * passes through.
 *
 * Node's `module.exports` really is last-write-wins, and the pre-RWF-014
 * code took that as licence to keep the last write in SOURCE order. Those
 * are not the same thing. Source order is last-write order only when
 * every write definitely runs, in that order; the moment a write is
 * conditional or deferred, "last in the file" is a branch picked
 * arbitrarily and then presented as the module's identity. That is a false
 * NOT_AFFECTED whenever the branch NOT picked is the one that reaches the
 * finding's sink:
 *
 * ```js
 * function dangerousOp() { danger.explode(); }   // reaches the sink
 * function safeOp() {}
 * if (FLAG) { module.exports = dangerousOp; }
 * else      { module.exports = safeOp; }
 * ```
 *
 * Here the export bound to `safeOp`, the caller's `fixture(input)` got a
 * fully RESOLVED edge to it, `dangerousOp` was left with no incoming edge,
 * and the reachability search returned unreachable with
 * `reachableSubgraphComplete: true` — a complete Family C proof for a
 * package that calls `explode` on every run that takes the other branch.
 * Reproduced end to end before this gate existed; see
 * fixtures/commonjs-conditional-whole-module-export/.
 *
 * Two conditions, and both are about EXECUTION ORDER rather than text
 * order:
 *
 * 1. **The last write in the file must be `"unconditional"`.** It then
 *    definitely runs, and — because module evaluation executes top-level
 *    statements in order — it runs AFTER every write above it, so it
 *    overwrites all of them whether or not they ran. Anything textually
 *    before it is therefore irrelevant, which is what makes the legitimate
 *    shapes below still work with no special-casing:
 *
 *    ```js
 *    module.exports = first;  module.exports = second;   // -> second
 *    if (flag) { module.exports = first; }
 *    module.exports = second;                            // -> second
 *    ```
 *
 *    and equally what refuses the mirror image, where the conditional
 *    write is the one that runs last:
 *
 *    ```js
 *    module.exports = first;
 *    if (flag) { module.exports = second; }               // -> ambiguous
 *    ```
 *
 *    Requiring the LAST collected write to be unconditional expresses both
 *    at once: if it is, no conditional write survives after it; if it is
 *    not, a write whose execution this module cannot decide is the final
 *    one. (Note this is strictly a check on the last element, not "the
 *    last unconditional write plus a scan for conditional writes after it"
 *    — the two are the same statement, and the shorter one cannot be got
 *    wrong.)
 *
 * 2. **No `"deferred"` write anywhere in the file.** A write inside a
 *    function body is not ordered by source position at all: nothing stops
 *    an importer from calling `configure()` after module evaluation and
 *    replacing an exported value that a later top-level statement had
 *    "definitively" set. Position cannot dominate what position does
 *    not order, so a single deferred write withdraws the whole file's
 *    whole-module identity — including from an otherwise perfect
 *    unconditional final assignment.
 *
 * Refusing is cheap and never invents a verdict: an unattributed
 * whole-module export is an unresolved target, and an unresolved target is
 * UNKNOWN (see verdict.ts's Site A). It is also honest downstream —
 * call-graph.ts turns a call through an export it cannot attribute into an
 * `unknown(unresolved_target)` edge, which makes the reachable subgraph
 * incomplete and withdraws Family C rather than silently narrowing it.
 *
 * Linear in the number of collected writes, with no CFG, no dataflow, and
 * no target execution.
 */
function selectAuthoritativeWholeModuleExport(
  assignments: readonly ModuleExportsAssignment[],
): ModuleExportsAssignment | undefined {
  const last = assignments.at(-1);
  if (last === undefined || last.authority !== "unconditional") {
    return undefined;
  }
  return assignments.some((a) => a.authority === "deferred") ? undefined : last;
}

/**
 * The whole-module export binding for a file whose `module.exports` writes
 * {@link selectAuthoritativeWholeModuleExport} refused to collapse into
 * one value (RWF-014).
 *
 * The export still EXISTS — this file assigns `module.exports`, and
 * dropping the binding entirely would be its own unsound claim (a module
 * that exports nothing, which downstream absence reasoning could read as
 * positive evidence). What it carries is nothing: no `localName`, no
 * `localFunctionLocation`, no `commonJsReExport`. Every one of those would
 * name one branch, and naming one branch is precisely the defect.
 *
 * `location` anchors to the LAST write observed, purely so the binding
 * points somewhere real in the file; it is a position, not an attribution,
 * and nothing resolves a target through it.
 */
function ambiguousWholeModuleExport(
  observed: ModuleExportsAssignment,
): ExportBinding {
  return {
    kind: "default",
    syntax: "commonjs",
    location: observed.location,
  };
}

/**
 * The literal string value of a computed property name's key expression
 * (`[expr]:` / `[expr]() {}`), when it's directly a string/numeric
 * literal or a same-file `const` binding initialized to one (VT-217,
 * SDD-v0.2.md § 7.1's computed-key follow-on) -- e.g.
 * `const NAME = "vulnerable"; module.exports = { [NAME]: impl };`.
 * `undefined` for anything else (a parameter, a function call, a runtime
 * value) -- a genuinely dynamic key stays unresolved exactly as before.
 */
function resolveComputedPropertyNameLiteral(
  sourceFile: ts.SourceFile,
  name: ts.ComputedPropertyName,
): string | undefined {
  const expr = name.expression;
  if (ts.isStringLiteralLike(expr) || ts.isNumericLiteral(expr)) {
    return expr.text;
  }
  if (!ts.isIdentifier(expr)) {
    return undefined;
  }
  const keyName = expr.text;

  let found: string | undefined;
  function visit(node: ts.Node): void {
    if (found !== undefined) {
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === keyName &&
      node.initializer &&
      ts.isStringLiteralLike(node.initializer) &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      found = node.initializer.text;
      return;
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return found;
}

/**
 * Unpacks `module.exports = { a, b: c, method() {} }` into individual
 * named exports — this is one of the most common CommonJS export patterns
 * and, without unpacking, its named members would be invisible to symbol
 * resolution (TASK-017). Spread elements are skipped: their exported name
 * cannot be determined statically (see docs/SDD.md § 21: dynamic
 * constructs must not fabricate exact bindings). A computed property name
 * (VT-217) is unpacked only when its key resolves to a literal via
 * {@link resolveComputedPropertyNameLiteral}; any other computed key stays
 * unresolved. Returns `undefined` (not unpacked) when the RHS isn't an
 * object literal, or when none of its properties are statically nameable.
 */
function unpackObjectLiteralExports(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
): ExportBinding[] | undefined {
  const sourceFile = index.sourceFile;
  if (!ts.isObjectLiteralExpression(assignment.rhs)) {
    return undefined;
  }

  const results: ExportBinding[] = [];

  for (const property of assignment.rhs.properties) {
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      results.push({
        kind: "named",
        syntax: "commonjs",
        exportedName: property.name.text,
        localName: ts.isIdentifier(property.initializer)
          ? property.initializer.text
          : undefined,
        // RWF-011: `{ foo: function () {} }` / `{ foo: () => {} }` /
        // `{ Foo: class {} }` — the property's VALUE is the function node,
        // an identity. Without it the only remaining key would be the
        // property name, which is the exported name and therefore no
        // provenance at all (see {@link propertyExportProvenance}).
        localFunctionLocation: objectLiteralValueLocation(
          sourceFile,
          assignment,
          property.initializer,
        ),
        commonJsReExport: objectLiteralValueReExport(
          index,
          assignment,
          property.initializer,
        ),
        localIdentifierProvenanceRefused: refusedProvenanceFlag(
          refusesLocalIdentifierProvenance(index, property.initializer),
        ),
        location: toSourceLocation(sourceFile, property),
      });
    } else if (
      ts.isPropertyAssignment(property) &&
      ts.isComputedPropertyName(property.name)
    ) {
      const exportedName = resolveComputedPropertyNameLiteral(
        sourceFile,
        property.name,
      );
      if (exportedName !== undefined) {
        results.push({
          kind: "named",
          syntax: "commonjs",
          exportedName,
          localName: ts.isIdentifier(property.initializer)
            ? property.initializer.text
            : undefined,
          localFunctionLocation: objectLiteralValueLocation(
            sourceFile,
            assignment,
            property.initializer,
          ),
          commonJsReExport: objectLiteralValueReExport(
            index,
            assignment,
            property.initializer,
          ),
          // RWF-013, extended to the computed-key form (VT-217) that
          // shipped without it: `module.exports = { [NAME]: fn }` binds an
          // export to an identifier exactly as the literal-key form does,
          // and a reassigned `fn` must be refused in both.
          localIdentifierProvenanceRefused: refusedProvenanceFlag(
            refusesLocalIdentifierProvenance(index, property.initializer),
          ),
          location: toSourceLocation(sourceFile, property),
        });
      }
    } else if (ts.isShorthandPropertyAssignment(property)) {
      results.push({
        kind: "named",
        syntax: "commonjs",
        exportedName: property.name.text,
        localName: property.name.text,
        // `module.exports = { Range }` over a local
        // `const Range = require("./classes/range")` -- the dominant
        // real-world shape (semver, qs; see the audit's § 5.2). The
        // shorthand's own identifier IS the value expression.
        commonJsReExport: objectLiteralValueReExport(
          index,
          assignment,
          property.name,
        ),
        localIdentifierProvenanceRefused: refusedProvenanceFlag(
          refusesLocalIdentifierProvenance(index, property.name),
        ),
        location: toSourceLocation(sourceFile, property),
      });
    } else if (
      ts.isMethodDeclaration(property) &&
      ts.isIdentifier(property.name)
    ) {
      results.push({
        kind: "named",
        syntax: "commonjs",
        exportedName: property.name.text,
        localName: property.name.text,
        // RWF-011: a method IS its own function node, so bind it by
        // position. Its `localName` above is the method's own name, which
        // for this shape is necessarily also the exported name — so a
        // name search could not tell the method apart from an unrelated
        // same-file `function foo() {}` and returned whichever came
        // first, silently attributing the wrong node.
        localFunctionLocation: methodValueLocation(
          sourceFile,
          assignment,
          property,
        ),
        location: toSourceLocation(sourceFile, property),
      });
    } else if (
      ts.isMethodDeclaration(property) &&
      ts.isComputedPropertyName(property.name)
    ) {
      const exportedName = resolveComputedPropertyNameLiteral(
        sourceFile,
        property.name,
      );
      if (exportedName !== undefined) {
        results.push({
          kind: "named",
          syntax: "commonjs",
          exportedName,
          localName: exportedName,
          // The computed form additionally has no usable name at all:
          // source indexing records the method under its literal source
          // text (`[NAME]`), so position is the only thing that can
          // resolve it.
          localFunctionLocation: methodValueLocation(
            sourceFile,
            assignment,
            property,
          ),
          location: toSourceLocation(sourceFile, property),
        });
      }
    }
    // Spread elements and any other computed property name (one that
    // doesn't resolve to a literal) are intentionally not unpacked.
  }

  return results.length > 0 ? results : undefined;
}

/**
 * {@link directValueFunctionLocation} for one property of a
 * `module.exports = { ... }` object literal, gated on the enclosing
 * assignment being unconditional module scope — the same guard the other
 * two identity relations apply, for the same reason: an object literal
 * assigned inside an `if`/`try`/loop may never be the module's exported
 * value at all, and `findLastModuleExportsAssignment` picks by source
 * order, not by control flow.
 */
function objectLiteralValueLocation(
  sourceFile: ts.SourceFile,
  assignment: ModuleExportsAssignment,
  value: ts.Expression,
): SourceLocation | undefined {
  return assignment.isModuleScope
    ? directValueFunctionLocation(sourceFile, value)
    : undefined;
}

/**
 * {@link resolveCommonJsReExportExpression} for one object-literal
 * property's value, gated on the enclosing `module.exports = { ... }`
 * assignment running unconditionally at module scope (RWF-004b).
 *
 * The same gate {@link objectLiteralValueLocation} applies immediately
 * above, for the same reason: `findLastModuleExportsAssignment` picks by
 * source order, not by control flow, so a `module.exports = {...}` inside
 * an `if`/`try`/function body describes one arbitrarily-chosen branch. A
 * re-export origin read out of it forwards the export to that branch's
 * package as though the other branch did not exist — see
 * {@link isDefinitelyReachedExportAssignment}.
 */
function objectLiteralValueReExport(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
  value: ts.Expression,
): CommonJsReExportOrigin | undefined {
  return isDefinitelyReachedExportAssignment(assignment.rhs)
    ? resolveCommonJsReExportExpression(index, value)
    : undefined;
}

/** The identity of a `module.exports = { foo() {} }` method — the method node itself, under the same module-scope guard. */
function methodValueLocation(
  sourceFile: ts.SourceFile,
  assignment: ModuleExportsAssignment,
  method: ts.MethodDeclaration,
): SourceLocation | undefined {
  return assignment.isModuleScope
    ? toSourceLocation(sourceFile, method)
    : undefined;
}

function buildExportBindings(
  index: SourceIndex,
  exportsList: readonly IndexedExport[],
): ExportBinding[] {
  const sourceFile = index.sourceFile;
  const results: ExportBinding[] = [];
  let sawCommonJsModuleExports = false;

  for (const exp of exportsList) {
    switch (exp.bindingKind) {
      case "commonjs-module-exports":
        sawCommonJsModuleExports = true;
        break;
      case "commonjs-exports-property": {
        // `exports.parse = parse` binds an export to an identifier
        // exactly as `module.exports = parse` does, and is the shape the
        // RWF-013 reproducer actually hits (see
        // fixtures/commonjs-stale-alias-export/).
        //
        // RWF-011: the export's own right-hand side is the ONLY thing
        // allowed to establish what it holds — as `localName` when it
        // names a local symbol, or as `localFunctionLocation` when it IS
        // a function/class node. Before this, a property export carried
        // neither, and `mapExportsToFunctions` searched the file for a
        // function named after the EXPORTED name, which bound
        // `exports.parse = registry.impl` to any unrelated same-file
        // `function parse()`. See {@link propertyExportProvenance}.
        const propertyRhs =
          exp.exportedName === undefined
            ? undefined
            : commonJsPropertyExportRhs(index, exp.exportedName);
        results.push({
          kind: "named",
          syntax: "commonjs",
          exportedName: exp.exportedName,
          ...propertyExportProvenance(index, propertyRhs),
          // Gated on the SAME unconditional-module-scope test as the
          // provenance fields above it (RWF-004b): the origin is read out
          // of the same last-write-wins map, so a branch-local assignment
          // would forward the export to whichever branch came last in the
          // file. See {@link isDefinitelyReachedExportAssignment}.
          commonJsReExport:
            exp.exportedName !== undefined &&
            propertyRhs !== undefined &&
            isDefinitelyReachedExportAssignment(propertyRhs)
              ? commonJsPropertyReExportOrigin(index, exp.exportedName)
              : undefined,
          localIdentifierProvenanceRefused: refusedProvenanceFlag(
            propertyRhs !== undefined &&
              refusesLocalIdentifierProvenance(index, propertyRhs),
          ),
          location: exp.location,
        });
        break;
      }
      case "named":
      case "default":
      case "re-export":
        results.push({
          kind: exp.bindingKind,
          syntax: "esm",
          exportedName: exp.exportedName,
          localName: exp.localName,
          specifier: exp.specifier,
          location: exp.location,
        });
        break;
    }
  }

  if (sawCommonJsModuleExports) {
    // RWF-014: the module's whole exported value comes from the ONE write
    // that provably decides it, or from nothing at all. Object-literal
    // unpacking sits inside this gate rather than beside it: the named
    // bindings it produces (`module.exports = { foo }` -> export `foo`)
    // describe the contents of ONE assigned object, so a conditionally
    // assigned literal would publish a branch's export table as the
    // module's. See {@link selectAuthoritativeWholeModuleExport}.
    const assignments = collectModuleExportsAssignments(sourceFile);
    const authoritative = selectAuthoritativeWholeModuleExport(assignments);
    const observed = assignments.at(-1);
    if (authoritative) {
      const unpacked = unpackObjectLiteralExports(index, authoritative);
      results.push(
        ...(unpacked ?? [wholeModuleDefaultExport(index, authoritative)]),
      );
    } else if (observed) {
      results.push(ambiguousWholeModuleExport(observed));
    }
  }

  return results;
}

/**
 * The non-object-literal `module.exports = X` fallback. When `X` is an
 * identifier (`module.exports = main;`) or a named function/class
 * expression (`module.exports = function main() {};`), captures that name
 * as `localName` — needed to correlate this export back to the function
 * that implements it (see TASK-018 Call Graph, which relies on this to
 * find the node for `fixtures/commonjs/src/index.cjs`'s real
 * `module.exports = function main() {...}` pattern). Left `undefined` for
 * anything else (e.g. an inline anonymous arrow function): still a valid
 * "the module's default export exists" fact, just not attributable to a
 * named local declaration.
 */
/**
 * The concrete function identity a `module.exports = X` / `export = X`
 * assignment binds the module's whole exported value to — the RWF-003
 * relation (see {@link ExportBinding.localFunctionLocation}).
 *
 * Two shapes produce an identity, both of which name a function node
 * *structurally*, never by its text:
 *
 * ```text
 * module.exports = function () {}            -> that FunctionExpression
 * module.exports = function named() {}       -> that FunctionExpression
 * module.exports = async function () {}      -> that FunctionExpression
 * module.exports = () => {}                  -> that ArrowFunction
 * module.exports = async () => {}            -> that ArrowFunction
 * module.exports = fn   (const fn = function () {} / () => {})
 *                                            -> that same function node
 * export = function () {}                    -> that FunctionExpression
 * ```
 *
 * An arrow function is included because source-index.ts indexes arrows as
 * first-class function nodes exactly like function expressions
 * (`isFunctionLike`), and call-graph.ts registers and walks them the same
 * way — so this is integrating an already-authoritative representation,
 * not adding a partial one.
 *
 * Three guards make the result a fact rather than a guess, and each one
 * returning `undefined` leaves the export exactly as unattributed as it
 * was before RWF-003 (an unresolved target, hence UNKNOWN — never a
 * verdict):
 *
 * 1. **Unconditional module scope.** Node's `module.exports` is
 *    last-write-wins at RUNTIME, and this task has no control-flow
 *    semantics. An assignment nested in an `if`/`try`/loop/function may or
 *    may not run, and `findLastModuleExportsAssignment` picks the last one
 *    in SOURCE order — so binding to it would be choosing a branch
 *    arbitrarily. Requiring the winning assignment to be a direct
 *    statement of the file makes "this is the module's final exported
 *    value" true by the language's own rules.
 * 2. **CommonJS ambient provenance.** A file that declares its own
 *    `module`/`exports`/`require` binding is refused outright, so
 *    `const module = { exports: null }; module.exports = function () {}`
 *    creates no export identity at all — the RWF-004a protection, applied
 *    to this relation too (see `declaresCommonJsAmbientShadow`).
 * 3. **A fully proven alias chain.** The identifier form goes through
 *    commonjs-reexports.ts's module-scope single-assignment proof at
 *    EVERY hop (RWF-012's {@link resolveLocalValue}), so
 *    `const fn = function () {}; const a = fn; const b = a;
 *    module.exports = b` now lands on that function node, while a chain
 *    with one reassigned, multiply-declared, conditionally-initialized,
 *    destructured or cyclic hop anywhere along it resolves to nothing
 *    here — exactly as unattributed as before RWF-003.
 *
 * A class expression (`module.exports = class {}`) is deliberately NOT
 * matched: its callable target is an implicit or explicit constructor and
 * its members are attributed by a different relation
 * ({@link findExportedClassMembers}), which is keyed on the class's own
 * name. Extending identity-based attribution to anonymous classes is a
 * separate question, and refusing here costs only the precision it
 * already lacked.
 */
function directExportedFunctionLocation(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
): SourceLocation | undefined {
  if (!assignment.isModuleScope) {
    return undefined;
  }

  const value = unwrapValue(assignment.rhs);

  if (isDirectFunctionValue(value)) {
    return declaresCommonJsAmbientShadow(index)
      ? undefined
      : toSourceLocation(index.sourceFile, value);
  }

  if (!ts.isIdentifier(value) || declaresCommonJsAmbientShadow(index)) {
    return undefined;
  }

  const bound = resolveLocalValue(index, value);
  if (bound.kind !== "value") {
    return undefined;
  }
  return isDirectFunctionValue(bound.value)
    ? toSourceLocation(index.sourceFile, bound.value)
    : undefined;
}

/**
 * `true` or absent, never `false` — {@link ExportBinding} is a bag of
 * facts about an export, and "we did not refuse anything" is the absence
 * of a fact rather than one. Keeps every export binding this relation has
 * nothing to say about shaped exactly as it was before RWF-013.
 */
function refusedProvenanceFlag(refused: boolean): true | undefined {
  return refused ? true : undefined;
}

function wholeModuleDefaultExport(
  index: SourceIndex,
  assignment: ModuleExportsAssignment,
): ExportBinding {
  let localName: string | undefined;

  // RWF-012: read through parentheses and chained assignments, so
  // `module.exports = exports.decode = decode` names `decode` exactly as
  // the bare `module.exports = decode` form does. The value of `x = v` is
  // `v`, so this is the same fact, differently spelled — see
  // {@link unwrapValue}.
  //
  // Gated on {@link isDefinitelyReachedExportAssignment}, for the same reason
  // every other export-provenance fact in this module is, and this is the
  // ONE place RWF-012 could have skipped it. Reading through an assignment
  // turns a right-hand side this relation previously had nothing to say
  // about into a local NAME, and that name goes on to drive
  // `mapExportsToFunctions`'s same-file name search. In a conditional or
  // nested position that would be a branch chosen arbitrarily by source
  // order and then presented as certainty:
  //
  // ```js
  // if (FLAG) { module.exports = alias = dangerousOp; }
  // else      { module.exports = alias = safeOp; }
  // ```
  //
  // `findLastModuleExportsAssignment` keeps only the LAST assignment, so
  // the export would bind to `safeOp` and a complete Family C proof over
  // that node would report NOT_AFFECTED — while the run that took the
  // other branch reaches `dangerousOp`. Reproduced end to end as exactly
  // that false NOT_AFFECTED before this guard existed.
  //
  // Un-gated, the raw right-hand side is used instead, which is precisely
  // the pre-RWF-012 behaviour: a chained assignment is a `BinaryExpression`
  // and names nothing, so a conditional chained export goes back to
  // carrying no provenance at all. This deliberately does NOT change the
  // plain-identifier conditional form (`if (c) { module.exports = fn; }`),
  // whose raw right-hand side is already an identifier — that is a
  // separate, older gap in this same relation, and closing it here would
  // be an unrelated behaviour change smuggled into RWF-012.
  const rhsValue = isDefinitelyReachedExportAssignment(assignment.rhs)
    ? unwrapValue(assignment.rhs)
    : assignment.rhs;

  if (ts.isIdentifier(rhsValue)) {
    localName = rhsValue.text;
  } else if (
    (ts.isFunctionExpression(rhsValue) || ts.isClassExpression(rhsValue)) &&
    rhsValue.name
  ) {
    localName = rhsValue.name.text;
  }

  return {
    kind: "default",
    syntax: "commonjs",
    localName,
    // The export's concrete function identity, when the assignment names
    // one structurally (RWF-003). Independent of `localName`: an anonymous
    // value has an identity and no name, and a named function expression
    // has both.
    localFunctionLocation: directExportedFunctionLocation(index, assignment),
    // RWF-013: `module.exports = fn` where `fn` is a variable this file
    // reassigns (or otherwise cannot prove single-assignment for). The
    // name "fn" is still a perfectly good same-file match for the STALE
    // initializer, so the fallback must be told not to take it.
    localIdentifierProvenanceRefused: refusedProvenanceFlag(
      refusesLocalIdentifierProvenance(index, assignment.rhs),
    ),
    // `module.exports = require("./lib")` / `= require("./lib").foo`
    // (RWF-004a/RWF-004b): the module's whole exported value comes from
    // another module. Unlike `localName`, this survives the value being
    // anonymous.
    //
    // Uses {@link isDefinitelyReachedExportAssignment} rather than
    // `assignment.isModuleScope` (RWF-004b): the two differ only for a
    // CHAINED assignment, and real `debug@2.0.0`'s `node.js` is exactly
    // that — `exports = module.exports = require('./debug')`, one
    // unconditional top-level statement whose inner assignment's enclosing
    // node is the outer assignment rather than the statement. A
    // conditionally-assigned `module.exports` is refused by both.
    commonJsReExport: isDefinitelyReachedExportAssignment(assignment.rhs)
      ? commonJsModuleReExportOrigin(index)
      : undefined,
    location: assignment.location,
  };
}

/**
 * Builds the unified import/export model for a file already indexed by
 * TASK-014 (see docs/SDD.md § 15-17).
 */
export function buildModuleModel(index: SourceIndex): ModuleModel {
  return {
    filePath: index.filePath,
    imports: index.imports.map(toImportBinding),
    exports: buildExportBindings(index, index.exports),
  };
}

/**
 * Maps each of a module's *canonical* export names (the name an importer
 * would bind to — "default" for a default/whole-module export, or the
 * named-export identifier otherwise) to the {@link IndexedFunction} that
 * implements it, when that can be attributed to a local function
 * declaration.
 *
 * This is the one place that reconciles a canonical export name with the
 * underlying function's own declared name, which can differ — most
 * commonly for CommonJS's `module.exports = someNamedFunction;` idiom
 * (used throughout the real npm ecosystem, e.g. lodash's per-method
 * files): the canonical export name is `"default"`, but the function
 * itself is still named `someNamedFunction`. Any consumer that needs to
 * go from "the export a rule/import specifier names" to "the real
 * function" — not just "a function that happens to share the export's
 * literal name" — must go through this mapping rather than comparing
 * against a function's own name directly (see call-graph.ts's
 * `prepareFile`, which builds call edges this way, and
 * src/analysis/verdict.ts's `findOrPhantomTarget`, which locates a rule's
 * declared target the same way — see TASK-023 completion report for the
 * regression this fixes).
 */
export function mapExportsToFunctions(
  index: SourceIndex,
  model: ModuleModel,
): ReadonlyMap<string, IndexedFunction> {
  const result = new Map<string, IndexedFunction>();
  /** Built at most once per call, and only when some export actually carries an identity. */
  let functionsByPosition: ReadonlyMap<string, IndexedFunction> | undefined;

  for (const exp of model.exports) {
    if (exp.kind === "re-export") {
      // Chasing a re-export to its ultimate source file is not attempted
      // here — see TASK-018 completion report.
      continue;
    }
    const canonicalName = exp.kind === "default" ? "default" : exp.exportedName;
    if (!canonicalName) {
      continue;
    }

    // RWF-003: a structurally-referenced function node is the export's real
    // identity and always wins over the name search below — it is exact
    // where the name search is a same-file text match, and it is the ONLY
    // mechanism available at all when the exported function is anonymous.
    // See ExportBinding.localFunctionLocation.
    if (exp.localFunctionLocation) {
      functionsByPosition ??= indexFunctionsByPosition(index);
      const byIdentity = functionsByPosition.get(
        positionKey(exp.localFunctionLocation),
      );
      if (byIdentity) {
        result.set(canonicalName, byIdentity);
        continue;
      }
    }

    // RWF-013: the export's value is an identifier whose binding this
    // file's own text contradicts (reassigned, multiply declared, not
    // module scope, ...). The name search below would still find a
    // same-named function -- typically the STALE initializer, which
    // source indexing names after the very variable that was reassigned
    // away from it -- and binding that manufactures a confident target
    // out of a value the analyzer just proved it cannot determine. An
    // export nothing can attribute is an unresolved target (UNKNOWN),
    // which is the correct answer here; a stale one is a false verdict in
    // whichever direction the stale node's reachability happens to fall.
    // See ExportBinding.localIdentifierProvenanceRefused.
    if (exp.localIdentifierProvenanceRefused) {
      continue;
    }

    // RWF-011: ONLY a local name the export's own right-hand side
    // established may drive a same-file function search. This used to
    // read `exp.localName ?? exp.exportedName`, and that fallback is the
    // defect: a public export name is not provenance for any local
    // symbol, so `exports.parse = registry.impl` — whose value this
    // analyzer models nothing about — bound itself to an unrelated
    // same-file `function parse()` purely because the two strings match.
    // Family C would then prove that decoy unreachable and report a
    // complete, internally consistent, and false NOT_AFFECTED.
    //
    // Dropping the fallback costs nothing that had provenance: every
    // shape that legitimately resolved through it now arrives here with a
    // real `localName` (an identifier right-hand side, an object-literal
    // shorthand, an ESM local) or was already resolved above by exact
    // position (a directly-referenced function, arrow, class or method).
    // An export with neither is one nothing in this file attributes, and
    // an unattributed export is an unresolved target — UNKNOWN, never a
    // verdict. See {@link propertyExportProvenance}.
    const localKey = exp.localName;
    if (!localKey) {
      continue;
    }
    const matchingFn = index.functions.find((fn) => fn.name === localKey);
    if (matchingFn) {
      result.set(canonicalName, matchingFn);
    }
  }

  return result;
}

/** A function node's own start position, the identity key {@link ExportBinding.localFunctionLocation} resolves against. */
function positionKey(location: SourceLocation): string {
  return `${location.line}:${location.column}`;
}

/**
 * Every indexed function keyed by its own start position, built once per
 * {@link mapExportsToFunctions} call rather than re-scanned per export —
 * exactly one AST node begins at a given position, so first-wins here can
 * only ever be an exact match (the guard exists solely so a synthesized
 * implicit-constructor entry, whose position is its class's name rather
 * than its own node, can never displace a real function node).
 */
function indexFunctionsByPosition(
  index: SourceIndex,
): ReadonlyMap<string, IndexedFunction> {
  const byPosition = new Map<string, IndexedFunction>();
  for (const fn of index.functions) {
    const key = positionKey(fn.location);
    if (!byPosition.has(key)) {
      byPosition.set(key, fn);
    }
  }
  return byPosition;
}

/**
 * Structurally attributes a rule target's `export` name to every
 * class-member declaration (method or constructor) reachable through a
 * REAL, module-level export binding that names a class (VT-301A; see
 * docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md § 7.3/§ 10's RWF-011/R-6
 * provenance requirement).
 *
 * The chain is exact, never a same-file name search:
 *
 * ```text
 * export binding (canonical name -> local class name)
 *   -> that class's own IndexedFunction (mapExportsToFunctions,
 *      kind === "constructor" -- constructors are always named after
 *      their enclosing class, see source-index.ts)
 *   -> every OTHER IndexedFunction in the same file whose
 *      memberOf.className equals that class's own name AND whose own
 *      name equals memberName
 * ```
 *
 * A method/constructor belonging to a class the module does not itself
 * export is never a candidate here, no matter how uniquely its bare name
 * matches `memberName` elsewhere in the file — this is exactly the
 * coincidence RWF-011 identified as unsafe for a same-file bare-name
 * search to rely on.
 *
 * When more than one exported class legitimately declares a member named
 * `memberName` (e.g. two exported classes both happen to have a `parse()`
 * method), every one of them is a structurally valid candidate: this
 * returns ALL of them rather than arbitrarily picking one. It is the
 * caller's (`findExportNodeInFile`'s) job to turn each into a graph node,
 * and `resolveTargetNodes`/`checkReachability`'s existing
 * OR-across-candidate-nodes aggregation that already backs
 * multiple-`VulnerableSymbolTarget`/multiple-entrypoint reachability
 * decides AFFECTED/NOT_AFFECTED/UNKNOWN from there — this function never
 * narrows ambiguity down to one answer itself.
 *
 * Returns an empty array (not a guess) when the module exports no class
 * at all, or when no exported class's own members include `memberName` —
 * e.g. a webpack-bundled module whose export table
 * (`mapExportsToFunctions`) has no attributable class entry at all (see
 * RWF-006/RWB-03: this deliberately does not fall back to treating every
 * class in the file as if it were exported).
 */
export function findExportedClassMembers(
  index: SourceIndex,
  model: ModuleModel,
  memberName: string,
): readonly IndexedFunction[] {
  const exportedClassNames = new Set<string>();
  for (const fn of mapExportsToFunctions(index, model).values()) {
    if (fn.kind === "constructor" && fn.name !== undefined) {
      exportedClassNames.add(fn.name);
    }
  }

  if (exportedClassNames.size === 0) {
    return [];
  }

  return index.functions.filter(
    (fn) =>
      fn.name === memberName &&
      fn.memberOf !== undefined &&
      exportedClassNames.has(fn.memberOf.className),
  );
}
