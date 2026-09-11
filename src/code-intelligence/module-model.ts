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
  /**
   * Whether this binding is the placeholder for a whole-module export
   * whose value {@link selectAuthoritativeWholeModuleExport} REFUSED to
   * name (RWF-014/015/016/017/018/019), rather than one it attributed
   * (RWF-021).
   *
   * Purely internal analysis state: never serialized, never surfaced in
   * evidence, and read by exactly one consumer —
   * {@link entrypointRootCandidates}, which must WIDEN rather than
   * narrow when it sees it.
   *
   * This exists because the ABSENCE of {@link localName} is not sufficient
   * to tell the two situations apart, and treating it as if it were is
   * precisely the defect RWF-021 fixes. Both of these produce a binding
   * with no `localName` and no {@link localFunctionLocation}:
   *
   * ```js
   * module.exports = 42;                 // attributed: exports no callable
   * if (flag) { bail(); }                // WITHDRAWN: exports `main`, or
   * module.exports = main;               //   nothing, and we cannot say which
   * ```
   *
   * The first genuinely has no callable export and needs no root. The
   * second has one this analyzer declined to name, and dropping its root
   * makes the exported function's body invisible to reachability — which
   * reproduced a false NOT_AFFECTED carrying a complete Family C proof for
   * every one of the RWF-016/017/018/019 cutoff families. See
   * {@link entrypointRootCandidates}.
   */
  readonly exportAttributionWithdrawn?: boolean;
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

  const scanExpressions =
    mayContainClassDefinitionTimeEvaluation(sourceFile) ||
    mayContainObjectLiteralComputedKeyEvaluation(sourceFile);
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
 * widened by RWF-016, RWF-017, RWF-018, RWF-019, RWF-020 and RWF-024).
 *
 * Three constructs qualify — all of them ABRUPT COMPLETIONS, and the third
 * only when {@link isDefinitelyAbruptCallStatement},
 * {@link isDefinitelyAbruptStaticFieldInitializer},
 * {@link isDefinitelyAbruptComputedClassElementKey},
 * {@link isDefinitelyAbruptComputedObjectLiteralKey} or
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
 *   {@link isDefinitelyAbruptComputedClassElementKey}), or as an OBJECT
 *   LITERAL element's COMPUTED KEY (`{ [bail()]: 1 }`, `{ [bail()]() {} }`,
 *   RWF-024, which the language evaluates when the object literal is
 *   constructed, for every element form alike — see
 *   {@link isDefinitelyAbruptComputedObjectLiteralKey}), or as a class's
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
 * OBJECT LITERALS are not a statement-container form at all — they are
 * ordinary expressions, reached only once {@code scanExpressions} is true
 * — but once reached, the same asymmetry holds for the same reason: a
 * `PropertyAssignment`/`MethodDeclaration`/`GetAccessorDeclaration`/
 * `SetAccessorDeclaration`'s computed KEY runs while the object literal is
 * being constructed, so {@link isDefinitelyAbruptComputedObjectLiteralKey}
 * is likewise asked before the function-like stop, while a method/getter/
 * setter's BODY is skipped by that same stop (RWF-024).
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
    // Same reasoning, same ordering requirement, for an OBJECT LITERAL's
    // computed key (`{ [bail()]: 1 }`, `{ [bail()]() {} }`) — see
    // {@link isDefinitelyAbruptComputedObjectLiteralKey} (RWF-024).
    if (
      isDefinitelyAbruptComputedObjectLiteralKey(node) &&
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
 * Whether this file could contain an OBJECT LITERAL's computed property
 * name — the gate {@link firstModuleEvaluationCutoff} widens with, in
 * addition to {@link mayContainClassDefinitionTimeEvaluation}, for RWF-024.
 *
 * A class needs the literal token `class` to exist at all, which is what
 * makes that gate a sound, cheap text test. An object literal's computed
 * key has no comparable keyword: `{ [bail()]: 1 }` is written with nothing
 * but a `[` — the same token an array literal or an index expression uses.
 * So this test cannot be as tight as the `class` one; it is a coarser sound
 * over-approximation, exactly like the file that widened from `static` to
 * `class` before it (RWF-019's {@link mayContainClassDefinitionTimeEvaluation}
 * docs). A `[` used only for an array or an ordinary index access costs
 * that one file the full expression walk in {@link mayEndModuleEvaluation}
 * and changes no answer, while a file containing no `[` at all provably has
 * no object-literal computed key to find. Correctness never depends on this
 * test alone — {@link isDefinitelyAbruptComputedObjectLiteralKey} still
 * re-checks the exact AST shape on every node this walk actually reaches —
 * so a wider net here can only cost time, never soundness.
 */
function mayContainObjectLiteralComputedKeyEvaluation(
  sourceFile: ts.SourceFile,
): boolean {
  return sourceFile.text.includes("[");
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

/**
 * Strips the wrappers that may sit between an assignment target and the
 * target itself without changing WHICH storage location is written —
 * parentheses (`(x) = 1`, `({ a: (x) } = o)`) and TypeScript's own
 * type-only wrappers (`x! = 1`, `(x as T) = 1`). Deliberately a
 * SYNTACTIC unwrap of one node's `.expression`, never a walk of children:
 * chasing children is exactly the defect {@link markLocallyReassigned}
 * exists to avoid (RWF-025).
 */
function unwrapAssignmentTarget(target: ts.Node): ts.Node {
  let current = target;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
}

/**
 * Marks every LOCAL BINDING `target` — an assignment/update expression's
 * left-hand side, or a `for..in`/`for..of` non-declaration initializer —
 * rebinds, however nested (`[a] = ...`, `({ b: { c } } = ...)`,
 * `({ ...rest } = ...)`).
 *
 * RWF-025. The recursion descends through ASSIGNMENT-TARGET STRUCTURE
 * ONLY, never through arbitrary children, because an assignment target's
 * AST also contains expressions that are merely EVALUATED while the
 * target is resolved, and those bind nothing:
 *
 * ```js
 * ({ [bail()]: x } = source);   // `x` is rebound; `bail` is CALLED
 * ({ x = fallback() } = source); // `x` is rebound; `fallback` is CALLED
 * [holder[bail()]] = values;     // NOTHING local is rebound
 * obj[bail()] = value;           // NOTHING local is rebound
 * obj.bail = value;              // NOTHING local is rebound
 * ```
 *
 * A previous `ts.forEachChild` fallback here recorded EVERY identifier
 * under the target, so a computed key's callee (`bail`) was recorded as
 * locally reassigned. Because {@link reassignedModuleReachableNames}
 * caches its result per SOURCE FILE, one such unrelated destructuring
 * statement anywhere in a file made
 * {@link resolveExactLocalCallable} refuse that name FILE-WIDE, silently
 * withdrawing RWF-016/017/019/020/022/024's abrupt-completion cutoffs and
 * turning a sound UNKNOWN back into a false NOT_AFFECTED.
 *
 * The roles are distinguished, not suppressed wholesale: in
 * `({ [bail()]: bail } = source)` the computed KEY does not rebind
 * `bail`, but the property VALUE target does, so `bail` is still marked.
 *
 * Property MUTATION (`x.y = ...`, `x[k] = ...`) is excluded for the
 * reason it always was: it changes the object, not the binding — and
 * neither the object expression nor the index expression is a local
 * binding this relation may claim was reassigned.
 *
 * Those evaluated-only positions are not ignored, though — they are handed
 * to {@link markAssignmentsInsideEvaluatedExpression}, which records the
 * assignments they PERFORM without recording the names they merely READ.
 * The two traversals answer two different questions and are deliberately
 * separate; collapsing them in either direction is a defect (see that
 * function's own doc comment).
 */
function markLocallyReassigned(target: ts.Node, into: Set<string>): void {
  const unwrapped = unwrapAssignmentTarget(target);

  if (ts.isIdentifier(unwrapped)) {
    into.add(unwrapped.text);
    return;
  }

  if (ts.isObjectLiteralExpression(unwrapped)) {
    for (const property of unwrapped.properties) {
      if (ts.isPropertyAssignment(property)) {
        // `property.name` SELECTS which source property is read. A
        // computed one is an expression evaluated to produce that key —
        // never an assignment destination. Only the initializer is one.
        if (ts.isComputedPropertyName(property.name)) {
          markAssignmentsInsideEvaluatedExpression(
            property.name.expression,
            into,
          );
        }
        markLocallyReassigned(property.initializer, into);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        // `({ x } = o)` and `({ x = fallback() } = o)`: the NAME is the
        // target; `objectAssignmentInitializer` is a default VALUE.
        into.add(property.name.text);
        if (property.objectAssignmentInitializer) {
          markAssignmentsInsideEvaluatedExpression(
            property.objectAssignmentInitializer,
            into,
          );
        }
      } else if (ts.isSpreadAssignment(property)) {
        markLocallyReassigned(property.expression, into);
      }
    }
    return;
  }

  if (ts.isArrayLiteralExpression(unwrapped)) {
    for (const element of unwrapped.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      if (ts.isSpreadElement(element)) {
        markLocallyReassigned(element.expression, into);
        continue;
      }
      markLocallyReassigned(element, into);
    }
    return;
  }

  // A defaulted element of a destructuring target — `[x = d] = ...`,
  // `({ a: x = d } = ...)`. Only the left side is rebound; `d` is a value
  // the language may evaluate, exactly like a computed key's expression.
  if (
    ts.isBinaryExpression(unwrapped) &&
    unwrapped.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    markLocallyReassigned(unwrapped.left, into);
    markAssignmentsInsideEvaluatedExpression(unwrapped.right, into);
    return;
  }

  // Property MUTATION. Neither the object expression nor the index is a
  // local binding this assignment rebinds — but both are EVALUATED, so an
  // assignment written inside either one really does run.
  if (ts.isElementAccessExpression(unwrapped)) {
    markAssignmentsInsideEvaluatedExpression(unwrapped.expression, into);
    markAssignmentsInsideEvaluatedExpression(
      unwrapped.argumentExpression,
      into,
    );
    return;
  }
  if (ts.isPropertyAccessExpression(unwrapped)) {
    markAssignmentsInsideEvaluatedExpression(unwrapped.expression, into);
    return;
  }

  // Everything else — any shape that is not an assignment target at all —
  // rebinds no local binding, so it contributes no name.
}

/**
 * Records the assignments an EVALUATED-ONLY expression PERFORMS, and
 * nothing else.
 *
 * {@link markLocallyReassigned} answers "which local bindings does this
 * assignment TARGET rebind?" and must therefore never look at a computed
 * key, a default initializer or an element-access index. But those
 * expressions still RUN, and one of them may itself contain an
 * assignment:
 *
 * ```js
 * ({ [(bail = safe)]: x } = source);   // `x` AND `bail` are rebound
 * ({ x = (bail = safe) } = source);    // `x` AND `bail` are rebound
 * holder[(bail = safe)] = value;       // `bail` is rebound
 * ```
 *
 * so this second traversal exists to catch exactly those. The two are
 * separate on purpose, and collapsing them in EITHER direction is a
 * defect:
 *
 * - walking every child and recording every identifier is RWF-025's
 *   original defect — it made `({ [bail()]: x } = source)` record `bail`;
 * - not walking the evaluated expression at all misses a genuine
 *   reassignment and lets a stale throwing declaration be trusted.
 *
 * The rule that separates them: this walk descends through children only
 * to FIND assignment and update OPERATIONS, and collects names only from
 * their targets, via {@link markLocallyReassigned}. A bare identifier is
 * never collected — `bail = safe` records `bail` and not `safe`, and
 * `bail()` records nothing at all. A right-hand side is re-entered only to
 * find further nested assignments (`a = (b = safe)` records `a` and `b`).
 *
 * Function bodies are not descended into, exactly as
 * {@link reassignedModuleReachableNames}'s own walk does not: an
 * assignment that only runs when some function is CALLED is outside
 * RWF-016's module-evaluation reach model, and this relation does not
 * widen that model.
 */
function markAssignmentsInsideEvaluatedExpression(
  node: ts.Node,
  into: Set<string>,
): void {
  if (ts.isFunctionLike(node)) {
    return;
  }

  if (
    ts.isBinaryExpression(node) &&
    isAssignmentOperatorToken(node.operatorToken.kind)
  ) {
    // `=`, `+=`, `||=`, `??=`, ... — the same operator relation the
    // statement-level check uses, by SyntaxKind and never by text.
    markLocallyReassigned(node.left, into);
    markAssignmentsInsideEvaluatedExpression(node.right, into);
    return;
  }

  if (
    (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
    (node.operator === ts.SyntaxKind.PlusPlusToken ||
      node.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    markLocallyReassigned(node.operand, into);
    return;
  }

  ts.forEachChild(node, (child) =>
    markAssignmentsInsideEvaluatedExpression(child, into),
  );
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
 * against a `catch` clause's own parameter, a FUNCTION-LIKE scope's own
 * parameters and self-name, a `for`/`for..of`/`for..in` loop's own
 * declaration, and — for every other scope-bearing ancestor — that
 * scope's OWN statement list (never a further-nested block's, which the
 * walk will visit on its own next iteration).
 *
 * The function-like case was added by RWF-028's remediation, and the
 * reason it was not needed before is worth recording: until RWF-028 this
 * walk only ever started at a MODULE-SCOPE call site, so a function-like
 * node could never be one of the ancestors it visited. RWF-028's wrapper
 * analysis is the first consumer that resolves an identifier from INSIDE
 * a function body, and without this case the walk stepped straight over
 * the function boundary out to module scope:
 *
 * ```js
 * function bail() { throw new Error("boom"); }
 * function w(bail) { bail(); }   // the PARAMETER, not the outer callable
 * w(safeFn);                     // ...so this completes
 * ```
 *
 * Resolving that body's `bail()` to the outer, throwing `bail` withdrew a
 * later export's authority from a module that runs to completion — a
 * false AFFECTED. The fix belongs here, at the shared lexical-declaration
 * boundary, rather than in the wrapper resolver: every consumer of this
 * walk asks the same question, and a wrapper-specific name check would
 * leave the abstraction wrong for the next one.
 *
 * Note what this case does and does NOT do. It makes a parameter a
 * SHADOWING BARRIER — ancestor lookup stops, and the answer is
 * `undefined` — and nothing more. A parameter is never itself an exact
 * callable: this relation does not map call-site arguments onto
 * parameters, so `function w(bail) { bail(); } w(realThrower);` is
 * refused rather than proven, which is the same answer base gives and the
 * only sound one without interprocedural value flow.
 */
function scopeDeclares(ancestor: ts.Node, name: string): boolean {
  if (ts.isFunctionLike(ancestor)) {
    for (const parameter of ancestor.parameters) {
      if (bindingNameIncludes(parameter.name, name)) {
        return true;
      }
    }
    // A named function EXPRESSION binds its own name inside its own body
    // and nowhere else: in `const w = function bail() { bail(); }` the
    // inner `bail` is the function expression itself. This is reached
    // only for an ancestor of the call site, so the name cannot leak to
    // surrounding code — `const w = function f() {}; f();` never visits
    // the expression at all and still resolves nothing.
    //
    // A function DECLARATION is deliberately absent: its name belongs to
    // the ENCLOSING scope's statement list, which the generic path below
    // already reads, and claiming it here too would change nothing except
    // to blur where the binding actually lives.
    if (ts.isFunctionExpression(ancestor) && ancestor.name?.text === name) {
      return true;
    }
  }
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
 * RWF-016 accepted only a plain identifier callee bound DIRECTLY to a
 * function/arrow. RWF-028 widens the IDENTITY half — and only that half —
 * to the bounded alias, object-member and lexical-shadow provenance forms
 * {@link resolveInvocationTargetIdentity} documents. The `async`/generator
 * exclusion below, and every caller's proof obligation above it, are
 * unchanged.
 */
function resolveExactLocalCallable(
  callee: ts.Expression,
):
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | undefined {
  const candidate = resolveInvocationTargetIdentity(callee);
  if (candidate === undefined || isAsyncOrGeneratorCallable(candidate)) {
    return undefined;
  }
  return candidate;
}

/**
 * The IDENTITY half of {@link resolveExactLocalCallable}'s proof, without
 * its `async`/generator exclusion — factored out by RWF-022, which needs
 * the same "this call site provably invokes exactly THIS function node"
 * answer for a callee that RWF-016 has to refuse.
 *
 * The three identity proofs are unchanged and shared verbatim: no real
 * lexical shadow between the call site and the file ({@link scopeDeclares}),
 * never reassigned within the modeled reach
 * ({@link reassignedModuleReachableNames}), and a supported module-top-level
 * callable shape actually exists ({@link topLevelCallableCandidates}).
 *
 * The `async`/generator exclusion is NOT part of identity — it is a
 * statement about what CALLING the resolved function does, and the two
 * callers want opposite answers to it:
 *
 * - RWF-016's {@link cannotCompleteNormally} asks "can this call itself
 *   throw?", and for `async`/generator the answer is provably NO (a
 *   rejected promise, an unstarted generator), so it must refuse;
 * - RWF-022's {@link classifyExactCallReturnValue} asks "what does this
 *   call RETURN?", and for `async`/generator the answer is provably a
 *   `Promise` / generator object — neither of which is a constructor —
 *   so it is exactly the case it can decide most cheaply.
 *
 * Keeping the exclusion in the wrapper rather than here is what stops the
 * two questions from being conflated: {@link resolveExactLocalCallable}'s
 * behavior, and therefore every RWF-016/017/018/019/020 answer, is
 * bit-for-bit what it was.
 */
function resolveExactLocalCallableIdentity(
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

  return topLevelCallableCandidates(sourceFile).get(name);
}

/* ------------------------------------------------------------------ *
 * RWF-028: bounded invocation / provenance resolution                  *
 * ------------------------------------------------------------------ */

/** The three callable node shapes this whole file is willing to read a body out of. */
type LocalCallable =
  ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/**
 * How many PROVENANCE hops RWF-028 will follow from a call site to the
 * callable it invokes.
 *
 * One. `const alias = bail; alias()` is one hop; `const h = { bail };
 * h.bail()` is one hop through the literal's property. A second hop
 * (`const a2 = alias; a2()`, `const h = { bail: alias }`) is refused.
 *
 * The bound is not arithmetic caution — it is what keeps every supported
 * form a SHAPE this relation can name and invalidate (see
 * {@link resolveInvocationTargetIdentity}'s invalidation table). Chains
 * are where alias analysis turns into points-to analysis, and this task
 * is explicitly scoped not to build one.
 */
const MAX_PROVENANCE_HOPS = 1;

/**
 * The exact local function node an invocation `callee(...)` or
 * `new callee(...)` provably enters (RWF-028) — `undefined` for
 * everything this relation will not commit to.
 *
 * RWF-016 answered this for exactly one shape: a plain identifier bound
 * at module top level directly to a function. The P0 closure inventory
 * found five confirmed false `NOT_AFFECTED`s where the analyzer ALREADY
 * had the callee-side proof (a callable whose every path throws) and
 * dropped it purely because the invocation SHAPE was not that one. The
 * shapes added here are exactly those, and no more:
 *
 * ```text
 * bail()        direct           RWF-016, unchanged
 * alias()       C07  one-hop immutable local alias
 * viaHelper()   C08  a wrapper — resolved here as a plain call; the
 *                    wrapper reasoning lives in callableAlwaysThrows
 * h.bail()      C09  exact local object-literal member
 * { bail() }    C10  nearest-lexical-binding resolution, incl. shadows
 * new bail()    E01  construct — see isDefinitelyAbruptInvocation
 * ```
 *
 * Every form carries its own invalidation story, and a form whose story
 * cannot be discharged is refused rather than guessed:
 *
 * | form   | invalidated by                                              |
 * |--------|-------------------------------------------------------------|
 * | direct | reassignment of the name ({@link reassignedModuleReachableNames}) |
 * | alias  | reassignment of the ALIAS name, or of the SOURCE name        |
 * | member | reassignment of the object binding, ANY non-call use of it (which could mutate the property), a spread, a computed key, a duplicate key, or a non-data property |
 * | shadow | ordinary lexical scoping — the nearest binding wins, and an unsupported nearest binding refuses outright |
 *
 * What is deliberately NOT resolved, because none of it has a bounded
 * invalidation story this relation can state: multi-hop chains,
 * `obj.a.b()`, computed members (`h[key]()`), `bail.bind(...)`,
 * conditional initializers (`cond ? bail : safe`), destructured bindings,
 * imports, class constructors, prototypes, and anything reached through a
 * parameter or a closure.
 */
function resolveInvocationTargetIdentity(
  callee: ts.Expression,
): LocalCallable | undefined {
  const unwrapped = unwrapParentheses(callee);

  if (ts.isIdentifier(unwrapped)) {
    return resolveIdentifierCallable(
      unwrapped,
      unwrapped.text,
      MAX_PROVENANCE_HOPS,
    );
  }

  if (
    ts.isPropertyAccessExpression(unwrapped) &&
    !ts.isOptionalChain(unwrapped) &&
    ts.isIdentifier(unwrapped.expression) &&
    ts.isIdentifier(unwrapped.name)
  ) {
    return resolveObjectMemberCallable(
      unwrapped.expression,
      unwrapped.name.text,
      MAX_PROVENANCE_HOPS,
    );
  }

  return undefined;
}

/**
 * The callable an identifier `name`, READ FROM `from`'s position,
 * provably denotes (RWF-028).
 *
 * Resolution is ordinary JavaScript lexical scoping, walking outward from
 * `from`: the NEAREST scope that declares `name` decides, and if what it
 * declares is not a shape this relation supports, the answer is
 * `undefined` — never "keep looking further out". That last clause is the
 * whole point of C10's safe-shadow control:
 *
 * ```js
 * function bail() { throw new Error("boom"); }   // outer, throwing
 * { const bail = () => "safe"; bail(); }         // inner, SAFE -- wins
 * ```
 *
 * Resolving that call to the outer, throwing `bail` would be a false
 * AFFECTED invented out of a name collision. RWF-016 avoided it by
 * refusing any shadowed name outright ({@link scopeDeclares}); this
 * resolves the shadow properly instead, which is what lets the mirrored
 * case — an inner THROWING shadow, C10 itself — be proven at all.
 */
function resolveIdentifierCallable(
  from: ts.Node,
  name: string,
  hops: number,
): LocalCallable | undefined {
  const sourceFile = from.getSourceFile();

  // RWF-025's reassignment facts, consulted first and for every hop: a
  // name assigned anywhere module-reachable has no single value this
  // relation may speak about, whatever its declaration says.
  if (reassignedModuleReachableNames(sourceFile).has(name)) {
    return undefined;
  }

  for (
    let ancestor: ts.Node | undefined = from.parent as ts.Node | undefined;
    ancestor !== undefined && !ts.isSourceFile(ancestor);
    ancestor = ancestor.parent as ts.Node | undefined
  ) {
    if (scopeDeclares(ancestor, name)) {
      const statements = ownStatementsOf(ancestor);
      if (statements === undefined) {
        // A `catch` parameter or a `for` loop binding: declared here, and
        // bound to something this relation cannot read a body out of.
        return undefined;
      }
      return callableFromStatements(statements, name, hops);
    }
  }

  // Module top level. The RWF-016 candidate map answers first and is
  // untouched, so every pre-RWF-028 answer is bit-for-bit what it was;
  // alias provenance is consulted only where that map had nothing.
  const direct = topLevelCallableCandidates(sourceFile).get(name);
  if (direct !== undefined) {
    return direct;
  }
  return callableFromStatements(sourceFile.statements, name, hops, true);
}

/**
 * The callable `name` is bound to by ONE statement list — a block, a
 * `case` clause, or the module's own top level (RWF-028).
 *
 * `aliasOnly` is set for the module top level, where
 * {@link topLevelCallableCandidates} has already answered the direct-
 * callable question and only alias provenance is still open.
 *
 * Any ambiguity refuses: two statements binding the same name, a
 * `let`/`var`/destructured binding, a class, an import, or an initializer
 * that is neither a function nor a bare identifier. A `const` bound to a
 * bare identifier is the alias hop, and it is spent here.
 */
function callableFromStatements(
  statements: readonly ts.Statement[],
  name: string,
  hops: number,
  aliasOnly = false,
): LocalCallable | undefined {
  let found: LocalCallable | ts.Identifier | undefined;

  for (const statement of statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === name &&
      statement.body !== undefined
    ) {
      if (found !== undefined || aliasOnly) {
        return undefined;
      }
      found = statement;
      continue;
    }
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      return undefined;
    }
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    if (!declarationListDeclares(statement.declarationList, name)) {
      continue;
    }
    // A `let`/`var` binding can be rebound by a later `=` this relation
    // may not have modeled at all (only module-reachable assignments are
    // collected), so only `const` is ever readable here.
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return undefined;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== name
      ) {
        // A destructured binding that mentions `name`: bound to something
        // no shape test here can read.
        return undefined;
      }
      if (declaration.initializer === undefined || found !== undefined) {
        return undefined;
      }
      const initializer = unwrapParentheses(declaration.initializer);
      if (
        ts.isFunctionExpression(initializer) ||
        ts.isArrowFunction(initializer)
      ) {
        if (aliasOnly) {
          return undefined;
        }
        found = initializer;
      } else if (ts.isIdentifier(initializer)) {
        found = initializer;
      } else {
        return undefined;
      }
    }
  }

  if (found === undefined) {
    return undefined;
  }
  if (!ts.isIdentifier(found)) {
    return found;
  }
  // The alias hop. `const alias = bail;` — resolved from the INITIALIZER's
  // own position, so the source name is looked up in the scope the alias
  // declaration actually sees, not in the caller's.
  if (hops <= 0) {
    return undefined;
  }
  return resolveIdentifierCallable(found, found.text, hops - 1);
}

/**
 * The callable `receiver.property(...)` provably invokes, when `receiver`
 * is an exact local `const` bound to an OBJECT LITERAL this file's own
 * text can read the property out of (RWF-028's C09) — `undefined`
 * otherwise.
 *
 * This is emphatically NOT member resolution in general: there is no
 * heap, no points-to set, no prototype chain and no property-type
 * reasoning. It is one literal, read literally, under four conditions
 * that between them make the property's value a fact rather than a guess:
 *
 * 1. the receiver is a plain identifier that resolves — by ordinary
 *    lexical scoping — to a `const` whose initializer IS an object
 *    literal, and that name is not reassigned module-reachably;
 * 2. the literal has no spread and no computed key, either of which could
 *    contribute or overwrite the property without naming it
 *    ({@link objectLiteralIsReadable});
 * 3. the receiver binding is CONFINED ({@link confinedObjectBindings}) —
 *    every occurrence of the name in the whole file is either its own
 *    declaration or a plain `h.x` read, so nothing in the file can mutate
 *    the property or hand the object to something that would;
 * 4. the property resolves to exactly one data value in SOURCE ORDER,
 *    last write winning, exactly as the language builds the object.
 *
 * Condition 3 is the one worth dwelling on, because it is what a
 * "bounded" member rule usually gets wrong. `const h = { bail };
 * mutate(h); h.bail();` really can complete normally — `mutate` is free
 * to install a safe function — and no amount of reading the literal will
 * show it. Rather than model mutation, this refuses the instant the
 * binding is used in any way that could lead to mutation, including
 * merely being passed somewhere.
 */
function resolveObjectMemberCallable(
  receiver: ts.Identifier,
  property: string,
  hops: number,
): LocalCallable | undefined {
  const sourceFile = receiver.getSourceFile();
  if (reassignedModuleReachableNames(sourceFile).has(receiver.text)) {
    return undefined;
  }
  if (!confinedObjectBindings(sourceFile).has(receiver.text)) {
    return undefined;
  }

  const literal = resolveObjectLiteralBinding(receiver, receiver.text);
  if (literal === undefined || !objectLiteralIsReadable(literal)) {
    return undefined;
  }

  return objectLiteralPropertyCallable(literal, property, hops);
}

/**
 * The object literal an identifier is `const`-bound to, by the same
 * nearest-scope-wins walk {@link resolveIdentifierCallable} uses
 * (RWF-028). Deliberately a separate, smaller walk rather than a
 * generalised binding resolver: this asks only about one initializer
 * shape, and an unsupported nearest binding refuses instead of looking
 * further out.
 */
function resolveObjectLiteralBinding(
  from: ts.Node,
  name: string,
): ts.ObjectLiteralExpression | undefined {
  const statementsFor = (scope: ts.Node): readonly ts.Statement[] | undefined =>
    ownStatementsOf(scope);

  let statements: readonly ts.Statement[] | undefined;
  for (
    let ancestor: ts.Node | undefined = from.parent as ts.Node | undefined;
    ancestor !== undefined && !ts.isSourceFile(ancestor);
    ancestor = ancestor.parent as ts.Node | undefined
  ) {
    if (scopeDeclares(ancestor, name)) {
      statements = statementsFor(ancestor);
      if (statements === undefined) {
        return undefined;
      }
      break;
    }
  }
  statements ??= from.getSourceFile().statements;

  let found: ts.ObjectLiteralExpression | undefined;
  for (const statement of statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return undefined;
    }
    if (
      !ts.isVariableStatement(statement) ||
      !declarationListDeclares(statement.declarationList, name)
    ) {
      continue;
    }
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
      return undefined;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== name
      ) {
        return undefined;
      }
      if (declaration.initializer === undefined || found !== undefined) {
        return undefined;
      }
      const initializer = unwrapParentheses(declaration.initializer);
      if (!ts.isObjectLiteralExpression(initializer)) {
        return undefined;
      }
      found = initializer;
    }
  }
  return found;
}

