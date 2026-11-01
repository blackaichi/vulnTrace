/**
 * The module model: one file's imports and exports (`buildModuleModel`),
 * and the export map that attributes an export to the function it holds
 * (`mapExportsToFunctions`, `findExportedClassMembers`).
 *
 * This file is the model's public entry. Task BL-121 split the rest of it
 * by concern, as a pure move, into the files below; this file re-exports
 * their public names, so every importer reads the model from here. A
 * record that places a declaration in `module-model.ts` predates the split
 * and names the file this map points to. Roughly from the outermost
 * concern in:
 *
 * - `module-model.export-bindings.ts`: every export binding of a file, and
 *   the whole-module export's authority.
 * - `module-model.entrypoint-roots.ts`: the call graph's entrypoint roots.
 * - `module-model.export-write-set.ts`: the export write set (task E-1),
 *   and how it is applied to the export bindings.
 * - `module-model.export-references.ts`: the write set's vocabulary, and
 *   what one reference to an export object does to it.
 * - `module-model.own-object-routes.ts`: the routes from the export objects
 *   to the file's own functions; `module-model.final-object.ts`: the
 *   final-object account; `module-model.route-keys.ts`: key names and
 *   numeric keys.
 * - `module-model.export-methods.ts`: methods called through the export
 *   objects; `module-model.loader-registry.ts`: the loader registry and the
 *   global object; `module-model.load-result-escape.ts`: a load's result
 *   that may be an export object (task BL-074);
 *   `module-model.prototype-tampering.ts`: builtin and prototype
 *   tampering; `module-model.alias-summaries.ts`: the alias summaries.
 * - `module-model.export-provenance.ts`: where an export's value comes
 *   from, and whether its assignment is definitely reached.
 * - `module-model.competing-writes.ts` and
 *   `module-model.competing-write-sites.ts`: the competing-write window
 *   (task BL-064).
 * - `module-model.evaluation-cutoff.ts`: where module evaluation may end;
 *   `module-model.class-heritage.ts`, `module-model.abruptness.ts`:
 *   abrupt completion; `module-model.completion.ts`: normal completion;
 *   `module-model.local-callables.ts`: local reassignment and callables.
 * - `module-model.module-scope.ts`: the module scope's bindings;
 *   `module-model.syntax.ts`: the syntax predicates they all share.
 *
 * The value imports between these files form no cycle; only type imports
 * of this file's public types come back to it
 * (`scripts/bl121-pure-move-check.mjs` checks both the move and the cycle).
 */
import ts from "typescript";
import type { SourceLocation } from "../domain/graph.js";
import type { CommonJsReExportOrigin } from "./commonjs-reexports.js";
import {
  isNameAssignedWithin,
  lexicalDeclarationOf,
} from "./named-bindings.js";
import type { IndexedFunction, SourceIndex } from "./source-index.js";
import {
  declaredCallableLocation,
  nodeAtLocation,
  isInsideFunctionBody,
} from "./module-model.export-provenance.js";
import type { LoadReach } from "./module-model.load-result-escape.js";
import { buildExportBindings } from "./module-model.export-bindings.js";
export { exportAliasIdentifierIndexBuilds } from "./module-model.syntax.js";
export { calleeCompletionEvaluationCount } from "./module-model.completion.js";
export { invocationTargetResolutionCount } from "./module-model.local-callables.js";
export { calleeSummaryEvaluationCount } from "./module-model.abruptness.js";
export { canonicalExportName } from "./module-model.export-provenance.js";
export { exportNumericKeyReferenceVisits } from "./module-model.route-keys.js";
export { exportOwnObjectRouteWalks } from "./module-model.own-object-routes.js";
export { exportAliasSummaryWalks } from "./module-model.alias-summaries.js";
export {
  loadConfinementWalkCount,
  loadReachQuery,
} from "./module-model.load-result-escape.js";
export type {
  LoadReach,
  LoadReachQuery,
} from "./module-model.load-result-escape.js";
export {
  REGISTRY_BUILTINS,
  fileReachesLoaderRegistry,
  globalObjectIdiomSites,
} from "./module-model.loader-registry.js";
export { entrypointRootCandidates } from "./module-model.entrypoint-roots.js";
export type {
  EntrypointRootIncompletenessReason,
  EntrypointRootIncompleteness,
  EntrypointRootCandidates,
  EntrypointRootRequirement,
} from "./module-model.entrypoint-roots.js";

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
  /**
   * On a CommonJS whole-module export whose value is another module's
   * ({@link commonJsReExport}, `module.exports = require("./lib")`): the
   * names this file's export write set records it may write onto that object
   * (task E-2; ADR 0009 § 1's "the same determination gates the
   * forwarding hop"). The object is the other module's own exports, so
   * such a write replaces what the forwarded name holds:
   *
   * ```js
   * module.exports = require("./safe");
   * [module.exports.run] = [require("./danger").run];  // run is danger's
   * ```
   *
   * A plain `=` write leaves a named binding the hop already refuses on;
   * a write E-1's census can only withdraw ({@link ExportWriteSet.withdrawn})
   * leaves none, and forwarding `run` to `./safe` was RWF-105's false
   * NOT_AFFECTED. Every name withdrawn is here, and every `=` write not
   * provably on a stale object.
   *
   * Bounded by the census: a write reaching the forwarded object through a
   * load result's dataflow the census does not follow
   * (`patch(require("./safe"))`, `[require("./safe")][0].run = …`) is not
   * here, and the hop still forwards its name -- RWF-106, open, which
   * shares RWF-103's undecided fix.
   *
   * Set by {@link applyExportWriteSet} on every whole-module re-export it
   * keeps. Purely internal analysis state, read by exactly one consumer,
   * export-forwarding.ts's `commonJsExportForwardingHop`, which refuses to
   * forward a name listed here -- and refuses every name when it is
   * absent, since an absent record is a write set nobody consulted.
   */
  readonly forwardingShadowedNames?: ReadonlySet<string>;
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
 * Builds the unified import/export model for a file already indexed by
 * TASK-014 (see docs/SDD.md § 15-17).
 *
 * `reach` is the file's module-graph context (task BL-074,
 * {@link LoadReach}): which of its loads may return one of its export
 * objects. Without it every load may, and a file whose load result leaves
 * the routes the export census follows has no attributable CommonJS
 * export -- the fail-closed per-file rule.
 */
