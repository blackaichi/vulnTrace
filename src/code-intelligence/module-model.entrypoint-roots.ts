/**
 * Entrypoint roots: the candidates an export's value makes roots of the call
 * graph, and what makes that set incomplete.
 *
 * Split out of `module-model.ts` by concern, as a pure move (task BL-121):
 * the declarations below are those of that file, unchanged and in its order.
 * `module-model.ts` re-exports the public ones.
 */
import ts from "typescript";
import type { SourceLocation } from "../domain/graph.js";
import {
  commonJsPropertyExportRhs,
  resolveLocalValue,
  resolveLocalValueByName,
  unwrapParentheses,
  unwrapValue,
  type LocalValueProvenance,
} from "./commonjs-reexports.js";
import {
  exactCommonJsExportPropertyName,
  type SourceIndex,
  toSourceLocation,
} from "./source-index.js";
import type { ExportBinding, ModuleModel } from "./module-model.js";
import {
  directValueFunctionLocation,
  classConstructorNode,
  declaredRootAt,
  evaluatedBeforeExport,
  nodeAtLocation,
  isInsideFunctionBody,
  canonicalExportName,
  provenanceNameLocations,
  mayBeCallableValue,
} from "./module-model.export-provenance.js";
import { collectModuleExportsAssignments } from "./module-model.export-bindings.js";

/**
 * The reachability roots {@link entrypointRootCandidates} found: names to
 * match a graph node by, and exact function POSITIONS to match one by when
 * the callable has no name at all (RWF-003's anonymous export shape).
 *
 * Both are matched against the entrypoint file's own graph nodes by
 * src/analysis/verdict.ts's `entrypointSourceNodes`; neither is an
 * attribution, and nothing resolves a vulnerable target through either.
 */
/**
 * Why {@link entrypointRootCandidates} could not turn a configured
 * entrypoint's exported behavior into concrete reachability roots (P0-Z).
 *
 * - `unresolved_entrypoint_reexport` — the entrypoint publishes an export
 *   whose value comes from ANOTHER module (`module.exports =
 *   require("./x")`, `module.exports.run = require("./x").run`,
 *   `export { run } from "./x"`, `export * from "./x"`). The callable an
 *   importer actually receives does not live in this file, and
 *   `entrypointSourceNodes` matches roots only among this file's own
 *   graph nodes, so no local node can stand for it.
 * - `unresolved_export_forwarding` — a call MUTATES the export object
 *   with values this model does not enumerate (`Object.assign(
 *   module.exports, require("./x"))`). The module model produces no
 *   export binding at all for this shape, so without an explicit signal
 *   it is indistinguishable from a file that exports nothing.
 * - `unresolved_computed_export_name` — the file publishes a value under a
 *   name that is not statically known (`module.exports[k] = run`). The
 *   callable is LOCAL and rootable in principle, but no export binding is
 *   produced for it, so it contributes no root and the file looks like one
 *   that exports nothing. An importer that knows the runtime name calls it
 *   perfectly well.
 * An entrypoint that cannot be PARSED is deliberately not a reason here:
 * that file is also a `ModuleLoadClosure` root, so the closure already
 * records `parse_failure` and `callGraphNegativeProofBlockers` already
 * blocks families B and C on it. Closure completeness and root-derivation
 * completeness are independent assumptions, and duplicating one inside the
 * other would blur which condition actually mattered.
 */
export type EntrypointRootIncompletenessReason =
  | "unresolved_entrypoint_reexport"
  | "unresolved_export_forwarding"
  | "unresolved_computed_export_name"
  /**
   * A root candidate that must denote a callable could not be MATERIALIZED
   * to an actual node (P0-Z round 3). Raised by `entrypointSourceNodes`,
   * which is the only place that can ask the question, since it alone
   * holds both the candidates and the call graph.
   */
  | "unresolved_entrypoint_root_candidate";

/** One concrete reason a configured entrypoint's root set is incomplete. */
export interface EntrypointRootIncompleteness {
  readonly reason: EntrypointRootIncompletenessReason;
  /** The module the exported value was forwarded from, when known. */
  readonly specifier?: string;
  /** The exported name affected, when the form names one. */
  readonly exportedName?: string;
  readonly location?: SourceLocation;
}