/**
 * Whether an object literal's own text determines its property set
 * (RWF-028).
 *
 * A spread (`{ ...other, bail }`) can contribute or be overwritten by
 * properties named nowhere in this literal, and a computed key
 * (`{ [k]: safe }`) can name one at runtime. Either makes "which value
 * does `.bail` hold" a question about something other than this literal,
 * so the whole literal is refused rather than a safe subset of it being
 * carved out by source-order reasoning that would have to be exactly
 * right to be worth anything.
 */
function objectLiteralIsReadable(literal: ts.ObjectLiteralExpression): boolean {
  return !literal.properties.some(
    (property) =>
      ts.isSpreadAssignment(property) ||
      (property.name !== undefined && ts.isComputedPropertyName(property.name)),
  );
}

/**
 * The callable an object literal's `property` holds, reading the literal
 * in SOURCE ORDER with the last write winning (RWF-028) — which is
 * exactly how the language builds the object, and is therefore the
 * behaviour of both duplicate-key controls:
 *
 * ```js
 * const h = { bail, bail: safe };   // .bail is SAFE      -- must refuse
 * const h = { bail: safe, bail };   // .bail is THROWING  -- may prove
 * ```
 *
 * Only a data property — shorthand, or `name: <function|identifier>` —
 * is readable. A getter, setter or method named the target REFUSES the
 * whole answer rather than being skipped over: an accessor runs code on
 * property READ, and a method is a node shape the rest of this file's
 * callable machinery does not take.
 */