export function buildModuleModel(
  index: SourceIndex,
  reach?: LoadReach,
): ModuleModel {
  return {
    filePath: index.filePath,
    imports: index.imports.map(toImportBinding),
    exports: buildExportBindings(index, index.exports, reach),
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
 * src/analysis/verdict.ts's `findExportNodeInFile`, which locates a rule's
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
    // established may name the export's function -- never the public
    // export name, which is provenance for no local symbol
    // (`exports.parse = registry.impl` beside an unrelated
    // `function parse()`).
    //
    // E-1 (PRM-26; ADR 0009 § 1 clause 5): and that local name denotes
    // the ONE declaration it binds to where the export is written, by
    // lexical identity, never the first indexed function that merely
    // shares its spelling (a class method, a nested function, an
    // `o.run = function () {}` that source indexing names after the
    // property). A name nothing in scope declares, declares twice, or the
    // file assigns anywhere attributes nothing: an unresolved target,
    // UNKNOWN. See {@link exportLocalCallableLocation}.
    if (exp.localName === undefined) {
      continue;
    }
    const location = exportLocalCallableLocation(index, exp, exp.localName);
    if (location !== undefined) {
      functionsByPosition ??= indexFunctionsByPosition(index);
      const byIdentity = functionsByPosition.get(positionKey(location));
      if (byIdentity) {
        result.set(canonicalName, byIdentity);
      }
    }
  }

  return result;
}

/**
 * The position of the callable `localName` denotes at `exp`'s own site, by
 * lexical identity (task E-1, PRM-26), or `undefined` when it denotes no
 * one callable this file defines.
 *
 * The site is the export's own statement, declaration or specifier, and
 * the name resolves through its scope chain to the one declaration that
 * owns it ({@link lexicalDeclarationOf}): a class method, a nested
 * function or a property function that merely shares the spelling is never
 * it. Refused, toward an unresolved target:
 *
 * - a site inside a function body (a write that may run later, or never);
 * - a name the file assigns ANYWHERE (`run = other`, in any scope): its
 *   declaration's value is not the export's (RWF-013 for CommonJS, PRM-62
 *   for an ES module's live binding, which an assignment anywhere changes
 *   for every importer);
 * - for CommonJS, a variable whose initializer has not run where the
 *   export reads it (`exports.run = run; var run = function () {}`
 *   publishes `undefined`). An ES module export is a live binding, read at
 *   the importer's call, so its order is not asked.
 */
function exportLocalCallableLocation(
  index: SourceIndex,
  exp: ExportBinding,
  localName: string,
): SourceLocation | undefined {
  const sourceFile = index.sourceFile;
  const site = nodeAtLocation(sourceFile, exp.location);
  if (site === undefined || isInsideFunctionBody(site)) {
    return undefined;
  }
  const declaration = lexicalDeclarationOf(site, localName);
  if (
    declaration === undefined ||
    isNameAssignedWithin(sourceFile, localName)
  ) {
    return undefined;
  }
  if (ts.isVariableDeclaration(declaration)) {
    if (declaration.initializer === undefined) {
      return undefined;
    }
    if (
      exp.syntax === "commonjs" &&
      declaration.getEnd() > site.getStart(sourceFile)
    ) {
      return undefined;
    }
  }
  return declaredCallableLocation(sourceFile, declaration);
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