export interface EntrypointRootCandidates {
  /**
   * The names the candidates were written with -- for diagnostics only.
   * No root is looked up by them since task V-3 (PRM-25, PRM-31): a root is
   * a node at one of `locations`.
   */
  readonly names: ReadonlySet<string>;
  readonly locations: readonly SourceLocation[];
  /**
   * Whether every relevant exported root was either concretely derived or
   * positively proven irrelevant (P0-Z).
   *
   * THE DISTINCTION THIS EXISTS TO MAKE. Before P0-Z this result was just
   * `{names, locations}`, so an empty root set meant two different things
   * that must never be conflated:
   *
   * ```js
   * const x = 1;                              // no exported callable:
   *                                           //   nothing to root, COMPLETE
   * module.exports = require("./sibling.js"); // exports a callable this
   *                                           //   analyzer cannot root: INCOMPLETE
   * ```
   *
   * Both produced zero names. The second then let `analyzeReachability`
   * start effectively at the `<module>` node alone, meet no unresolved
   * edge, and report `unreachable` — which family C serialized as
   * `reachableSubgraphComplete: true`. The subgraph really was exhausted;
   * it was simply never ROOTED correctly, and the analyzer had no way to
   * say so. P0-Z reproduced this against runtime-reachable targets in
   * three rounds: six forms in the original audit, two more (a two-hop
   * chain and a dynamic computed export name) while remediating it, and a
   * final six -- every element-access CommonJS export spelling -- in the
   * focused re-audit, where the key was statically exact but
   * `describeCommonJsExportTarget` modeled only the dot form.
   *
   * Deliberately NOT expressed by emptying or widening `names`: this is
   * uncertainty about WHICH ROOT, not about which callable is the export,
   * and faking a root (or faking an unresolved call edge later) would put
   * the uncertainty at the wrong layer and lie in diagnostics. It is also
   * deliberately independent of `ModuleLoadClosure.complete`, which
   * answers a different question about a different traversal.
   */
  readonly complete: boolean;
  readonly incompleteness: readonly EntrypointRootIncompleteness[];
  /**
   * One entry per export binding that could publish a CALLABLE, listing
   * every alternative that would materialize it (P0-Z round 3).
   *
   * THE INVARIANT THIS EXISTS TO ENFORCE: a candidate name is not a root.
   * A root is a NODE. Before this, `entrypointRootCandidates` contributed
   * `exp.localName ?? exp.exportedName` and called the derivation
   * complete — but for `const alias = bad; module.exports.run = alias` the
   * contributed name is `alias`, while the only callable node is `bad`.
   * The name matched nothing, the entrypoint got no root beyond
   * `<module>`, and family C certified `reachableSubgraphComplete: true`
   * over a sink Node executes. Modeling the export was never the missing
   * piece; materializing the candidate was.
   *
   * A requirement is satisfied by ANY of its `locations`. Until task V-3
   * a NAME satisfied it too, by spelling, and a nested function sharing
   * the spelling of the exported local stood in for it (PRM-25, PRM-31):
   * each name is now resolved to the declaration it binds to at the
   * export's site, and that declaration's callable position is one of the
   * `locations`.
   *
   * Bindings that provably publish no callable (`module.exports.x = 42`)
   * emit NO requirement -- "there is no root here" stays a complete
   * answer, which is what keeps valid family C proofs alive.
   */
  readonly rootRequirements: readonly EntrypointRootRequirement[];
}