function objectLiteralPropertyCallable(
  literal: ts.ObjectLiteralExpression,
  property: string,
  hops: number,
): LocalCallable | undefined {
  let resolved: LocalCallable | ts.Identifier | "unsupported" | undefined;

  for (const member of literal.properties) {
    const name = member.name;
    if (name === undefined) {
      continue;
    }
    const memberName =
      ts.isIdentifier(name) || ts.isStringLiteral(name)
        ? name.text
        : ts.isNumericLiteral(name)
          ? name.text
          : undefined;
    if (memberName !== property) {
      continue;
    }

    if (ts.isShorthandPropertyAssignment(member)) {
      resolved = member.name;
      continue;
    }
    if (ts.isPropertyAssignment(member)) {
      const value = unwrapParentheses(member.initializer);
      if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
        resolved = value;
      } else if (ts.isIdentifier(value)) {
        resolved = value;
      } else {
        resolved = "unsupported";
      }
      continue;
    }
    // A method, getter or setter carrying this name.
    resolved = "unsupported";
  }

  if (resolved === undefined || resolved === "unsupported") {
    return undefined;
  }
  if (!ts.isIdentifier(resolved)) {
    return resolved;
  }
  if (hops <= 0) {
    return undefined;
  }
  return resolveIdentifierCallable(resolved, resolved.text, hops - 1);
}

/**
 * The local object-binding names whose every occurrence in the file is a
 * use this relation can account for (RWF-028's condition 3 — see
 * {@link resolveObjectMemberCallable}).
 *
 * An occurrence is accounted for when it is:
 *
 * - the `name` of its own `const` declaration, or
 * - the RECEIVER of a plain `h.x` property access that is not itself
 *   being assigned to, deleted, or incremented.
 *
 * Everything else — being passed as an argument, returned, exported,
 * spread, closed over, assigned from, indexed with `h[k]`, or written
 * through with `h.x = ...` — disqualifies the name. The walk covers the
 * WHOLE file, function bodies included, because a closure that mutates
 * the object is exactly the case a module-reachable-only walk would miss:
 *
 * ```js
 * const h = { bail };
 * function patch() { h.bail = safe; }
 * patch();
 * h.bail();            // completes normally -- `h` must be disqualified
 * ```
 *
 * Names are compared as TEXT, so an unrelated binding spelled the same in
 * another scope disqualifies the object too. That is the conservative
 * direction and it costs only precision, which is why this does not need
 * the symbol table a real scope-accurate answer would.
 *
 * Cached per source file, and computed only when an object-member
 * invocation is actually being decided — which
 * {@link fileHasDefinitelyAbruptCallable} has already gated.
 */
const confinedObjectBindingsBySourceFile = new WeakMap<
  ts.SourceFile,
  ReadonlySet<string>
>();