/** One export binding's materialization alternatives (P0-Z round 3). */
export interface EntrypointRootRequirement {
  /** The exported name, for diagnostics. */
  readonly exportedName?: string;
  /**
   * The name an importer binds the export by -- `"default"` for a default
   * or whole-module export, the exported name otherwise -- which a
   * configured `{file, symbol}` entrypoint selects by (task V-3).
   */
  readonly canonicalName?: string;
  /** The names the binding was written with, for diagnostics only. */
  readonly names: readonly string[];
  /**
   * The positions that materialize the binding: a function value's own,
   * and the callable each provenance name DECLARES at the export's site
   * (task V-3). The requirement is satisfied by a node at any of them, and
   * by nothing else -- a node that merely shares a name's spelling
   * satisfies nothing.
   */
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
  unresolved: SourceLocation[],
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
          unresolved,
        );
      } else if (ts.isShorthandPropertyAssignment(property)) {
        collectExportWriteCandidates(
          index,
          property.name,
          names,
          locations,
          unresolved,
        );
      } else if (ts.isMethodDeclaration(property)) {
        locations.push(toSourceLocation(index.sourceFile, property));
      } else {
        // A spread, an accessor: a value the widening cannot name a root
        // for (task V-3).
        unresolved.push(toSourceLocation(index.sourceFile, property));
      }
    }
    return;
  }

  if (!ts.isIdentifier(value)) {
    // Task V-3: a call's result, a member read, a conditional -- a value
    // that may be callable and that no position names. Contributing
    // nothing here was a silently dropped root.
    if (mayBeCallableValue(value)) {
      unresolved.push(toSourceLocation(index.sourceFile, value));
    }
    return;
  }

  // RWF-013/013b's reassignment proof, reused verbatim and honoured here
  // exactly as attribution honours it: a name this file writes to is not a
  // stable alias for whatever it was declared as, so the DECLARATION is
  // not a plausible published value. Refusing rather than rooting the
  // stale node is what makes `main = safe; module.exports = main` stop
  // reporting the original `main`'s body -- and, since task V-3, the
  // refusal is a gap the root set reports, not a root it silently lacks.
  const resolved = resolveLocalValue(index, value);
  if (resolved.kind === "refused") {
    unresolved.push(toSourceLocation(index.sourceFile, value));
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
      return;
    }
  }
  // Task V-3: the identifier's own declaration -- or, for an alias, the
  // declaration its chain ends on -- resolved lexically from this
  // reference: the root a name used to reach by spelling. A write inside a
  // function body may run later or never, and its names were collected by
  // a whole-file walk; whatever this cannot name a callable for is root
  // INCOMPLETENESS, never nothing: a whole-module binding has no
  // requirement of its own to fail closed instead (task V-3's independent
  // audit, finding 1).
  if (isInsideFunctionBody(value)) {
    unresolved.push(toSourceLocation(index.sourceFile, value));
    return;
  }
  const candidates = [value.text];
  if (resolved.kind === "unmodeled" && resolved.name !== undefined) {
    candidates.push(resolved.name);
  }
  let named = false;
  for (const candidate of candidates) {
    const declared = declaredRootAt(index.sourceFile, value, candidate);
    if (declared.kind === "callable") {
      locations.push(declared.location);
      named = true;
    } else if (declared.kind === "none") {
      named = true;
    }
  }
  if (!named) {
    unresolved.push(toSourceLocation(index.sourceFile, value));
  }
}

/**
 * Whether one export binding publishes a value that comes from ANOTHER
 * module, so no node in the entrypoint's own file can serve as its root
 * (P0-Z).
 *
 * Both syntaxes are covered because both lose the root the same way, and
 * each carries the fact on its own field: ESM's `export { x } from "./y"`
 * / `export * from "./y"` arrives as `kind: "re-export"`, while CommonJS
 * `module.exports = require("./y")` arrives as {@link
 * ExportBinding.commonJsReExport} (see that field's own doc comment for
 * why the two are deliberately separate).
 *
 * A name on the binding does NOT make it rootable: `export { run } from
 * "./x"` and `module.exports.run = require("./x").run` both carry the name
 * `run`, and both publish a callable defined in `./x`, so a same-file
 * lookup for `run` finds either nothing or — worse — an unrelated local
 * that merely shares the text.
 */
function isForeignOriginExport(exp: ExportBinding): boolean {
  return exp.kind === "re-export" || exp.commonJsReExport !== undefined;
}

/**
 * Whether a call MUTATES the CommonJS export object directly, e.g.
 * `Object.assign(module.exports, require("./x"))` (P0-Z).
 *
 * Deliberately keyed on the export object being the call's FIRST argument
 * — the mutation TARGET position for `Object.assign`,
 * `Object.defineProperty` and `Object.defineProperties` alike. A mention
 * anywhere else (`console.log("exports are", module.exports)`,
 * `{ ...module.exports }`) publishes nothing and must not make an
 * otherwise-complete entrypoint incomplete, which is why this is not a
 * blanket "mentions `module.exports` anywhere" test.
 *
 * KNOWN, DELIBERATE IMPRECISION: a pure READ that happens to sit in
 * first-argument position (`JSON.stringify(module.exports)`) is reported
 * too. Distinguishing it would require knowing whether the callee mutates
 * its argument, which is exactly the whole-program question this fix is
 * scoped not to open — and the costs are asymmetric. Over-reporting turns
 * a NOT_AFFECTED into an UNKNOWN; under-reporting turns a reachable target
 * into a false NOT_AFFECTED, which is the defect this exists to prevent.
 * The imprecise direction is the safe one, so it is taken knowingly rather
 * than narrowed to a fragile allowlist of known-mutating callees.
 *
 * The module model produces no {@link ExportBinding} whatsoever for this
 * shape, so unlike a re-export there is nothing else to detect it by.
 */