function confinedObjectBindings(
  sourceFile: ts.SourceFile,
): ReadonlySet<string> {
  const cached = confinedObjectBindingsBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const declared = new Set<string>();
  const disqualified = new Set<string>();

  function visit(node: ts.Node): void {
    if (ts.isIdentifier(node)) {
      const parent = node.parent as ts.Node | undefined;
      if (parent !== undefined && !isAccountedObjectBindingUse(node, parent)) {
        disqualified.add(node.text);
      }
      if (
        parent !== undefined &&
        ts.isVariableDeclaration(parent) &&
        parent.name === node
      ) {
        declared.add(node.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  const confined = new Set<string>();
  for (const name of declared) {
    if (!disqualified.has(name)) {
      confined.add(name);
    }
  }

  confinedObjectBindingsBySourceFile.set(sourceFile, confined);
  return confined;
}

/** One occurrence's role, for {@link confinedObjectBindings}. */
function isAccountedObjectBindingUse(
  node: ts.Identifier,
  parent: ts.Node,
): boolean {
  if (ts.isVariableDeclaration(parent) && parent.name === node) {
    return true;
  }
  if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) {
    return false;
  }
  // `h.x` — accounted for only as a READ. A write, delete or update
  // through it changes the very property this relation wants to read.
  return !isWriteTargetPosition(parent);
}

/**
 * Whether `node` sits in a position that WRITES to whatever it denotes
 * (RWF-028).
 *
 * The direct forms are the obvious ones — `h.x = v`, `h.x ??= v`,
 * `h.x++`, `delete h.x`. The ones worth building a walk for are the
 * destructuring forms, because a write target can be nested arbitrarily
 * deep inside a pattern that is syntactically an object or array
 * LITERAL:
 *
 * ```js
 * ({ a: h.x } = source);       // writes h.x
 * [h.x] = values;              // writes h.x
 * ({ a: { b: h.x } } = source) // writes h.x
 * for (h.x of list) {}         // writes h.x, once per iteration
 * ```
 *
 * An earlier version of this test looked only at `node`'s immediate
 * parent and missed every one of those — `const h = { bail }; ({ a:
 * h.bail } = { a: safeFn }); h.bail();` was proven non-completing when it
 * completes perfectly well, which is a false AFFECTED invented by this
 * rule. Found by RWF-028's own self-review attack pass.
 *
 * So the walk climbs the pattern's own structure — parentheses and TS
 * type-only wrappers, array and object literals, property assignments and
 * spreads — and answers `true` only if it lands on something that is
 * actually an assignment. Climbing a literal proves nothing on its own:
 * `foo({ a: h.x })` and `const y = [h.x]` climb exactly the same nodes and
 * correctly answer `false`, because the walk ends at a call and a
 * declaration rather than at an assignment's left-hand side.
 */
function isWriteTargetPosition(node: ts.Node): boolean {
  let current: ts.Node = node;
  for (;;) {
    const parent = current.parent as ts.Node | undefined;
    if (parent === undefined) {
      return false;
    }

    if (
      ts.isBinaryExpression(parent) &&
      isAssignmentOperatorToken(parent.operatorToken.kind) &&
      parent.left === current
    ) {
      return true;
    }
    if (
      (ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
      parent.initializer === current
    ) {
      return true;
    }
    if (
      (ts.isPrefixUnaryExpression(parent) ||
        ts.isPostfixUnaryExpression(parent)) &&
      parent.operand === current
    ) {
      return true;
    }
    if (ts.isDeleteExpression(parent) && parent.expression === current) {
      return true;
    }

    // Structure a write target can legitimately be nested inside. Nothing
    // here is a decision — only the tests above decide — so climbing one
    // of these in a non-assignment context is harmless.
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isTypeAssertionExpression(parent) ||
      ts.isArrayLiteralExpression(parent) ||
      ts.isObjectLiteralExpression(parent) ||
      ts.isSpreadElement(parent) ||
      ts.isSpreadAssignment(parent) ||
      (ts.isPropertyAssignment(parent) && parent.initializer === current)
    ) {
      current = parent;
      continue;
    }

    return false;
  }
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
function classifyAbruptOutcome(
  statement: ts.Statement,
  depth: number,
): AbruptOutcome {
  if (ts.isThrowStatement(statement)) {
    return "throws";
  }
  if (ts.isReturnStatement(statement)) {
    return "returns";
  }
  // RWF-028's ONE addition to this relation: a bare call statement whose
  // callee this file's own text proves can only ever throw is an
  // uncaught abrupt completion of the enclosing body, exactly as a
  // literal `throw` written in its place would be. `depth` is what keeps
  // it bounded — see {@link callableAlwaysThrows}.
  if (
    ts.isExpressionStatement(statement) &&
    isDefinitelyAbruptInvocation(statement.expression, depth)
  ) {
    return "throws";
  }
  if (ts.isBlock(statement)) {
    return classifyAbruptSequence(statement.statements, depth);
  }
  if (ts.isIfStatement(statement)) {
    const thenOutcome = classifyAbruptOutcome(statement.thenStatement, depth);
    const elseOutcome = statement.elseStatement
      ? classifyAbruptOutcome(statement.elseStatement, depth)
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
    const tryOutcome = classifyAbruptSequence(
      statement.tryBlock.statements,
      depth,
    );
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
    return classifyAbruptSequence(
      statement.catchClause.block.statements,
      depth,
    );
  }
  if (ts.isLabeledStatement(statement)) {
    return classifyAbruptOutcome(statement.statement, depth);
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
  depth: number,
): AbruptOutcome {
  for (const statement of statements) {
    const outcome = classifyAbruptOutcome(statement, depth);
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
  return callableAlwaysThrows(fn, 0);
}

/**
 * How many CALLABLE BODIES deep {@link callableAlwaysThrows} will chase a
 * definitely-abrupt call before refusing (RWF-028).
 *
 * The number counts bodies entered, not calls written, and the budget is
 * spent as follows:
 *
 * ```text
 * bail();                    -- 1 body  (bail)                RWF-016, unchanged
 * viaHelper(); { bail(); }   -- 2 bodies (viaHelper -> bail)   one wrapper hop
 * h2(); { helper(); }        -- 3 bodies (h2 -> helper -> bail) two wrapper hops
 * h3(); { h2(); }            -- 4 bodies                        REFUSED
 * ```
 *
 * Two wrapper hops is a deliberate, documented bound rather than a
 * judgement about real code: each hop's proof is literally the same proof
 * (an exactly-resolved local callable whose every modeled path throws),
 * so admitting the second costs nothing in reasoning and the third buys
 * nothing that a bound has to be drawn somewhere anyway. What this is NOT
 * is an interprocedural summary fixpoint: there is no worklist, no
 * iteration to convergence, and no cross-file propagation — just a
 * counter that runs out, plus {@link callablesInProgress} to stop a
 * self- or mutually-recursive body from being chased at all.
 */
const MAX_CALLABLE_ABRUPT_SUMMARY_DEPTH = 3;

/**
 * The callable bodies {@link callableAlwaysThrows} is CURRENTLY inside.
 *
 * `function helper() { helper(); }` never completes, but it never throws
 * either — it exhausts the stack, and "recursion that does not terminate"
 * is exactly the nontermination reasoning {@link cannotCompleteNormally}
 * documents that it refuses to do. Re-entering a body already on this set
 * answers `false` outright, so a recursive or mutually-recursive callable
 * is refused on its own merits rather than accidentally proven by running
 * out of {@link MAX_CALLABLE_ABRUPT_SUMMARY_DEPTH} somewhere down the
 * chain.
 */
const callablesInProgress = new Set<ts.Node>();

/**
 * {@link cannotCompleteNormally}'s bounded recursive core (RWF-028).
 *
 * `depth` is the number of callable bodies already entered on the way
 * here; `0` is a call written at module scope. Everything else about the
 * proof is {@link classifyAbruptSequence}'s, unchanged: `async`/generator
 * callables and concise-bodied arrows are refused before a single
 * statement is read.
 */
function callableAlwaysThrows(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  depth: number,
): boolean {
  if (depth >= MAX_CALLABLE_ABRUPT_SUMMARY_DEPTH) {
    return false;
  }
  if (isAsyncOrGeneratorCallable(fn)) {
    return false;
  }
  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) {
    return false;
  }
  if (callablesInProgress.has(fn)) {
    return false;
  }
  callablesInProgress.add(fn);
  try {
    return classifyAbruptSequence(body.statements, depth + 1) === "throws";
  } finally {
    callablesInProgress.delete(fn);
  }
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
  return isDefinitelyAbruptInvocation(expression, 0);
}

/**
 * {@link isDefinitelyAbruptCall}'s depth-carrying form, and the ONE place
 * RWF-028 widens what counts as a definitely-abrupt invocation.
 *
 * Two invocation kinds are recognised, and each asks
 * {@link resolveInvocationTargetIdentity} the same question — "which
 * exact local function node does this syntax provably invoke?" — before
 * asking anything at all about what invoking it does:
 *
 * ```text
 * bail()        alias()      h.bail()       -- a CALL
 * new bail()    new alias()  new h.bail()   -- a CONSTRUCT
 * ```
 *
 * The two differ in exactly one way, and it is the reason they are not
 * collapsed: `[[Call]]` runs the body of anything callable, while
 * `[[Construct]]` exists only on a CONSTRUCTABLE function. An arrow,
 * an `async` function and a generator each have no `[[Construct]]` at
 * all, so `new` on one throws a `TypeError` WITHOUT EVER ENTERING THE
 * BODY — verified under real `node` v22 for all three. That is still a
 * non-completing module evaluation, but for a reason that has nothing to
 * do with the body this relation reads, so claiming it here would be
 * claiming a proof this relation did not perform. It is refused instead,
 * and recorded as a characterised limitation in
 * tests/validation/FINDINGS.md.
 *
 * `async`/generator are refused on the CALL side too, for RWF-016's own
 * reason ({@link isAsyncOrGeneratorCallable}): calling one returns a
 * rejected promise or an unstarted generator, never a synchronous throw.
 * That refusal is now reached through a resolver that also resolves
 * aliases and object members, so `const alias = asyncBail; alias();` is
 * refused by the same single test rather than by three separate ones.
 */
function isDefinitelyAbruptInvocation(
  expression: ts.Expression,
  depth: number,
): boolean {
  const unwrapped = unwrapParentheses(expression);

  if (ts.isCallExpression(unwrapped)) {
    const target = resolveExactLocalCallable(unwrapped.expression);
    if (target === undefined) {
      return false;
    }
    return callableAlwaysThrows(target, depth);
  }

  if (ts.isNewExpression(unwrapped)) {
    const target = resolveInvocationTargetIdentity(unwrapped.expression);
    if (target === undefined || !isConstructableCallable(target)) {
      return false;
    }
    return callableAlwaysThrows(target, depth);
  }

  return false;
}

/**
 * Whether `new fn()` would actually ENTER `fn`'s body (RWF-028).
 *
 * Only an ordinary, non-`async`, non-generator `function` — declaration
 * or expression — has a `[[Construct]]` internal method. Arrows, `async`
 * functions and generators do not, and `new` on one of them throws
 * `TypeError: X is not a constructor` before the body runs. Since
 * {@link resolveInvocationTargetIdentity} only ever returns one of those
 * three node kinds, this test is exact rather than approximate.
 */
function isConstructableCallable(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): boolean {
  return (
    (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn)) &&
    !isAsyncOrGeneratorCallable(fn)
  );
}

/**
 * Whether this file declares ANY module-top-level callable that
 * {@link cannotCompleteNormally} proves can only ever throw (RWF-026) —
 * the cheap per-file gate {@link necessarilyEvaluatesAbruptly} opens with.
 *
 * {@link isDefinitelyAbruptCall} can only ever answer `true` for a call
 * whose callee resolves to one of {@link topLevelCallableCandidates}'
 * entries, so a file with no always-throwing candidate provably has no
 * definitely-abrupt call ANYWHERE in it, in any expression position. That
 * makes this test exactly complete rather than merely close, and it is
 * what keeps RWF-026's recursion off the hot path: the expression walk
 * below is only ever entered for a file that has something for it to
 * find. On the scan-performance suite's worst case (9,001 top-level
 * statements of object literals and call expressions, none of them
 * throwing callables) it is one cached pass over `sourceFile.statements`
 * and an `O(1)` answer per expression thereafter.
 *
 * Cached per source file, like every other module-model fact.
 */
const hasDefinitelyAbruptCallableBySourceFile = new WeakMap<
  ts.SourceFile,
  boolean
>();

function fileHasDefinitelyAbruptCallable(sourceFile: ts.SourceFile): boolean {
  const cached = hasDefinitelyAbruptCallableBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  let found = false;
  for (const candidate of topLevelCallableCandidates(sourceFile).values()) {
    if (cannotCompleteNormally(candidate)) {
      found = true;
      break;
    }
  }
  if (!found) {
    found = moduleReachableCallableCandidates(sourceFile).some((candidate) =>
      cannotCompleteNormally(candidate),
    );
  }

  hasDefinitelyAbruptCallableBySourceFile.set(sourceFile, found);
  return found;
}

/**
 * Every callable RWF-028 can RESOLVE that lives in a module-reachable
 * statement scope — the top level included, and crucially the scopes
 * below it, which is where C10's block-scoped bindings live:
 *
 * ```js
 * { const bail = () => { throw new Error("boom"); }; bail(); }
 * ```
 *
 * {@link fileHasDefinitelyAbruptCallable}'s completeness argument is that
 * a file with no always-throwing candidate provably has no
 * definitely-abrupt call in it. RWF-028 made a second place a candidate
 * can live, so the gate has to look there too or it would short-circuit
 * C10 to `false` before any of the new resolution ran.
 *
 * The walk is the same cheap statement-position walk
 * {@link reassignedModuleReachableNames} uses, and stops at function
 * bodies for the same reason: a callable declared inside one is not a
 * module-reachable binding, and RWF-028 does not resolve into one.
 */
const moduleReachableCallableCandidatesBySourceFile = new WeakMap<
  ts.SourceFile,
  readonly LocalCallable[]
>();

function moduleReachableCallableCandidates(
  sourceFile: ts.SourceFile,
): readonly LocalCallable[] {
  const cached = moduleReachableCallableCandidatesBySourceFile.get(sourceFile);
  if (cached !== undefined) {
    return cached;
  }

  const found: LocalCallable[] = [];

  function collect(statements: readonly ts.Statement[]): void {
    for (const statement of statements) {
      if (ts.isFunctionDeclaration(statement) && statement.body !== undefined) {
        found.push(statement);
      } else if (
        ts.isVariableStatement(statement) &&
        (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
      ) {
        for (const declaration of statement.declarationList.declarations) {
          if (
            !ts.isIdentifier(declaration.name) ||
            declaration.initializer === undefined
          ) {
            continue;
          }
          const initializer = unwrapParentheses(declaration.initializer);
          if (
            ts.isFunctionExpression(initializer) ||
            ts.isArrowFunction(initializer)
          ) {
            found.push(initializer);
            continue;
          }
          // A callable written INLINE as an object-literal property value
          // is a shape {@link objectLiteralPropertyCallable} can return,
          // so the gate has to be able to see it too — otherwise whether
          // `h.run()` is provable would depend on some UNRELATED throwing
          // callable existing elsewhere in the file, which is precisely
          // the file-level inference this task must not make.
          if (ts.isObjectLiteralExpression(initializer)) {
            for (const property of initializer.properties) {
              if (!ts.isPropertyAssignment(property)) {
                continue;
              }
              const value = unwrapParentheses(property.initializer);
              if (ts.isFunctionExpression(value) || ts.isArrowFunction(value)) {
                found.push(value);
              }
            }
          }
        }
      }
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) {
      return;
    }
    const statements = ownStatementsOf(node);
    if (statements !== undefined) {
      collect(statements);
    }
    if (mayContainNestedStatements(node) || ts.isSourceFile(node)) {
      ts.forEachChild(node, visit);
    }
  }
  visit(sourceFile);

  moduleReachableCallableCandidatesBySourceFile.set(sourceFile, found);
  return found;
}

/**
 * How deep {@link necessarilyEvaluatesAbruptly} will recurse through
 * nested expression operands before REFUSING (RWF-026). Real source never
 * comes close — the TypeScript parser itself recurses over the same
 * nesting — and refusing is the sound direction, so this is a boundedness
 * guarantee rather than a semantic rule.
 */
const MAX_EXPRESSION_EVALUATION_DEPTH = 100;

/**
 * Whether NORMAL COMPLETION of `expression` — evaluated exactly where it
 * is written — REQUIRES first performing a call
 * {@link isDefinitelyAbruptCall} has already proven can only ever throw
 * (RWF-026).
 *
 * This is the one semantic addition RWF-026 makes, and it is deliberately
 * narrow: it does not widen WHICH calls can be proven abrupt (that stays
 * {@link isDefinitelyAbruptCall}'s exact-local-callee proof, RWF-016's,
 * shared verbatim and never re-derived here) — it widens only WHERE such
 * an already-proven call is necessarily evaluated.
 *
 * **The soundness rule, stated once.** An expression completes normally
 * only if every operand position the language REQUIRES it to evaluate
 * completes normally first. So if any REQUIRED operand cannot complete
 * normally, neither can the enclosing expression — and, crucially, that
 * conclusion needs no evaluation-ORDER model at all:
 *
 * ```js
 * safe() + bail()   // to complete, `safe()` AND `bail()` must both
 *                   // complete; `bail()` cannot; so the `+` cannot.
 * ```
 *
 * Either the earlier operand completed normally (so the abrupt one is
 * reached and throws) or it did not (so the expression never completes
 * either way). Both readings agree, which is why this predicate can be a
 * simple recursion over REQUIRED positions rather than an interpreter.
 * The same argument RWF-017's {@link declarationListCannotCompleteNormally}
 * already makes for a declarator list, generalised to operands.
 *
 * **"Required" is the entire content of this relation.** A position is
 * required only when the enclosing expression cannot complete normally
 * WITHOUT evaluating it. A `&&`'s right operand is not required (the
 * expression completes fine on a falsy left); a conditional's arms are not
 * required; a function or method BODY is not required (nothing here
 * invokes it). Every kind below is listed with which of its children are
 * required and which are refused, and an unlisted kind is refused
 * wholesale by the final `return false` — this relation is `true` only
 * where it has a proof, never `true` by omission.
 *
 * **Supported kinds, with the required positions for each:**
 *
 * ```text
 * (e)                        -- e                     (parentheses are transparent)
 * e as T | e satisfies T     -- e                     (TS type-only wrappers, erased at runtime)
 * e! | <T>e                  -- e
 * { k: e }                   -- every computed KEY, every property VALUE,
 *                               every SPREAD operand; NOT a method/accessor body
 * [e, , f]                   -- every element and spread operand; holes evaluate nothing
 * f(a, b)                    -- the CALLEE expression, then every ARGUMENT
 * new C(a)                   -- the constructor expression, then every ARGUMENT
 * `${e}`                     -- every substitution
 * tag`${e}`                  -- the TAG expression, then every substitution
 * e.x                        -- e            (the receiver; never the property name)
 * e[i]                       -- e, then i    (`i` refused inside an optional chain)
 * ...e                       -- e
 * a, b                       -- a and b      (a comma needs both to complete)
 * a + b, a === b, a in b ...  -- a and b     (every non-short-circuiting binary operator)
 * a && b | a || b | a ?? b   -- a ONLY       (b is not required -- see below)
 * c ? a : b                  -- c ONLY       (neither arm is required)
 * !e, -e, typeof e, void e,  -- e
 *   delete e, e++, ++e, await e
 * x = e                      -- the LHS REFERENCE's own sub-expressions, then e
 * x += e (and every other     -- the LHS REFERENCE's own sub-expressions, then e
 *   arithmetic/bitwise form)
 * x ||= e | x &&= e | x ??= e -- the LHS REFERENCE only; `e` is NOT required
 * ```
 *
 * **Explicitly refused, each for a stated reason:**
 *
 * - **A logical operator's RIGHT operand** (`flag && bail()`). It runs
 *   only for some values of the left operand, and this relation has no
 *   value semantics to decide which — so the expression CAN complete
 *   normally and no cutoff may be claimed.
 * - **A conditional expression's ARMS** (`flag ? bail() : safe()`, and
 *   `flag ? bail() : other()` alike). Neither arm is required. Joining two
 *   independently-abrupt arms into one proof is multi-path completion
 *   reasoning, deliberately out of scope here.
 * - **A logical ASSIGNMENT's right-hand side** (`z ||= bail()`). Same
 *   short-circuit as the logical operators: `||=`/`&&=`/`??=` evaluate the
 *   RHS only for some current values of the target.
 * - **Anything inside a FUNCTION** — a function expression, an arrow
 *   (concise body included), a method/getter/setter body, a default
 *   parameter. Writing one evaluates nothing; calling it is a decision
 *   made later, possibly by an importer, possibly never. This is the same
 *   line {@link mayEndModuleEvaluation} draws by stopping at every
 *   function-like node, and the reason `const f = () => bail();` and
 *   `function f(x = bail()) {}` keep a later export's authority.
 * - **A `class` expression's body.** Class-definition-time evaluation is
 *   RWF-018/019/020/022's, reached through
 *   {@link mayEndModuleEvaluation}'s own walk with their own predicates;
 *   folding it in here would duplicate those proofs with different
 *   semantics. In particular an INSTANCE field initializer
 *   (`class C { f = bail(); }`) is per-CONSTRUCTION, not module time, and
 *   is not reachable from this relation at all.
 * - **Positions guarded by an OPTIONAL CHAIN.** In `a?.b(bail())` and
 *   `a?.[bail()]` the argument and index are skipped entirely when `a` is
 *   nullish, so neither is required. The receiver of every link IS
 *   required and is still descended into. (`bail?.()` itself is a
 *   different matter and is already handled by
 *   {@link isDefinitelyAbruptCall}: the optional call short-circuits only
 *   on a nullish CALLEE, and {@link resolveExactLocalCallable} only ever
 *   resolves a hoisted function declaration or a never-reassigned
 *   `const`-bound function expression, neither of which can be nullish.)
 * - **A destructuring ASSIGNMENT TARGET** (`({ [k()]: x } = src)`). The
 *   pattern's own evaluation has semantics this relation does not model,
 *   and refusing it also keeps RWF-025's reassignment-provenance question
 *   — a different question about the same syntax — untouched.
 * - **Every other kind**, by the closing `return false`.
 *
 * Note what is NOT here: no constant folding, no value symbolisation, no
 * alias resolution, no member-callee resolution, no transitive call
 * summaries, no `new` -expression callee abruptness, no `ts.forEachChild`
 * "contains a call somewhere" shortcut. A generic child traversal would
 * happily walk into a `&&`'s right operand or an arrow's body and is
 * precisely the class of mistake this switch exists to make impossible.
 */
function necessarilyEvaluatesAbruptly(expression: ts.Expression): boolean {
  if (!fileHasDefinitelyAbruptCallable(expression.getSourceFile())) {
    return false;
  }
  return expressionCannotCompleteNormally(expression, 0);
}

function expressionCannotCompleteNormally(
  expression: ts.Expression,
  depth: number,
): boolean {
  if (depth > MAX_EXPRESSION_EVALUATION_DEPTH) {
    return false;
  }
  // The one place a proof is ESTABLISHED; everything below only decides
  // whether a child position is required. Handles its own parentheses.
  if (isDefinitelyAbruptCall(expression)) {
    return true;
  }

  const required = (child: ts.Expression): boolean =>
    expressionCannotCompleteNormally(child, depth + 1);

  // Evaluation-transparent wrappers: parentheses and TS's type-only forms,
  // none of which exist at runtime.
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isExpressionWithTypeArguments(expression)
  ) {
    return required(expression.expression);
  }

  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.some((property) => {
      if (ts.isSpreadAssignment(property)) {
        return required(property.expression);
      }
      // The computed KEY of ANY element form runs while the literal is
      // built, methods and accessors included — RWF-024's rule, reached
      // here for a literal nested inside a larger expression.
      if (
        property.name !== undefined &&
        ts.isComputedPropertyName(property.name) &&
        required(property.name.expression)
      ) {
        return true;
      }
      // The VALUE, and only for a property assignment: a method's,
      // getter's or setter's body is a function body and runs nothing
      // now. A shorthand (`{ x }`) is an identifier read.
      return (
        ts.isPropertyAssignment(property) && required(property.initializer)
      );
    });
  }

  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.some(
      (element) => !ts.isOmittedExpression(element) && required(element),
    );
  }

  if (ts.isSpreadElement(expression)) {
    return required(expression.expression);
  }

  if (ts.isCallExpression(expression)) {
    // The callee expression is evaluated before any argument is, whether
    // or not the call short-circuits.
    if (required(expression.expression)) {
      return true;
    }
    if (ts.isOptionalChain(expression)) {
      return false;
    }
    return expression.arguments.some(required);
  }

  if (ts.isNewExpression(expression)) {
    // ARGUMENTS are evaluated before construction begins, so an abrupt one
    // means the `new` never completes. Whether calling the CONSTRUCTOR
    // itself is abrupt is a different question this relation does not ask:
    // `new bail()` reaches only the identifier `bail` here, never a
    // `CallExpression`, and is correctly refused.
    if (required(expression.expression)) {
      return true;
    }
    return expression.arguments?.some(required) ?? false;
  }

  if (ts.isTemplateExpression(expression)) {
    return expression.templateSpans.some((span) => required(span.expression));
  }

  if (ts.isTaggedTemplateExpression(expression)) {
    // The tag is evaluated first, then every substitution — and all of
    // them before the tag is ever CALLED, which is why nothing needs to be
    // known about the tag function itself.
    if (required(expression.tag)) {
      return true;
    }
    return (
      ts.isTemplateExpression(expression.template) &&
      expression.template.templateSpans.some((span) =>
        required(span.expression),
      )
    );
  }

  if (ts.isPropertyAccessExpression(expression)) {
    // Only the RECEIVER; the property NAME is not an evaluated expression.
    // Sound inside an optional chain too: every link's receiver is
    // evaluated before that link can short-circuit.
    return required(expression.expression);
  }

  if (ts.isElementAccessExpression(expression)) {
    if (required(expression.expression)) {
      return true;
    }
    if (ts.isOptionalChain(expression)) {
      return false;
    }
    return required(expression.argumentExpression);
  }

  if (
    ts.isPrefixUnaryExpression(expression) ||
    ts.isPostfixUnaryExpression(expression)
  ) {
    return required(expression.operand);
  }

  if (
    ts.isTypeOfExpression(expression) ||
    ts.isVoidExpression(expression) ||
    ts.isDeleteExpression(expression) ||
    ts.isAwaitExpression(expression)
  ) {
    return required(expression.expression);
  }

  if (ts.isConditionalExpression(expression)) {
    // The CONDITION only. Neither arm is required — see this relation's
    // doc comment.
    return required(expression.condition);
  }

  if (ts.isBinaryExpression(expression)) {
    return binaryCannotCompleteNormally(expression, depth);
  }

  return false;
}

/**
 * {@link expressionCannotCompleteNormally} for a `BinaryExpression`, split
 * out because its three operator families have three different answers to
 * "which operand is required" (RWF-026).
 */
function binaryCannotCompleteNormally(
  expression: ts.BinaryExpression,
  depth: number,
): boolean {
  const required = (child: ts.Expression): boolean =>
    expressionCannotCompleteNormally(child, depth + 1);
  const operator = expression.operatorToken.kind;

  // Short-circuiting operators: the LEFT operand always runs, the right
  // one only for some left values this relation cannot know.
  if (
    operator === ts.SyntaxKind.AmpersandAmpersandToken ||
    operator === ts.SyntaxKind.BarBarToken ||
    operator === ts.SyntaxKind.QuestionQuestionToken
  ) {
    return required(expression.left);
  }

  if (isAssignmentOperatorToken(operator)) {
    // The TARGET REFERENCE is resolved before the right-hand side is
    // evaluated — `obj[bail()] = v` and `bail().x = v` both throw without
    // ever reaching the RHS — so its own sub-expressions are required for
    // every assignment form alike.
    if (assignmentReferenceCannotCompleteNormally(expression.left, depth)) {
      return true;
    }
    // LOGICAL assignment reads the target first and evaluates the RHS only
    // when that read says to: `z ||= bail()` never calls `bail` for a
    // truthy `z`. Not required, and not knowable here.
    if (
      operator === ts.SyntaxKind.AmpersandAmpersandEqualsToken ||
      operator === ts.SyntaxKind.BarBarEqualsToken ||
      operator === ts.SyntaxKind.QuestionQuestionEqualsToken
    ) {
      return false;
    }
    return required(expression.right);
  }

  // Everything else — arithmetic, comparison, bitwise, `instanceof`, `in`,
  // and the comma operator — evaluates BOTH operands unconditionally, so
  // either one being abrupt is enough (see the ordering note in
  // {@link necessarilyEvaluatesAbruptly}).
  return required(expression.left) || required(expression.right);
}

/**
 * The sub-expressions an ASSIGNMENT TARGET must itself evaluate in order
 * to produce a reference, and whether any of them is definitely abrupt
 * (RWF-026).
 *
 * ```text
 * z = v            -- an identifier target evaluates nothing
 * obj[bail()] = v  -- the index expression is required
 * bail().x = v     -- the receiver is required
 * ({ x } = src)    -- a destructuring PATTERN: refused wholesale
 * ```
 *
 * Refusing patterns is deliberate on both counts: their evaluation has
 * semantics this relation does not model, and RWF-025 asks a DIFFERENT
 * question about that same syntax (which names a destructuring assignment
 * genuinely reassigns) whose answer must not be perturbed from here.
 */
function assignmentReferenceCannotCompleteNormally(
  target: ts.Expression,
  depth: number,
): boolean {
  const unwrapped = unwrapParentheses(target);
  const required = (child: ts.Expression): boolean =>
    expressionCannotCompleteNormally(child, depth + 1);

  if (ts.isPropertyAccessExpression(unwrapped)) {
    return required(unwrapped.expression);
  }
  if (ts.isElementAccessExpression(unwrapped)) {
    return (
      required(unwrapped.expression) ||
      (!ts.isOptionalChain(unwrapped) && required(unwrapped.argumentExpression))
    );
  }
  return false;
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
      necessarilyEvaluatesAbruptly(declaration.initializer)
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
    necessarilyEvaluatesAbruptly(node.initializer)
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
 *   same node KIND in both. An object literal's computed key is now its
 *   own rule, {@link isDefinitelyAbruptComputedObjectLiteralKey} (RWF-024),
 *   evaluated by a different ECMAScript abstract operation (constructing an
 *   object, not defining a class) and kept structurally separate rather
 *   than merged into this one;
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
    necessarilyEvaluatesAbruptly(node.name.expression)
  );
}

/**
 * Whether `node` is an OBJECT LITERAL element whose COMPUTED PROPERTY NAME
 * necessarily invokes a definitely-abrupt local callee, so that evaluating
 * the enclosing object literal ends module evaluation rather than
 * completing (RWF-024).
 *
 * ```js
 * const o = { [bail()]: 1 };        // qualifies
 * const o = { [bail()]() {} };      // qualifies
 * const o = { get [bail()]() {} };  // qualifies
 * const o = { set [bail()](v) {} }; // qualifies
 * const o = { bail: 1 };            // does NOT qualify: not a computed key
 * const o = { [KEY]: 1 };           // does NOT qualify: not a call
 * ```
 *
 * **Why this is a different rule from RWF-019, not a widening of it.**
 * RWF-019's {@link isDefinitelyAbruptComputedClassElementKey} reads a
 * `ClassElement`'s computed name, evaluated by ClassDefinitionEvaluation as
 * part of defining a CLASS. This predicate reads the identically-shaped
 * `ObjectLiteralElementLike`'s computed name — `MethodDeclaration`,
 * `GetAccessorDeclaration` and `SetAccessorDeclaration` are the same node
 * KINDS whether they sit in a class body or an object literal, exactly the
 * fact RWF-019's own docs record — evaluated as part of the completely
 * different ECMAScript abstract operation that constructs an OBJECT: for
 * every property in an `ObjectLiteral`'s `PropertyDefinitionList`, in
 * source order, the computed key expression is evaluated and converted to a
 * property key BEFORE that property's value (or the method/getter/setter it
 * names) is defined on the new object. There is no class here at all, no
 * prototype chain, and no static/instance distinction to draw — an object
 * literal has exactly one "instance", the object being built right now, so
 * every computed key it writes runs immediately, unconditionally, every
 * time the literal is evaluated. A throw out of one propagates out of the
 * object literal, out of whatever statement is evaluating it, and — if
 * nothing catches it — out of the `require()` that started the load, exactly as a
 * class's computed-key throw does.
 *
 * Only the KEY is read here, deliberately mirroring RWF-019's own
 * static/instance-VALUE line: a `PropertyAssignment`'s VALUE
 * (`{ [safeKey()]: bail() }`) and a method/getter/setter's BODY are
 * evaluated in different positions and by different rules (a method/getter/
 * setter's body is deferred until called, exactly as a class method's is;
 * an ordinary property's value is a value-position gap this rule does not
 * claim to close — see the RWF-024 FINDINGS entry). `mayEndModuleEvaluation`'s
 * function-like stop still skips a method/getter/setter's BODY; this test is
 * asked before that stop for the same reason RWF-019's is, since a
 * `MethodDeclaration`/`GetAccessorDeclaration`/`SetAccessorDeclaration` IS
 * function-like.
 *
 * **Ordering needs no model**, for the same reason RWF-019 needed none:
 * {@link firstModuleEvaluationCutoff} records the enclosing top-level
 * STATEMENT's start, so which computed key throws — first, middle or last —
 * cannot change the answer. Keys evaluate in source order, every one of
 * them during this same object-literal construction, so
 * `{ [safe()]: 1, [bail()]: 2, [later()]: 3 }` needs no intra-literal
 * control-flow graph: the object literal does not complete either way, and
 * neither `later`'s key nor any property's VALUE after the abrupt key ever
 * runs.
 *
 * Scope is deliberately narrow, in the same three directions RWF-019 drew:
 *
 * - only a genuine `ts.ComputedPropertyName` counts, read off the AST.
 *   `{ "[bail()]": 1 }` is a string key and is not evaluated as code;
 * - only the element's parent being a genuine `ObjectLiteralExpression`
 *   counts — which is what excludes a class element's identically-kinded
 *   computed key (RWF-019's own shape) from this rule, and vice versa;
 * - only the key expression written DIRECTLY as that call qualifies, via
 *   {@link isDefinitelyAbruptCall} — the exact non-reassigned local callee
 *   ({@link resolveExactLocalCallable}), the always-throws body proof
 *   ({@link cannotCompleteNormally}), the `async`/generator exclusions and
 *   the parentheses normalization, all reused verbatim. `[foo(bail())]`,
 *   `` [`${bail()}`] `` and `[(bail(), "x")]` stay unrecognised, for the
 *   identical arbitrary-expression-evaluation reason RWF-017 recorded, and
 *   `[flag && bail()]` / `[flag ? bail() : "x"]` genuinely may not call
 *   `bail` at all.
 *
 * A caught object-literal-evaluation throw is handled by the existing
 * {@link isCaughtWithin} at the call site in {@link mayEndModuleEvaluation}:
 * `try { const o = { [bail()]: 1 }; } catch {}` keeps a later export's
 * authority, and a rethrowing `catch` withdraws it. An object literal built
 * inside a function/method/arrow body — including a deferred INSTANCE field
 * initializer's own nested object literal — is offered to this predicate
 * only if {@link mayEndModuleEvaluation}'s walk reaches it; the walk stops
 * at every function-like node before descending into a body, but does not
 * stop at a non-static `PropertyDeclaration`, which is the identical,
 * already-accepted over-approximation RWF-019 documents for a class nested
 * inside an instance field initializer (see this file's RWF-019 tests and
 * the RWF-024 FINDINGS entry) — erring toward UNKNOWN, never toward a false
 * negative proof.
 */
function isDefinitelyAbruptComputedObjectLiteralKey(node: ts.Node): boolean {
  return (
    ts.isObjectLiteralElementLike(node) &&
    node.name !== undefined &&
    ts.isComputedPropertyName(node.name) &&
    node.parent !== undefined &&
    ts.isObjectLiteralExpression(node.parent) &&
    necessarilyEvaluatesAbruptly(node.name.expression)
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
 * **The heritage VALUE is a SECOND, separate reason the class definition
 * can fail — RWF-022.** RWF-020 asks only whether evaluating the heritage
 * CALL itself completes. Whether the resulting value is a valid superclass
 * is a different semantic question, and three real cases turn on it — all
 * three measured, all three throwing a `TypeError` for a reason RWF-020
 * does not and must not claim:
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
 * RWF-020 left all three unanswered and recorded them as an open finding.
 * RWF-022 answers them, through
 * {@link isDefinitelyInvalidClassHeritageValue} — a SEPARATE disjunct
 * below, never a widening of {@link isDefinitelyAbruptCall}. The two
 * mechanisms are disjoint by construction and must stay that way: RWF-020
 * needs {@link cannotCompleteNormally} (a body that always throws), RWF-022
 * needs a body that always RETURNS, and no function is both. The
 * `async`/generator exclusion in {@link isAsyncOrGeneratorCallable} is
 * likewise read for opposite purposes by the two — see
 * {@link resolveExactLocalCallableIdentity} — which is why it stays in
 * `isDefinitelyAbruptCall`'s path and not in the shared identity proof.
 *
 * Everything about the CALL is RWF-016/017's, reused verbatim through
 * {@link isDefinitelyAbruptCall}: the exact non-reassigned local callee
 * ({@link resolveExactLocalCallable}), the always-throws body proof
 * ({@link cannotCompleteNormally}), the `async`/generator exclusions, and
 * the parentheses normalization that makes `extends (bail())` work.
 * `extends foo(bail())`, `extends (bail(), Base)`,
 * `extends (bail() || Base)`, `extends (flag && bail())`,
 * `extends (flag ? bail() : Base)` and `extends new Bail()` are all left
 * unrecognised at that same arbitrary-expression boundary. The first THREE
 * really do always evaluate `bail` — an argument is evaluated before the
 * call, a comma sequence evaluates its left operand, and so does `||`,
 * whose short-circuit decides only whether the RIGHT operand runs — so
 * those three are remaining soundness gaps. `flag && bail()` and
 * `flag ? bail() : Base` genuinely may not call it at all. Telling the two
 * groups apart needs the evaluation-order model
 * {@link isDefinitelyAbruptCall} deliberately does not have.
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
/**
 * What a class's `extends` value is, as far as ClassDefinitionEvaluation's
 * own validity check is concerned (RWF-022).
 *
 * The check the language performs is exactly three-way, and this domain
 * mirrors it rather than trying to describe the value in general:
 *
 * - `"valid-null"` — `extends null` is LEGAL and is its own case in the
 *   spec, not a degenerate constructor. It builds a class whose prototype
 *   chain terminates. Folding it in with "not a constructor" is the single
 *   most dangerous mistake available here, so it gets its own state;
 * - `"constructable"` — the value has a `[[Construct]]` internal method, so
 *   the class definition completes;
 * - `"non-constructable"` — the value is neither `null` nor a constructor,
 *   so ClassDefinitionEvaluation throws a `TypeError` and the class
 *   definition never completes;
 * - `"unknown"` — this model declines to say. The conservative default for
 *   everything not proven by node kind alone.
 *
 * Only `"non-constructable"` is actionable, and only as an input to
 * {@link isDefinitelyAbruptClassHeritage}. Nothing downstream may read a
 * VERDICT off this domain: it answers "does the class definition
 * complete?", never "is the package affected?".
 */
type HeritageValueClass =
  "unknown" | "valid-null" | "constructable" | "non-constructable";

/**
 * {@link HeritageValueClass} for a syntactic VALUE expression — the thing a
 * heritage position would receive (RWF-022).
 *
 * This is a flat table over node KINDS and nothing else. It performs no
 * name resolution, reads no binding, and evaluates no subexpression, which
 * is what keeps it from being the general value interpreter this task is
 * scoped not to build. Every row was executed under real `node` v26 in
 * fixtures/commonjs-circular-import-invalid-class-heritage-ground-truth/:
 *
 * ```text
 * 1  0  1n  "x"  `x`  true  false     -- non-constructable (TypeError)
 * {}  []                              -- non-constructable (TypeError)
 * () => {}                            -- non-constructable: an arrow has no
 *                                        [[Construct]], by construction
 * async function B() {}               -- non-constructable
 * function* B() {}                    -- non-constructable
 * async function* B() {}              -- non-constructable
 * null                                -- VALID: `class C extends null {}`
 * class B {}                          -- constructable
 * function B() {}                     -- constructable
 * Base   alias   obj.B   f()   -1     -- unknown: needs a binding, a member
 *                                        lookup, a call, or an operator
 * ```
 *
 * **Why an object/array literal is safe to call non-constructable even
 * though it can contain arbitrary subexpressions.** `{ a: foo() }` might
 * throw while being built. If it does, the enclosing CALL completes
 * abruptly, so the class definition does not complete either — which is
 * the same conclusion this classification feeds. Both readings agree, so
 * the classifier does not have to know which one holds. This is the
 * argument {@link declarationListCannotCompleteNormally} already makes for
 * its left-to-right declarator scan, reused. The same argument is what
 * admits a `TemplateExpression` with substitutions: it either produces a
 * string or throws.
 *
 * **Why `__proto__` in an object literal changes nothing.**
 * `{ __proto__: Function.prototype }` sets the object's PROTOTYPE, and
 * `[[Construct]]` is an internal method, not an inherited property — the
 * result is still not a constructor. Measured, because it is the one
 * object-literal shape that looks like it might not be.
 *
 * **Why the identifier `undefined` is NOT a row.** It is an ordinary
 * global reference and can be shadowed by a parameter, a `catch` binding
 * or a local declaration, and this classifier resolves no bindings. The
 * undefined VALUE is still reachable here, but only through shapes that
 * need no name at all — an empty body and a bare `return;` — which
 * {@link classifyExactCallReturnValue} handles directly.
 */
function classifyHeritageValueExpression(
  expression: ts.Expression,
): HeritageValueClass {
  const value = unwrapParentheses(expression);

  if (value.kind === ts.SyntaxKind.NullKeyword) {
    return "valid-null";
  }
  if (ts.isClassExpression(value)) {
    return "constructable";
  }
  if (ts.isFunctionExpression(value)) {
    // An `async` and/or generator function EXPRESSION has no
    // [[Construct]]; a plain one does.
    return isAsyncOrGeneratorCallable(value)
      ? "non-constructable"
      : "constructable";
  }
  if (ts.isArrowFunction(value)) {
    return "non-constructable";
  }
  if (
    ts.isNumericLiteral(value) ||
    ts.isBigIntLiteral(value) ||
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    ts.isTemplateExpression(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isObjectLiteralExpression(value) ||
    ts.isArrayLiteralExpression(value)
  ) {
    return "non-constructable";
  }
  return "unknown";
}

/**
 * {@link HeritageValueClass} for the value CALLING `fn` produces (RWF-022)
 * — where `fn` is a function node {@link resolveExactLocalCallableIdentity}
 * has already proven a given call site invokes.
 *
 * Two independent routes reach a decision, and they are deliberately
 * separate mechanisms rather than one widened rule:
 *
 * 1. **Callee IDENTITY decides it outright, with no body analysis at all.**
 *    Calling an `async` function returns a `Promise`; calling a generator
 *    function returns a generator object without running the body; an
 *    async generator returns an async generator object. None of the three
 *    is a constructor, and none of them depends on what the body says — so
 *    an `async`/generator callee is answered before the body is looked at.
 *
 *    This is the same syntactic fact RWF-016's
 *    {@link isAsyncOrGeneratorCallable} already establishes, used for a
 *    DIFFERENT question, and the distinction matters: RWF-016 reads it as
 *    "calling this cannot throw synchronously, so refuse"; RWF-022 reads
 *    it as "calling this returns a known non-constructor object, so
 *    decide". RWF-020's doc comment records exactly this split and
 *    declines to make it; this is where it is made.
 *
 * 2. **A single unconditional return of a value the node kind alone
 *    classifies** ({@link classifyHeritageValueExpression}). The supported
 *    body shapes are the ones that need no control-flow reasoning
 *    whatsoever:
 *
 * ```text
 * function f() { return 1; }   -- one statement, a `return` with a value
 * function f() { return; }     -- one statement, a bare `return` -> undefined
 * function f() {}              -- EMPTY body -> undefined
 * const f = () => 1;           -- concise arrow body IS the returned value
 *
 * function f(flag) {           -- refused: two statements, and the model
 *   if (flag) return 1;           has no reason to believe either path
 *   return Base;                  wins. `maybeBase()` is not definitely
 * }                                invalid, and must not be treated as such
 * function f() {               -- refused: one statement, but not a return
 *   doSomething();
 * }
 * function f() { "use strict"; return 1; }  -- refused: two statements
 * ```
 *
 * The refusals are the point. This is not a return-value ANALYSIS with a
 * narrow implementation; it is a narrow pattern that is either matched
 * exactly or declined, so there is no path by which a function with more
 * than one reachable ending is ever classified. In particular a body
 * containing a conditional, a loop, a `try`, or any second statement is
 * `"unknown"`, full stop — which is what keeps the "multiple returns"
 * family (test 12) and the RWF-020 "throwing callee" family off this
 * mechanism entirely.
 *
 * An overload signature or ambient declaration (no body) is `"unknown"`.
 */
function classifyExactCallReturnValue(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): HeritageValueClass {
  if (isAsyncOrGeneratorCallable(fn)) {
    return "non-constructable";
  }

  const body = fn.body;
  if (body === undefined) {
    return "unknown";
  }
  if (!ts.isBlock(body)) {
    return classifyHeritageValueExpression(body);
  }
  if (body.statements.length === 0) {
    return "non-constructable";
  }
  if (body.statements.length !== 1) {
    return "unknown";
  }
  const only = body.statements[0];
  if (only === undefined || !ts.isReturnStatement(only)) {
    return "unknown";
  }
  return only.expression === undefined
    ? "non-constructable"
    : classifyHeritageValueExpression(only.expression);
}

/**
 * One possible ending of an exact local callable used as a class's
 * `extends` heritage, in the RWF-027 sense: {@link HeritageValueClass}
 * widened with the one ending that produces no value at all.
 *
 * `"abrupt-throw"` means that path leaves the callable by `throw`, so the
 * heritage expression completes abruptly and the class definition never
 * begins. Every other member is the classification of the value that path
 * hands back to the `extends` position.
 */
type HeritageCompletionOutcome = HeritageValueClass | "abrupt-throw";

/**
 * The outcomes that stop a class definition from completing NORMALLY.
 *
 * These are the only two, and they fail the class definition for two
 * genuinely different reasons — which is precisely why RWF-020 and RWF-022
 * could not see the family RWF-027 addresses:
 *
 * - `"abrupt-throw"` — the heritage EXPRESSION completes abruptly, so
 *   ClassDefinitionEvaluation is never entered (RWF-020's reason);
 * - `"non-constructable"` — the heritage expression completes normally with
 *   a value that is neither `null` nor a constructor, so
 *   ClassDefinitionEvaluation itself throws a `TypeError` (RWF-022's).
 */
const CLASS_DEFINITION_FATAL_OUTCOMES: ReadonlySet<HeritageCompletionOutcome> =
  new Set<HeritageCompletionOutcome>(["abrupt-throw", "non-constructable"]);

/**
 * What executing a statement LIST to its end can do, in the bounded model
 * {@link collectHeritageExitOutcomes} implements (RWF-027).
 *
 * - `exits` — every ending that leaves the enclosing CALLABLE from inside
 *   this list: one entry per `return` reached and one `"abrupt-throw"` per
 *   `throw` reached. Duplicates are irrelevant; only membership is read.
 * - `fallsThrough` — whether control can reach the end of the list without
 *   having left the callable, so that whatever FOLLOWS the list runs. At
 *   the top level of a function body this is exactly the implicit
 *   `return undefined`, and it is represented explicitly rather than as an
 *   absent path — see {@link summarizeExactCallHeritageOutcomes}.
 */
type HeritageExitSet = {
  readonly exits: readonly HeritageCompletionOutcome[];
  readonly fallsThrough: boolean;
};

/**
 * How deep {@link collectHeritageExitOutcomes} will follow nested
 * `if`/block structure before refusing, and how many exits it will record
 * before refusing.
 *
 * Both are hard bounds, not heuristics: this task is scoped explicitly NOT
 * to build a general CFG or an interprocedural fixpoint, and a fixed
 * ceiling is what makes "bounded" checkable rather than asserted. Exceeding
 * either yields `undefined` — UNKNOWN — which can only ever cost precision.
 * Four levels covers `if` / `else if` / nested `if` shapes that occur in
 * real heritage factories; anything deeper is refused rather than
 * approximated.
 */
const HERITAGE_PATH_DEPTH_LIMIT = 4;
const HERITAGE_PATH_EXIT_LIMIT = 32;

/**
 * Every way executing `statements` can end, or `undefined` — UNKNOWN — the
 * instant any construct this bounded model does not fully understand is
 * reached (RWF-027).
 *
 * **The refusal is the mechanism, not an edge case.** A path this collector
 * silently dropped would be a path the caller then proves nothing about
 * while believing it has proved something about all of them, and dropping a
 * `return Base;` is exactly how an analyzer withdraws a CORRECT export.
 * So the statement kinds below are an allow-list, and everything absent
 * from it — every loop, `switch`, `try`/`catch`/`finally`, labeled
 * statement, `break`, `continue`, `with` — poisons the whole summary rather
 * than being skipped. Sound refusal is always available; a lost path is
 * not recoverable.
 *
 * ```text
 * return <expr>;   -- one exit, classified by node kind alone
 * return;          -- one exit: undefined, non-constructable
 * throw <expr>;    -- one exit: "abrupt-throw"
 * if (c) A else B  -- the union of both arms; a missing `else` is an arm
 *                     that falls through
 * { ... }          -- recursed into, at one more level of depth
 * foo();  x = 1;   -- neither exits nor is descended into (see below)
 * let x = ...;
 * function g() {}  -- SKIPPED, deliberately: see the boundary note
 * class K {}
 * ;                -- empty statement
 * debugger;
 * for/while/switch -- UNKNOWN, whole summary poisoned
 * try/label/break
 * ```
 *
 * **Why a plain expression or declaration statement is passed over rather
 * than analyzed.** It cannot leave the callable by `return`, and the only
 * other way it can end is by THROWING — which is already a
 * class-definition-fatal outcome. Ignoring it can therefore only ever omit
 * a fatal ending from a set the caller requires to be entirely fatal, which
 * cannot turn a completable heritage into a non-completing one. The same
 * argument covers the `if` CONDITION, the `return` operand and the `throw`
 * operand, none of which are examined either.
 *
 * **The function-scope boundary.** Nested `FunctionDeclaration`s and
 * `ClassDeclaration`s are skipped, and no expression is ever descended
 * into, so a `return` inside a nested function, method, accessor, class
 * static block or IIFE is structurally unable to be counted as an exit of
 * the OUTER callable. This is not a filter applied after the fact — the
 * collector walks statements only, and a nested body is only ever reachable
 * through an expression or a declaration it does not enter.
 */
function collectHeritageExitOutcomes(
  statements: readonly ts.Statement[],
  depth: number,
): HeritageExitSet | undefined {
  if (depth > HERITAGE_PATH_DEPTH_LIMIT) {
    return undefined;
  }

  const exits: HeritageCompletionOutcome[] = [];

  for (const statement of statements) {
    if (exits.length > HERITAGE_PATH_EXIT_LIMIT) {
      return undefined;
    }

    if (ts.isReturnStatement(statement)) {
      exits.push(
        statement.expression === undefined
          ? // `return;` hands back `undefined`, which is neither `null` nor
            // a constructor.
            "non-constructable"
          : classifyHeritageValueExpression(statement.expression),
      );
      return { exits, fallsThrough: false };
    }

    if (ts.isThrowStatement(statement)) {
      exits.push("abrupt-throw");
      return { exits, fallsThrough: false };
    }

    if (ts.isIfStatement(statement)) {
      const thenArm = collectHeritageExitOutcomes(
        ts.isBlock(statement.thenStatement)
          ? statement.thenStatement.statements
          : [statement.thenStatement],
        depth + 1,
      );
      if (thenArm === undefined) {
        return undefined;
      }

      let elseArm: HeritageExitSet = { exits: [], fallsThrough: true };
      if (statement.elseStatement !== undefined) {
        const collected = collectHeritageExitOutcomes(
          ts.isBlock(statement.elseStatement)
            ? statement.elseStatement.statements
            : [statement.elseStatement],
          depth + 1,
        );
        if (collected === undefined) {
          return undefined;
        }
        elseArm = collected;
      }

      exits.push(...thenArm.exits, ...elseArm.exits);
      if (!thenArm.fallsThrough && !elseArm.fallsThrough) {
        // Neither arm can reach the statement after the `if`, so the list
        // ends here and nothing following it is reachable.
        return { exits, fallsThrough: false };
      }
      continue;
    }

    if (ts.isBlock(statement)) {
      const nested = collectHeritageExitOutcomes(
        statement.statements,
        depth + 1,
      );
      if (nested === undefined) {
        return undefined;
      }
      exits.push(...nested.exits);
      if (!nested.fallsThrough) {
        return { exits, fallsThrough: false };
      }
      continue;
    }

    if (
      ts.isExpressionStatement(statement) ||
      ts.isVariableStatement(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isClassDeclaration(statement) ||
      ts.isEmptyStatement(statement) ||
      statement.kind === ts.SyntaxKind.DebuggerStatement
    ) {
      // Cannot leave the callable by `return`; may only throw, which is
      // already fatal for the class definition. Not descended into, which
      // is what keeps nested function/class bodies out of this summary.
      continue;
    }

    return undefined;
  }

  return { exits, fallsThrough: true };
}

/**
 * Every outcome calling `fn` can produce for a class's `extends` position,
 * or `undefined` — UNKNOWN (RWF-027).
 *
 * The returned array is never empty: a callable always ends somehow, and a
 * body that can run off its end ends by returning `undefined`. That
 * implicit ending is APPENDED EXPLICITLY here rather than being left as an
 * absent path, which is the whole reason `function f(flag) { if (flag)
 * return 1; }` can be answered at all — its two endings are `1` and
 * `undefined`, both non-constructable, and a model that recorded only the
 * written `return` would have seen one path where there are two.
 *
 * Two callee shapes are handed back to RWF-022 untouched rather than
 * summarized here, because RWF-022 already answers them exactly and this
 * mechanism must not compete for what an existing rule owns:
 *
 * - an `async` and/or generator callable, whose RESULT is decided by the
 *   callee's identity and never by its body — see
 *   {@link classifyExactCallReturnValue}'s route 1;
 * - a concise-bodied arrow (`const f = () => 1;`), which has no statement
 *   list to walk. RWF-027 adds no conditional-expression path model, so
 *   `flag => flag ? 1 : 2` stays exactly as unknown as it was.
 */
function summarizeExactCallHeritageOutcomes(
  fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): readonly HeritageCompletionOutcome[] | undefined {
  if (isAsyncOrGeneratorCallable(fn)) {
    return undefined;
  }

  const body = fn.body;
  if (body === undefined || !ts.isBlock(body)) {
    return undefined;
  }

  const collected = collectHeritageExitOutcomes(body.statements, 0);
  if (collected === undefined) {
    return undefined;
  }

  return collected.fallsThrough
    ? // Running off the end of a function body IS `return undefined`.
      [...collected.exits, "non-constructable"]
    : collected.exits;
}

/**
 * Whether evaluating `expression` in a class's `extends` position cannot
 * lead to a class definition that completes NORMALLY, because EVERY
 * analyzable ending of the exact local callable it invokes is
 * class-definition-fatal — some by throwing, some by handing back a value
 * that is not a valid base (RWF-027).
 *
 * **This is deliberately not "the call cannot complete normally".** Read
 * the canonical case:
 *
 * ```js
 * function maybe(flag) {
 *   if (flag) { throw new Error("boom"); }
 *   return 1;
 * }
 * class C extends maybe(FLAG) {}
 * ```
 *
 * With a falsy `FLAG` the CALL completes perfectly normally and returns
 * `1`. Nothing about `maybe` is abrupt, and asserting that it were would be
 * wrong — which is why `maybe(FLAG);` as a plain statement is untouched by
 * this rule and stays exactly as unknown as RWF-016 leaves it. What is
 * proven here is narrower and about the CLASS: evaluating this HERITAGE
 * cannot lead to a normally completed class definition, because the truthy
 * path throws before ClassDefinitionEvaluation begins and the falsy path
 * reaches it with `1`, which is neither `null` nor a constructor. Measured
 * under real `node`: both flag values abort the class definition, one with
 * `Error: boom` and one with
 * `TypeError: Class extends value 1 is not a constructor or null`.
 *
 * **Why RWF-020 and RWF-022 cannot see this between them.** RWF-020 needs
 * {@link cannotCompleteNormally} — a body that ALWAYS throws — and `maybe`
 * does not. RWF-022 needs {@link classifyExactCallReturnValue} — a body
 * with ONE unconditional ending — and `maybe` has two. Each rule inspects a
 * property no single path of `maybe` has, while the class-definition
 * failure is a property of the path set as a WHOLE. RWF-027 composes their
 * two fatality reasons across that set; it does not widen, weaken or
 * duplicate either rule, both of which remain exactly as they were and are
 * still consulted first as separate disjuncts of
 * {@link isDefinitelyAbruptClassHeritage}.
 *
 * **The decision.** Non-completion is proven only when the summary is
 * known, non-empty, and EVERY outcome in it is in
 * {@link CLASS_DEFINITION_FATAL_OUTCOMES}. One `"unknown"` refuses. One
 * `"valid-null"` refuses — `class C extends null {}` is legal and completes.
 * One `"constructable"` refuses. The asymmetry is the point: a single
 * surviving good path means the class definition CAN complete, the later
 * export CAN run, and withdrawing its authority would be an overreach that
 * this rule must never commit.
 *
 * ```text
 * throw + 1          -- proven: both endings fatal
 * 1 + 2              -- proven
 * 1 + implicit undefined -- proven
 * throw + throw      -- proven (RWF-020 already had it; unchanged answer)
 * 1 + null           -- REFUSED: `null` is a valid base
 * 1 + Base           -- REFUSED: `Base` is unknown, and may be a class
 * throw + Base       -- REFUSED: a completable path exists
 * 1 + helper()       -- REFUSED: a call operand is unknown
 * alias(FLAG)        -- REFUSED: not an exact local callable (RWF-028's)
 * ```
 */
function isDefinitelyNonCompletingClassHeritageCall(
  expression: ts.Expression,
): boolean {
  const unwrapped = unwrapParentheses(expression);
  if (
    !ts.isCallExpression(unwrapped) ||
    !ts.isIdentifier(unwrapped.expression)
  ) {
    return false;
  }

  const target = resolveExactLocalCallableIdentity(unwrapped.expression);
  if (target === undefined) {
    return false;
  }

  const outcomes = summarizeExactCallHeritageOutcomes(target);
  if (outcomes === undefined || outcomes.length === 0) {
    return false;
  }

  return outcomes.every((outcome) =>
    CLASS_DEFINITION_FATAL_OUTCOMES.has(outcome),
  );
}

/**
 * Whether evaluating `expression` in a class's `extends` position
 * necessarily produces a value that is neither `null` nor a constructor,
 * so that ClassDefinitionEvaluation throws a `TypeError` and the class
 * definition does not complete (RWF-022).
 *
 * Two heritage shapes are recognised, and they share one classifier:
 *
 * ```text
 * class C extends notAConstructor() {}   -- an exact local callable whose
 *                                           RETURN VALUE is classified
 * class C extends (notAConstructor()) {} -- parentheses are transparent
 * class C extends notAConstructor?.() {} -- see the optional-call note
 * class C extends 1 {}                   -- the heritage value is written
 * class C extends (() => {}) {}             DIRECTLY; same classifier,
 *                                           no call involved
 * class C extends alias() {}             -- refused: not an exact local
 * class C extends obj.make() {}             callable (no alias/member
 *                                           resolution is added here)
 * class C extends Base {}                -- refused: `unknown`, a binding
 * class C extends null {}                -- refused: VALID
 * class C extends makeBase() {}          -- refused: returns a class
 * ```
 *
 * **Why this is not RWF-020 with a wider net.** RWF-020 asks whether the
 * heritage CALL completes; this asks what the heritage VALUE is when the
 * call completes NORMALLY. The two are disjoint by construction —
 * `isDefinitelyAbruptCall` requires {@link cannotCompleteNormally}, which
 * requires the body to always throw, and every body shape accepted here
 * ends in a `return` or is empty. `function f() { throw e; }` is RWF-020's
 * and stays RWF-020's; this mechanism classifies it `"unknown"` and never
 * competes for it.
 *
 * **Optional call.** `notAConstructor?.()` needs no special case, for the
 * same reason RWF-020 records: the optional call short-circuits only on a
 * nullish CALLEE, and {@link resolveExactLocalCallableIdentity} only ever
 * returns a hoisted function declaration or a never-reassigned
 * `const`-bound function/arrow — neither can be nullish at the call site,
 * so the call always happens and its value is always the classified one.
 *
 * **Callee identity is RWF-016's, unchanged.** The lexical-shadow walk,
 * the reassignment refusal (RWF-013/013b) and the top-level-candidate
 * shape test are shared verbatim through
 * {@link resolveExactLocalCallableIdentity}, so
 * `notAConstructor = () => Base;` anywhere in the modeled reach, or a
 * shadowing inner `function notAConstructor() { return Base; }`, refuses
 * here exactly as it refuses for RWF-016.
 */
function isDefinitelyInvalidClassHeritageValue(
  expression: ts.Expression,
): boolean {
  const unwrapped = unwrapParentheses(expression);

  if (ts.isCallExpression(unwrapped) && ts.isIdentifier(unwrapped.expression)) {
    const target = resolveExactLocalCallableIdentity(unwrapped.expression);
    return (
      target !== undefined &&
      classifyExactCallReturnValue(target) === "non-constructable"
    );
  }

  return classifyHeritageValueExpression(unwrapped) === "non-constructable";
}

function isDefinitelyAbruptClassHeritage(node: ts.Node): boolean {
  return (
    ts.isHeritageClause(node) &&
    node.token === ts.SyntaxKind.ExtendsKeyword &&
    node.parent !== undefined &&
    ts.isClassLike(node.parent) &&
    node.types.some(
      (type) =>
        necessarilyEvaluatesAbruptly(type.expression) ||
        isDefinitelyInvalidClassHeritageValue(type.expression) ||
        isDefinitelyNonCompletingClassHeritageCall(type.expression),
    )
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
    return necessarilyEvaluatesAbruptly(node.expression);
  }
  if (ts.isVariableStatement(node)) {
    return declarationListCannotCompleteNormally(node.declarationList);
  }
  // RWF-026's statement-HEADER positions. Each of these expressions is
  // evaluated by the act of reaching the statement, before any body or
  // clause of it can run, so an abrupt one ends module evaluation exactly
  // as a bare `bail();` would — and none of them needs any reasoning about
  // the statement's BODY, which is why no control-flow graph appears here.
  if (ts.isIfStatement(node) || ts.isSwitchStatement(node)) {
    return necessarilyEvaluatesAbruptly(node.expression);
  }
  if (ts.isWhileStatement(node)) {
    // The condition is evaluated BEFORE the first iteration, so reaching
    // the `while` is enough. A `do`/`while`'s condition is NOT: it runs
    // only after the body has completed, which would need body-completion
    // reasoning this relation does not have — so `ts.isDoStatement` is
    // deliberately absent here.
    return necessarilyEvaluatesAbruptly(node.expression);
  }
  if (ts.isForStatement(node)) {
    const initializer = node.initializer;
    if (initializer !== undefined) {
      const abruptInitializer = ts.isVariableDeclarationList(initializer)
        ? declarationListCannotCompleteNormally(initializer)
        : necessarilyEvaluatesAbruptly(initializer);
      if (abruptInitializer) {
        return true;
      }
    }
    // The test runs once before the first iteration; the INCREMENTOR does
    // not run until an iteration has completed, and a body that `break`s,
    // `throw`s or `return`s means it may never run at all. It is
    // deliberately not consulted.
    return (
      node.condition !== undefined &&
      necessarilyEvaluatesAbruptly(node.condition)
    );
  }
  if (ts.isForOfStatement(node) || ts.isForInStatement(node)) {
    // The right-hand side is evaluated before iteration begins — before
    // any iterator is obtained, and whether or not the loop ever runs a
    // body. Nothing about iterator protocol is modeled beyond that.
    return necessarilyEvaluatesAbruptly(node.expression);
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
 *
 * {@link ExportBinding.exportAttributionWithdrawn} marks it as this
 * refusal rather than an attributed export that merely happens to name no
 * callable (RWF-021). Nothing about TARGET attribution reads that flag —
 * an export this relation refused stays exactly as unattributable as it
 * was. It exists so that ROOT selection can tell "we declined to name the
 * exported callable" apart from "there is no exported callable", and widen
 * instead of dropping the root. See {@link entrypointRootCandidates}.
 */
function ambiguousWholeModuleExport(
  observed: ModuleExportsAssignment,
): ExportBinding {
  return {
    kind: "default",
    syntax: "commonjs",
    exportAttributionWithdrawn: true,
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
 * The reachability roots {@link entrypointRootCandidates} found: names to
 * match a graph node by, and exact function POSITIONS to match one by when
 * the callable has no name at all (RWF-003's anonymous export shape).
 *
 * Both are matched against the entrypoint file's own graph nodes by
 * src/analysis/verdict.ts's `entrypointSourceNodes`; neither is an
 * attribution, and nothing resolves a vulnerable target through either.
 */
export interface EntrypointRootCandidates {
  readonly names: ReadonlySet<string>;
  readonly locations: readonly SourceLocation[];
}

/**
 * The callable surface an entrypoint file can be entered through — the
 * reachability ROOTS for src/analysis/verdict.ts's
 * `entrypointSourceNodes` (RWF-021).
 *
 * **Root provenance is not export provenance, and conflating them is the
 * defect this exists to fix.** Those two questions look alike and are not:
 *
 * - *export attribution* asks "WHICH function is this module's exported
 *   value?", and its correct failure mode is to REFUSE. Naming a function
 *   the module might not export manufactures a target out of nothing, and
 *   RWF-011/013/014 are all fixes for having answered it too eagerly.
 * - *root selection* asks "which of this file's own functions might an
 *   outside caller invoke?", and its correct failure mode is to WIDEN.
 *   An entrypoint's exports are by definition callable from outside the
 *   analyzed codebase, so a root this file cannot pin down is a root that
 *   might be any of its top-level callables — not none of them.
 *
 * Before RWF-021 both questions were answered by the same expression
 * (`exp.localName ?? exp.exportedName`), so a soundness cutoff that
 * correctly withdrew ATTRIBUTION silently withdrew the ROOT too:
 *
 * ```js
 * const dep = require("vuln-lib");
 * function main(u) { return dep.dangerousOp(u); }   // the only path to the sink
 * function bail() { throw new Error("boom"); }
 * if (flag) { bail(); }        // RWF-016 cutoff -> authority withdrawn
 * module.exports = main;       // bypassable, so `localName` is refused
 * ```
 *
 * `main` stopped being a root, its body was never traversed, the sink
 * became unreachable, and the result was a **complete Family C proof and a
 * false NOT_AFFECTED** — for a module that, on every run where the branch
 * is not taken, really does export `main` and really does reach the sink.
 * Reproduced on `8d18130` for all four merged cutoff families (RWF-016's
 * bare call, RWF-017's variable initializer, RWF-018's static field and
 * RWF-019's computed key), and the same mechanism would have admitted
 * RWF-020's heritage clause as a fifth.
 *
 * **The rule.** Losing export precision must never shrink this set:
 *
 * - every export that still carries a name contributes it, exactly as
 *   before — the precise case is untouched, so a file whose export
 *   authority is intact widens nothing and costs nothing;
 * - an export whose attribution was WITHDRAWN
 *   ({@link ExportBinding.exportAttributionWithdrawn}) additionally
 *   contributes every callable this file's own EXPORT WRITES could
 *   publish — see {@link collectExportWriteCandidates}.
 *
 * The result is a superset of the precise answer by construction: names
 * and positions are only ever added. That is the monotonicity property
 * RWF-021 asserts directly in its tests.
 *
 * **Why export writes and not every top-level callable.** RWF-021's first
 * cut widened to `topLevelCallableCandidates`, and its audit showed that
 * to be strictly too broad: it rooted functions that no export write
 * mentions anywhere, which cannot be published on any run, and that
 * manufactured false AFFECTED findings. The eligible set is the values the
 * file's real `module.exports = X` / `exports.Y = X` writes could hand an
 * importer — bounded above by what the language can actually publish, and
 * still bounded below by every write, so nothing plausible is lost.
 *
 * A function nested inside another function's body is excluded by the same
 * rule rather than by a separate one — nothing assigns it to an export:
 *
 * ```js
 * function outer() { function hidden() { dep.dangerousOp(); } }
 * ```
 *
 * `hidden` is not a plausible exported value and is not rooted.
 *
 * **What this deliberately does NOT do.** It does not attribute anything:
 * no target resolves through a widened root, no evidence claims a widened
 * root is the export, and {@link mapExportsToFunctions} is untouched. It
 * does not resurrect name-only attribution (RWF-011) — a widened name is a
 * traversal start point, never an identity claim. It does not fall back to
 * an earlier write, a stale binding, a re-export's origin or another
 * PackageInstance. And it manufactures nothing: a file with an ambiguous
 * export and no top-level callables contributes no names, leaving the
 * module node as the only root, which keeps the honest UNKNOWN rather than
 * inventing a root to root.
 */
/**
 * Adds the callable candidates ONE export write's right-hand side could
 * publish, to the widened root set (RWF-021, narrowed by its own audit).
 *
 * This is the constraint that keeps widening honest. The first cut of
 * RWF-021 widened to every TOP-LEVEL CALLABLE in the file, which is a
 * strictly larger set than "the values this module's export writes can
 * publish" — and the difference is not academic. It rooted functions no
 * export write mentions anywhere, so a helper that merely happens to touch
 * a vulnerable dependency turned into a reported call path:
 *
 * ```js
 * function main(u) { return "safe:" + u; }               // the ONLY export
 * function neverExported(u) { return dep.dangerousOp(u); } // assigned to nothing
 * if (flag) { bail(); }
 * module.exports = main;
 * ```
 *
 * No run of that module can publish `neverExported`, so rooting it
 * manufactured a false AFFECTED. The rule below is the fix: a callable is
 * eligible only if some real export write could actually hand it to an
 * importer.
 *
 * What each right-hand-side shape contributes:
 *
 * - **a directly written function/arrow/class** (`module.exports =
 *   function (u) {...}`) — its exact POSITION, which is RWF-003's identity
 *   evidence and needs no name;
 * - **an identifier** (`module.exports = main`) — the name, unless
 *   {@link resolveLocalValue} REFUSES it. A refusal is RWF-013/013b's
 *   reassignment proof, and honouring it here is what stops the stale
 *   original from being rooted after `main = safe`;
 * - **an object literal** (`module.exports = { run: main }`) — each
 *   property's value, recursively, matching the precise path's own
 *   object-literal unpacking so withdrawal loses no root the intact case
 *   would have had;
 * - **anything else** — nothing. A `require(...)` re-export publishes
 *   another package, never a local callable, so no local root is invented
 *   from it; a non-callable value has no root to contribute.
 *
 * Bounded by construction: it reads the writes this file already collected
 * and resolves each right-hand side once, with no whole-file rescan and no
 * new symbol resolver.
 */
function collectExportWriteCandidates(
  index: SourceIndex,
  rhs: ts.Expression,
  names: Set<string>,
  locations: SourceLocation[],
): void {
  const value = unwrapValue(rhs);

  const direct = directValueFunctionLocation(index.sourceFile, value);
  if (direct) {
    locations.push(direct);
    return;
  }

  if (ts.isObjectLiteralExpression(value)) {
    for (const property of value.properties) {
      if (ts.isPropertyAssignment(property)) {
        collectExportWriteCandidates(
          index,
          property.initializer,
          names,
          locations,
        );
      } else if (ts.isShorthandPropertyAssignment(property)) {
        collectExportWriteCandidates(index, property.name, names, locations);
      }
    }
    return;
  }

  if (!ts.isIdentifier(value)) {
    return;
  }

  // RWF-013/013b's reassignment proof, reused verbatim and honoured here
  // exactly as attribution honours it: a name this file writes to is not a
  // stable alias for whatever it was declared as, so the DECLARATION is
  // not a plausible published value. Refusing rather than rooting the
  // stale node is what makes `main = safe; module.exports = main` stop
  // reporting the original `main`'s body.
  const resolved = resolveLocalValue(index, value);
  if (resolved.kind === "refused") {
    return;
  }

  names.add(value.text);
  if (resolved.kind === "value") {
    const chased = directValueFunctionLocation(
      index.sourceFile,
      resolved.value,
    );
    if (chased) {
      locations.push(chased);
    }
  }
}

export function entrypointRootCandidates(
  index: SourceIndex,
  model: ModuleModel,
): EntrypointRootCandidates {
  const names = new Set<string>();
  const locations: SourceLocation[] = [];
  let withdrawn = false;

  for (const exp of model.exports) {
    // Unchanged from before RWF-021, including the `exportedName`
    // fallback. For a ROOT that fallback is sound in the direction that
    // matters: landing on a same-name local that is not really the export
    // adds a traversal start point, and an extra root can only make more
    // code reachable. The same fallback was correctly REMOVED from
    // attribution by RWF-011, where landing on the wrong function
    // manufactures a false target — the asymmetry this function's doc
    // comment exists to explain.
    const name = exp.localName ?? exp.exportedName;
    if (name) {
      names.add(name);
    }
    // RWF-003's anonymous-callable evidence, which root selection never
    // consulted before RWF-021: `module.exports = function (u) { ... }`
    // has an exact function IDENTITY and no name at all, so a name-only
    // root lookup lost it even when attribution was fully precise.
    if (exp.localFunctionLocation) {
      locations.push(exp.localFunctionLocation);
    }
    if (exp.exportAttributionWithdrawn) {
      withdrawn = true;
    }
  }

  if (withdrawn) {
    // Every value this file's own export writes could publish — and
    // nothing else. See {@link exportWriteRootCandidates}.
    for (const assignment of collectModuleExportsAssignments(
      index.sourceFile,
    )) {
      collectExportWriteCandidates(index, assignment.rhs, names, locations);
    }
    for (const exp of model.exports) {
      if (exp.kind !== "named" || exp.syntax !== "commonjs") {
        continue;
      }
      const rhs =
        exp.exportedName === undefined
          ? undefined
          : commonJsPropertyExportRhs(index, exp.exportedName);
      if (rhs !== undefined) {
        collectExportWriteCandidates(index, rhs, names, locations);
      }
    }
  }

  return { names, locations };
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