function isCommonJsExportObject(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) {
    return node.text === "exports";
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "module" &&
    node.name.text === "exports"
  );
}

function exportForwardingCalls(
  sourceFile: ts.SourceFile,
): readonly ts.CallExpression[] {
  const found: ts.CallExpression[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      isCommonJsExportObject(node.arguments[0]!)
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/**
 * Every `module.exports[<computed>] = ...` write whose published NAME is
 * not statically known (P0-Z).
 *
 * The callable on the right-hand side is typically local and perfectly
 * rootable; what is missing is the name it becomes visible under. The
 * module model produces no {@link ExportBinding} for such a write, so the
 * file looks exactly like one that exports nothing — the same conflation
 * as a re-export, reached through a third route:
 *
 * ```js
 * function run(u) { return dep.dangerousOp(u); }
 * module.exports[process.env.K] = run;   // publishes `run`; name unknown
 * ```
 *
 * A LITERAL computed key (`module.exports["run"] = run`) is deliberately
 * excluded: its name is statically known and the ordinary named-export
 * path already models it, so reporting it would cost precision for no
 * soundness gain.
 */
function computedExportNameWrites(
  sourceFile: ts.SourceFile,
): readonly ts.ElementAccessExpression[] {
  const found: ts.ElementAccessExpression[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isElementAccessExpression(node.left) &&
      isCommonJsExportObject(node.left.expression) &&
      // P0-Z: refuse exactly the keys source-index.ts could NOT name. The
      // two must use one predicate: a key it names becomes a real export
      // binding (and therefore a root), and a key it refuses has no
      // binding anywhere, so it must surface here as incompleteness. An
      // independent spelling of "looks literal" is how `1e3` -- which
      // denotes "1000", not "1e3" -- could be excluded from BOTH and
      // silently report a complete, root-less derivation.
      exactCommonJsExportPropertyName(node.left.argumentExpression) ===
        undefined
    ) {
      found.push(node.left);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

/**
 * The resolved value of a CommonJS PROPERTY export that carries no
 * `localName` (P0-Z round 3) -- `module.exports.run = obj.bad`, where the
 * right-hand side is not a bare identifier so no local name was recorded.
 *
 * Without this such a binding looks exactly like `module.exports.run = 42`:
 * both have no `localName`, no `localFunctionLocation`, and would emit no
 * requirement. One of them can publish a callable.
 */
function commonJsPropertyExportValue(
  index: SourceIndex,
  exp: ExportBinding,
): LocalValueProvenance | undefined {
  if (
    exp.syntax !== "commonjs" ||
    exp.kind !== "named" ||
    exp.exportedName === undefined
  ) {
    return undefined;
  }
  const rhs = commonJsPropertyExportRhs(index, exp.exportedName);
  return rhs === undefined ? undefined : resolveLocalValue(index, rhs);
}

export function entrypointRootCandidates(
  index: SourceIndex,
  model: ModuleModel,
): EntrypointRootCandidates {
  const names = new Set<string>();
  const locations: SourceLocation[] = [];
  const incompleteness: EntrypointRootIncompleteness[] = [];
  const rootRequirements: EntrypointRootRequirement[] = [];
  let withdrawn = false;

  for (const exp of model.exports) {
    // Task BL-105: an ES export the file may overwrite publishes a value no
    // write here enumerates ({@link withdrawOverwrittenEsmExports}). It is a
    // root gap, reported: its declared callable is no root (the host may
    // never call it), and the CommonJS widening below does not reach it.
    if (
      exp.syntax === "esm" &&
      exp.kind !== "re-export" &&
      exp.exportAttributionWithdrawn === true
    ) {
      incompleteness.push({
        reason: "unresolved_entrypoint_root_candidate",
        exportedName: canonicalExportName(exp),
        location: exp.location,
      });
    }
    // P0-Z round 3: what this binding would have to materialize to.
    const requiredNames: string[] = [];
    const requiredLocations: SourceLocation[] = [];
    // Task V-3: the names that carry provenance for this binding -- the
    // local it was written with, and where its alias chain ends. NOT the
    // `exportedName` fallback below: a public name is not provenance for a
    // local (RWF-011), so it may widen nothing and satisfy nothing.
    const provenanceNames: string[] = [];
    if (exp.localName) {
      provenanceNames.push(exp.localName);
    }
    let requiresCallableRoot = false;
    // The names the binding was written with, `exportedName` fallback
    // included, kept in `names` and `requiredNames` for diagnostics only.
    // Until task V-3 the fallback ROOTED and WITNESSED by spelling, on the
    // premise that an extra root only makes more code reachable; it also
    // satisfied the requirement, so a same-named decoy stood in for the
    // export and the real one was never searched (PRM-31). A root is a
    // position now (`provenanceNames` below), and the exported name, as
    // RWF-011 already decided for attribution, is no provenance.
    const name = exp.localName ?? exp.exportedName;
    if (name) {
      names.add(name);
      requiredNames.push(name);
    }
    // RWF-003's anonymous-callable evidence, which root selection never
    // consulted before RWF-021: `module.exports = function (u) { ... }`
    // has an exact function IDENTITY and no name at all, so a name-only
    // root lookup lost it even when attribution was fully precise.
    if (exp.localFunctionLocation) {
      // Task V-3: a callable the export publishes, so a requirement -- met
      // by its position only when the function is evaluated before the
      // export reads it (`exports.main = run; var run = function () {}`
      // publishes `undefined`; its independent audit, finding 5).
      requiresCallableRoot = true;
      const fn = nodeAtLocation(index.sourceFile, exp.localFunctionLocation);
      if (fn !== undefined && evaluatedBeforeExport(index, fn, exp)) {
        locations.push(exp.localFunctionLocation);
        requiredLocations.push(exp.localFunctionLocation);
      }
    }
    if (exp.exportAttributionWithdrawn) {
      withdrawn = true;
    }

    // P0-Z round 3 -- RESOLVE THE EXPORTED LOCAL THROUGH ITS ALIAS CHAIN.
    //
    // `exp.localName` is the name the export was written with, which for
    // `const alias = bad; module.exports.run = alias` is `alias` -- a
    // variable, not a callable node. The chain walk is RWF-012/013's
    // existing bounded one (`resolveLocalValue`, entered by name), so
    // reassignment, cycles, destructuring and non-module-scope bindings
    // all refuse here exactly as they refuse for attribution. This adds
    // hops, never permissiveness.
    const published = exp.localName
      ? resolveLocalValueByName(index, exp.localName)
      : commonJsPropertyExportValue(index, exp);

    if (published !== undefined) {
      switch (published.kind) {
        case "unmodeled": {
          // The chain ended on a name this file does not bind -- an
          // un-reassigned function/class declaration, or an import. THAT
          // is the callable a root must be looked up by.
          if (published.name !== undefined) {
            names.add(published.name);
            requiredNames.push(published.name);
            provenanceNames.push(published.name);
          }
          requiresCallableRoot = true;
          break;
        }
        case "value": {
          const chased = directValueFunctionLocation(
            index.sourceFile,
            published.value,
          );
          if (chased && evaluatedBeforeExport(index, published.value, exp)) {
            // An exact function/arrow/class expression: materialized by
            // POSITION, which needs no name at all (RWF-003's evidence).
            locations.push(chased);
            requiredLocations.push(chased);
            requiresCallableRoot = true;
          } else if (chased || mayBeCallableValue(published.value)) {
            // Task V-3 (its independent audit, finding 5): a function
            // value assigned only AFTER the export reads the binding --
            // `exports.main = run; var run = function () {}` -- is not
            // what the export publishes (it published `undefined`).
            // A conditional, a call, a property access: could publish a
            // callable and this analyzer cannot say which. Requiring it
            // is what turns the guess into an honest UNKNOWN.
            requiresCallableRoot = true;
          }
          // Anything provably non-callable (a numeric/string literal)
          // requires no root at all, and must not manufacture one.
          break;
        }
        case "refused": {
          // RWF-013/013b proved the file rewrites this binding, so what it
          // publishes is genuinely undetermined. The stale declaration must
          // not be rooted, and pretending the derivation is complete is the
          // defect this whole effort removes.
          requiresCallableRoot = true;
          break;
        }
      }
    }

    // Task V-3 (its independent audit, finding 2): an ESM default export
    // the model records with no local and no position -- `export default
    // run`, `export default function () {}`, `export default () => ...`
    // -- published a callable and required no root, so `{file, symbol:
    // "default"}` and a plain file entrypoint called the root set
    // complete without it.
    if (
      exp.kind === "default" &&
      exp.syntax === "esm" &&
      exp.localName === undefined &&
      exp.localFunctionLocation === undefined
    ) {
      const site = nodeAtLocation(index.sourceFile, exp.location);
      requiresCallableRoot = true;
      if (site !== undefined && ts.isExportAssignment(site)) {
        const value = unwrapParentheses(site.expression);
        const direct = directValueFunctionLocation(index.sourceFile, value);
        if (ts.isIdentifier(value)) {
          provenanceNames.push(value.text);
        } else if (direct !== undefined) {
          locations.push(direct);
          requiredLocations.push(direct);
        } else if (!mayBeCallableValue(value)) {
          requiresCallableRoot = false;
        }
      } else if (
        site !== undefined &&
        ts.isFunctionDeclaration(site) &&
        site.body !== undefined
      ) {
        const location = toSourceLocation(index.sourceFile, site);
        locations.push(location);
        requiredLocations.push(location);
      } else if (site !== undefined && ts.isClassDeclaration(site)) {
        const location = toSourceLocation(
          index.sourceFile,
          classConstructorNode(site),
        );
        locations.push(location);
        requiredLocations.push(location);
      }
    }

    if (requiresCallableRoot) {
      // Task V-3: each provenance name materializes at the position of the
      // callable it DECLARES at the export's site, and only there -- unless
      // the binding is REFUSED (the file rewrites it): its declaration is
      // then the stale value, which may neither root nor witness (task
      // V-3's independent audit, finding 3).
      const provenance =
        published?.kind === "refused"
          ? []
          : provenanceNameLocations(index, exp, provenanceNames);
      for (const location of provenance) {
        locations.push(location);
        requiredLocations.push(location);
      }
      rootRequirements.push({
        exportedName: exp.exportedName,
        canonicalName: canonicalExportName(exp),
        names: requiredNames,
        locations: requiredLocations,
      });
    }
    // P0-Z: an export forwarded from another module has no root in THIS
    // file. Recorded rather than silently contributing nothing, which is
    // how the root vanished and family C still claimed completeness.
    if (isForeignOriginExport(exp)) {
      incompleteness.push({
        reason: "unresolved_entrypoint_reexport",
        specifier: exp.specifier ?? exp.commonJsReExport?.specifier,
        exportedName: exp.exportedName,
        location: exp.location,
      });
    }
  }

  // P0-Z: export-object mutation the model produces no binding for.
  for (const call of exportForwardingCalls(index.sourceFile)) {
    incompleteness.push({
      reason: "unresolved_export_forwarding",
      location: toSourceLocation(index.sourceFile, call),
    });
  }

  // P0-Z: a real local callable published under a name only the runtime
  // knows. Rootable in principle, invisible to the model in practice.
  for (const write of computedExportNameWrites(index.sourceFile)) {
    incompleteness.push({
      reason: "unresolved_computed_export_name",
      location: toSourceLocation(index.sourceFile, write),
    });
  }

  const wideningLocations: SourceLocation[] = [];
  const wideningUnresolved: SourceLocation[] = [];
  if (withdrawn) {
    // Every value this file's own export writes could publish — and
    // nothing else. See {@link exportWriteRootCandidates}.
    for (const assignment of collectModuleExportsAssignments(
      index.sourceFile,
    )) {
      collectExportWriteCandidates(
        index,
        assignment.rhs,
        names,
        wideningLocations,
        wideningUnresolved,
      );
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
        collectExportWriteCandidates(
          index,
          rhs,
          names,
          wideningLocations,
          wideningUnresolved,
        );
      }
    }
    locations.push(...wideningLocations);
    // Task V-3: a value an export write may publish that no position
    // names is a root gap, reported -- it used to contribute nothing.
    for (const location of wideningUnresolved) {
      incompleteness.push({
        reason: "unresolved_entrypoint_root_candidate",
        location,
      });
    }
  }

  return {
    names,
    locations,
    complete: incompleteness.length === 0,
    incompleteness,
    rootRequirements,
  };
}
