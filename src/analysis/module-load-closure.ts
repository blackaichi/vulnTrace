import { findClosureWideningConstructs } from "../code-intelligence/loader-constructs.js";
import { buildModuleModel } from "../code-intelligence/module-model.js";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import { indexSourceFileFromDisk } from "../code-intelligence/source-index.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type { DynamicCallReason, SourceLocation } from "../domain/graph.js";
import {
  identifyModule,
  type KnownPackageRoots,
  type PackageInstanceId,
} from "../domain/resolved-target.js";

/**
 * Why a {@link ModuleLoadClosure} could not be established as complete.
 *
 * Reuses {@link DynamicCallReason} for every construct-derived cause
 * rather than defining a parallel vocabulary: the closure-widening
 * partition (`isClosureWideningReason`, domain/graph.ts) is normative and
 * must stay single-source. Only *closure-widening* `DynamicCallReason`
 * values are ever emitted here -- a non-widening one (e.g.
 * `unsupported_construct`) says nothing about what modules can load, so it
 * must never make a closure incomplete. Two additional causes are specific
 * to closure traversal itself and have no call-edge equivalent:
 *
 * - `parse_failure`: a closure member could not be read, or could be read
 *   but not soundly parsed (`SourceIndex.hasSyntaxErrors`, VT-307c-fix-2),
 *   so its own imports (and therefore everything they would transitively
 *   load) are unknown. Previously invisible entirely -- the VT-307
 *   soundness review called this out as a missing completeness signal, and
 *   found that TypeScript's own error-tolerant parser made it reachable
 *   even without a read failure: given invalid syntax it still returns a
 *   partial, silently-reshaped AST rather than throwing, so a member whose
 *   `require`/`import` got parsed away by a syntax error looked completely
 *   and soundly absent. This case is deliberately folded into the same
 *   `parse_failure` reason as a read failure rather than getting its own
 *   value: both mean exactly the same thing to a caller -- "this member's
 *   imports could not be established" -- and nothing downstream needs to
 *   tell them apart.
 * - `traversal_truncated`: a configured resource limit stopped traversal
 *   before the closure was exhausted, so the unvisited region's own
 *   imports are unknown. Deliberately distinct from the call graph's own
 *   `graphTruncated` (see cli/scan.ts): the two traversals visit different
 *   file sets and can be truncated independently, so one flag cannot
 *   faithfully stand in for the other.
 */
export type ClosureIncompletenessReason =
  DynamicCallReason | "parse_failure" | "traversal_truncated";

/** One concrete reason a {@link ModuleLoadClosure} is incomplete, with enough context to act on it. */
export interface ClosureIncompleteness {
  readonly reason: ClosureIncompletenessReason;
  /** The closure member whose loading/execution hit this -- i.e. where to look. */
  readonly importer: string;
  /** The unresolvable/declaration-only module specifier, when this cause is an import. */
  readonly specifier?: string;
  readonly location?: SourceLocation;
}

/**
 * The set of source files, and installed package instances, that loading
 * the configured entrypoints is *guaranteed* to execute (VT-307c).
 *
 * Formal definition: the least set of files containing every configured
 * entrypoint FILE, closed under every statically-resolvable
 * import/require that runs as part of module loading -- regardless of
 * whether any imported symbol is ever called.
 *
 * This is FILE-level (module-load) reachability, and it is NOT call
 * reachability. The two are genuinely different questions and must never
 * be conflated:
 *
 * - A module can be loaded with none of its exports called
 *   (`import "pkg"`, or `const x = require("pkg")` whose value is never
 *   used) -- it is in the closure, and its top-level code really does run.
 * - A function can be uncallable inside a module that is nonetheless
 *   loaded (an unreached export of a loaded file) -- its module is in the
 *   closure even though the function is not call-reachable.
 *
 * Deliberately built from `ModuleModel.imports` + the real module resolver
 * (see {@link buildModuleLoadClosure}), never from call-graph package
 * presence, successfully-bound call targets, or
 * `graphPackageInstances()`. Those answer "what did a call bind into?",
 * which systematically under-reports module loading: every open
 * export-resolution gap (RWF-001/003/004/006/012) makes a genuinely-loaded
 * package look absent from the call graph. The VT-307 soundness review
 * confirmed this directly -- e.g. RWB-08's `ms` IS loaded (via `debug`'s
 * own top-level `require("ms")`) but never appears as a call-bound package
 * instance, because RWF-004 blocks the binding.
 *
 * `complete` is explicit and must never be inferred from an empty
 * `incompleteness` list by a caller that skipped a check: an incomplete
 * closure means "modules beyond `loadedFiles` may also load at runtime",
 * which is exactly the condition under which closure *absence* proves
 * nothing.
 *
 * SOUNDNESS CONTRACT (VT-307c-fix-3). `complete === true` means exactly,
 * and only, that within the configured closure limits:
 *
 * - every closure member was readable;
 * - every closure member was syntactically valid (VT-307c-fix-2 --
 *   a recovered partial AST is never trusted);
 * - every static module load in every member -- an `import`/`require`
 *   binding AND a re-export declaration with a source specifier
 *   (`export * from "x"`, `export { a } from "x"`, `export * as ns from
 *   "x"`, `export { default } from "x"`, TypeScript's
 *   `import a = require("x")`; VT-307c-fix-8) -- resolved to a runtime
 *   file or a Node builtin, or was recorded as incompleteness;
 * - every closure-widening loader construct in every loaded member's
 *   source was accounted for -- established by this closure's own
 *   whole-file scan of each member (`findClosureWideningConstructs`),
 *   NOT by anything the call graph did or did not walk;
 * - this closure's own traversal was not truncated.
 *
 * It says nothing about semantic or type correctness, and it is not a
 * statement about call reachability in either direction.
 *
 * CONSUMED BY (VT-307d): the Site-B module-load absence gate in
 * `analysis/verdict.ts`. A `complete` closure whose
 * `loadedPackageInstances` does not contain a finding's exact canonical
 * `PackageInstanceId` is positive analytical evidence that the affected
 * installed instance cannot be loaded from the configured entrypoints, and
 * yields NOT_AFFECTED with the reason
 * `package_instance_not_in_complete_module_load_closure` (see
 * `ConfirmedAbsentFromModuleLoadClosure` in domain/evidence.ts, which also
 * records the boundary of that claim: it is absence under VulnTrace's
 * DECLARED SUPPORTED module-loading model, never universal runtime
 * impossibility).
 *
 * Only closures from {@link buildGateEligibleModuleLoadClosure} are ever
 * eligible for that gate. An INCOMPLETE closure is never absence evidence
 * of any kind -- that is what makes every widening condition above
 * load-bearing rather than advisory.
 */
export interface ModuleLoadClosure {
  /** The configured entrypoint FILES the closure is rooted at (never narrowed by `{file, symbol}` -- see {@link buildModuleLoadClosure}). */
  readonly rootFiles: readonly string[];
  readonly loadedFiles: readonly string[];
  readonly loadedPackageInstances: readonly PackageInstanceId[];
  readonly complete: boolean;
  readonly incompleteness: readonly ClosureIncompleteness[];
}

export interface BuildModuleLoadClosureOptions {
  /**
   * Roots. Only each entrypoint's `filePath` is used: a `{file, symbol}`
   * entrypoint still roots the closure at the whole FILE, because loading
   * that file executes its top-level code no matter which export is the
   * configured call-reachability source (SDD-v0.2.md § 6; see
   * verdict.ts's `entrypointSourceNodes`, which applies the symbol
   * narrowing on the call side only).
   */
  readonly entrypoints: readonly Entrypoint[];
  readonly resolver: ModuleResolver;
  /** Bounds traversal (see docs/SDD.md § 26, § 28-29). Reaching it marks the closure incomplete, never silently partial. */
  readonly maxFiles?: number;
  /**
   * The scan's dependency-provenance registry (VT-307c-fix-4b), passed
   * through to `identifyModule` so a loaded file with no `node_modules`
   * segment of its own -- an npm workspace member, a `file:` dependency,
   * or any other linked install whose physical target has no
   * `node_modules` segment -- can still be attributed to its owning
   * package instance instead of silently losing identity, PROVIDED that
   * physical root is genuinely a dependency-graph install location (see
   * `buildKnownPackageRoots`; never merely "has a package.json" or "lies
   * outside the project root" -- VT-307c-fix-4's own now-superseded,
   * unsound approach). Optional only for backward compatibility with
   * callers that predate this option (e.g. existing tests using synthetic
   * paths); omitting it does not change behavior for any install shape
   * that already has a `node_modules` segment.
   */
  readonly knownPackageRoots?: KnownPackageRoots;
}

/**
 * Builds the {@link ModuleLoadClosure} for `entrypoints` (VT-307c).
 *
 * Per-specifier resolution semantics, mirroring symbol-binder.ts's own
 * dispatch so the two layers agree on what a specifier means:
 * - runtime file (`"resolved"`) -> include the file, continue traversing it;
 * - `"builtin"` (VT-305) -> known and resolved, but contributes no local
 *   source file and no package instance: Node supplies it, there is
 *   nothing of it to analyze, and it is not an uncertainty;
 * - `"declaration"` (VT-304) -> incomplete, `declaration_only_resolution`:
 *   the module that actually runs was never identified, so its own
 *   imports are unknown;
 * - `"unresolved"` -> incomplete, `unresolved_module`.
 *
 * Applied uniformly to every specifier a member statically,
 * unconditionally loads -- not just `ModuleModel.imports`, but also every
 * `ModuleModel.exports` entry of `kind === "re-export"` that carries a
 * source `specifier` (VT-307c-fix-8; see the final VT-307d readiness
 * review, which found `export * from "pkg"` and its sibling forms were
 * indexed as *exports* -- correctly, for symbol-binding purposes -- but
 * never fed into this traversal at all, so a genuinely-loaded re-exported
 * dependency could be OUT of the closure while `complete` stayed `true`).
 * `export`/`import` here is a binding-direction distinction, not a
 * loading-or-not distinction: re-exporting a module loads it exactly as
 * unconditionally as importing it does, whether or not the re-exported
 * name is ever itself imported downstream. A file reached ONLY through a
 * re-export is traversed and whole-file-scanned for widening constructs
 * (`findClosureWideningConstructs`) exactly like a file reached through an
 * ordinary import -- there is no separate, weaker code path for it.
 *
 * Every loaded member is additionally scanned, in full, for
 * closure-widening loader constructs
 * ({@link findClosureWideningConstructs}) using the same classifier the
 * call graph itself uses. This is deliberately self-contained: it takes no
 * `CallGraph` at all, so closure completeness cannot depend on call-graph
 * coverage even accidentally. Until VT-307c-fix-3 it did take one, and
 * adopted the graph's already-classified loader edges -- which meant a
 * call graph truncated before reaching a transitively loaded file never
 * classified that file's top-level `require(dynamicName)`, and the closure
 * called itself complete for a member it had never examined (the VT-307d
 * review's Blocker 3).
 */
export async function buildModuleLoadClosure(
  options: BuildModuleLoadClosureOptions,
): Promise<ModuleLoadClosure> {
  const { entrypoints, resolver, knownPackageRoots } = options;
  const maxFiles = options.maxFiles ?? Infinity;

  const rootFiles = [...new Set(entrypoints.map((e) => e.filePath))];
  const loadedFiles = new Set<string>();
  const incompleteness: ClosureIncompleteness[] = [];
  const queue: string[] = [...rootFiles];

  while (queue.length > 0) {
    const filePath = queue.shift();
    if (filePath === undefined || loadedFiles.has(filePath)) {
      continue;
    }

    if (loadedFiles.size >= maxFiles) {
      incompleteness.push({
        reason: "traversal_truncated",
        importer: filePath,
      });
      break;
    }

    // Recorded as loaded BEFORE indexing: reaching a file means the module
    // system really does load and execute it, whether or not this analyzer
    // can parse it. A parse failure below is a completeness problem, not a
    // reason to pretend the file never loaded.
    loadedFiles.add(filePath);

    let sourceIndex;
    try {
      sourceIndex = indexSourceFileFromDisk(filePath);
    } catch {
      incompleteness.push({ reason: "parse_failure", importer: filePath });
      continue;
    }

    if (sourceIndex.hasSyntaxErrors) {
      // TypeScript's parser is error-tolerant: a syntax error never throws
      // here, it produces a partial AST that may have silently dropped or
      // reshaped the very imports this traversal depends on (VT-307c-fix-2
      // -- e.g. an unterminated block comment or template literal can
      // swallow a `require(...)` entirely). Trusting `model.imports` from
      // that AST as a complete account of this file's loads is exactly the
      // unsound inference the VT-307 soundness review flagged, so this
      // member's imports are never even inspected: the closure must record
      // incompleteness regardless of what the recovered AST does or does
      // not contain.
      incompleteness.push({ reason: "parse_failure", importer: filePath });
      continue;
    }

    const model = buildModuleModel(sourceIndex);

    // This file's OWN loader scan (VT-307c-fix-3). Runs over the whole
    // file, and runs for every loaded member, so closure completeness is a
    // property of the source this closure actually read -- never of how
    // far some other traversal happened to get. See
    // `findClosureWideningConstructs`.
    for (const construct of findClosureWideningConstructs({
      index: sourceIndex,
      model,
    })) {
      incompleteness.push({
        reason: construct.reason,
        importer: filePath,
        location: construct.location,
      });
    }

    // Every specifier this file statically, unconditionally loads at module
    // scope -- both `import`/`require` bindings AND re-export declarations
    // with a source specifier (VT-307c-fix-8). `export * from "pkg"`,
    // `export { x } from "pkg"`, `export { x as y } from "pkg"`,
    // `export * as ns from "pkg"`, and `export { default } from "pkg"` all
    // execute exactly the same runtime module load as `import "pkg"` --
    // whether or not any re-exported symbol is ever imported downstream, or
    // even resolvable at all (docs/SDD.md's own imports/exports split
    // records re-exports as *exports*, since that's their binding
    // direction, but a re-export's specifier is still a load this file
    // itself performs -- ModuleModel's exports/imports split is about
    // where a name comes FROM, not about what loading this file executes).
    // Deliberately reuses the exact same resolution dispatch as an
    // ordinary import below: a specifier means the same thing regardless of
    // which declaration form referenced it.
    const staticLoads: { specifier: string; location: SourceLocation }[] = [
      ...model.imports.map((imp) => ({
        specifier: imp.specifier,
        location: imp.location,
      })),
      ...model.exports
        .filter(
          (exp) => exp.kind === "re-export" && exp.specifier !== undefined,
        )
        .map((exp) => ({
          specifier: exp.specifier as string,
          location: exp.location,
        })),
    ];

    const seenSpecifiers = new Set<string>();
    for (const load of staticLoads) {
      if (seenSpecifiers.has(load.specifier)) {
        continue;
      }
      seenSpecifiers.add(load.specifier);

      const resolution = await resolver.resolve(load.specifier, filePath);

      if (resolution.kind === "builtin") {
        continue;
      }
      if (resolution.kind === "unresolved") {
        incompleteness.push({
          reason: "unresolved_module",
          importer: filePath,
          specifier: load.specifier,
          location: load.location,
        });
        continue;
      }
      if (resolution.kind === "declaration") {
        incompleteness.push({
          reason: "declaration_only_resolution",
          importer: filePath,
          specifier: load.specifier,
          location: load.location,
        });
        continue;
      }

      if (!loadedFiles.has(resolution.resolvedFileName)) {
        queue.push(resolution.resolvedFileName);
      }
    }
  }

  const loadedPackageInstances = new Set<PackageInstanceId>();
  for (const file of loadedFiles) {
    const instance = identifyModule(file, knownPackageRoots).packageInstance;
    if (instance !== undefined) {
      loadedPackageInstances.add(instance);
    }
  }

  return {
    rootFiles,
    loadedFiles: [...loadedFiles],
    loadedPackageInstances: [...loadedPackageInstances],
    complete: incompleteness.length === 0,
    incompleteness,
  };
}

/**
 * Options for {@link buildGateEligibleModuleLoadClosure} (VT-307c-fix-10) --
 * deliberately stricter than {@link BuildModuleLoadClosureOptions}:
 * `knownPackageRoots` is REQUIRED here, never optional. The final VT-307d
 * readiness review found that a closure built WITHOUT it silently loses
 * identity for every workspace/`file:`-linked package with no
 * `node_modules` segment of its own -- such a package can be genuinely
 * loaded and still report zero `loadedPackageInstances`, exactly the
 * false-absence shape a future negative-proof gate must never be able to
 * observe. Requiring the field HERE, rather than trusting a caller
 * convention or an optional caller-set "I promise this is eligible"
 * boolean, is what actually prevents that: TypeScript refuses to compile a
 * call site that omits it.
 */
export interface BuildGateEligibleModuleLoadClosureOptions extends Omit<
  BuildModuleLoadClosureOptions,
  "knownPackageRoots"
> {
  readonly knownPackageRoots: KnownPackageRoots;
}

/**
 * Builds a {@link ModuleLoadClosure} suitable for VT-307d's own,
 * separately-reviewed negative-absence-proof gate -- NOT the gate itself.
 * This is preparation only (VT-307c-fix-10): its sole job is to guarantee
 * the two structural preconditions the final VT-307d readiness review found
 * missing, and to make it structurally impossible for a caller to obtain
 * something claiming eligibility without actually satisfying them --
 * "structural" in the sense that this is the ONLY function that can hand
 * back an eligible closure at all, never a boolean flag a caller could set
 * incorrectly on an otherwise-ordinary one:
 *
 * 1. `knownPackageRoots` was genuinely supplied -- enforced by TYPE (see
 *    {@link BuildGateEligibleModuleLoadClosureOptions}), not by convention.
 * 2. The closure is rooted at least one real entrypoint file --
 *    `entrypoints` (and therefore `rootFiles`) is non-empty. The same
 *    review reproduced the alternative directly: a project where
 *    entrypoint discovery finds nothing (a real, already-diagnosed
 *    production state -- see cli/scan.ts's own "no entrypoints were
 *    discovered" diagnostic, added after a real regression) yields
 *    `rootFiles: []`, `loadedFiles: []`, `loadedPackageInstances: []`,
 *    `incompleteness: []`, `complete: true` -- a VACUOUSLY complete
 *    closure in which every installed package instance is OUT. A gate
 *    that could not distinguish this from a genuine, exhaustively-
 *    traversed absence proof would return a false `NOT_AFFECTED` for
 *    EVERY finding on exactly the projects where nothing could be
 *    analyzed at all.
 *
 * Returns `undefined` -- never a closure claiming eligibility it doesn't
 * have -- when `entrypoints` is empty (checked before doing any work) or,
 * defensively, if the resulting closure's own `rootFiles` still ends up
 * empty. This is a RUNTIME check deliberately layered on top of the
 * TYPE-level `knownPackageRoots` requirement above: a production
 * `entrypoints` array comes from entrypoint discovery's own
 * `readonly Entrypoint[]` return, which TypeScript cannot statically prove
 * non-empty at any call site, so the emptiness check has to happen here,
 * at construction time, not merely be assumed by the type signature.
 *
 * Deliberately does NOT introduce a separate `GateEligibleModuleLoadClosure`
 * type distinct from {@link ModuleLoadClosure}: the returned value's own
 * SHAPE is identical either way -- the only thing that actually needs
 * guaranteeing is that this function is the sole path capable of producing
 * one, which VT-307d's own gate is written to call exclusively. This
 * VT-307d wired this into production: `cli/scan.ts` calls it exactly once
 * per scan (after building the dependency graph, `KnownPackageRoots` and
 * the configured entrypoints) and threads the single resulting closure
 * into every `buildFinding` call, where `verdict.ts`'s Site-B gate is the
 * only consumer. `buildModuleLoadClosure` is deliberately NOT reachable
 * from that path: being the sole producer of a gate-eligible closure is
 * precisely what makes eligibility structural.
 */
export async function buildGateEligibleModuleLoadClosure(
  options: BuildGateEligibleModuleLoadClosureOptions,
): Promise<ModuleLoadClosure | undefined> {
  if (options.entrypoints.length === 0) {
    return undefined;
  }

  const closure = await buildModuleLoadClosure(options);

  if (closure.rootFiles.length === 0) {
    return undefined;
  }

  return closure;
}

/**
 * Whether `reason` can invalidate a CALL-GRAPH-derived negative proof
 * (VT-307e) -- i.e. the "exact installed instance was never traversed"
 * proof (`confirmedAbsentInstance`) and the "vulnerable target is not
 * reachable" proof, both of which conclude NOT_AFFECTED from what the call
 * graph did NOT contain.
 *
 * This is deliberately a PROOF-SPECIFIC partition, not a reuse of
 * `closure.complete`. Those two proofs do not depend on module loading in
 * the same way {@link ModuleLoadClosure}'s own absence proof does, so
 * blanket-blocking them on any incompleteness would both over-block and
 * obscure WHY a given condition matters. Each value is decided on whether
 * it can hide a call path to the target, or hide the loading of the very
 * instance being called absent:
 *
 * - Every loader/execution-capability reason (`dynamic_require`,
 *   `dynamic_import`, `eval`/`aliased_eval`/`function_constructor`,
 *   `create_require`/`aliased_require`/`module_require`,
 *   `module_internal_load`, `loader_hook_mutation`,
 *   `loader_capability_escape`, `vm_execution`, `worker_execution`,
 *   `child_process_execution`) BLOCKS both. Each can execute or load code
 *   this analysis never modeled, which can both introduce a call path to
 *   the target and load an instance the graph never traversed. Note that
 *   the call graph independently catches these only when they appear as
 *   an unresolved CALL edge inside an entrypoint's reachable subgraph --
 *   it does not catch a non-call form (an assignment such as
 *   `Module._extensions['.js'] = ...`), which is exactly the pre-existing
 *   gap the VT-307d audit surfaced and this partition closes.
 * - `parse_failure` BLOCKS both. TypeScript's parser is error-tolerant, so
 *   a syntactically invalid member still yields a partial, silently
 *   reshaped AST. The closure has refused to trust that since
 *   VT-307c-fix-2; the call graph does NOT check `hasSyntaxErrors` and
 *   builds nodes and edges from the recovered AST regardless. A `require`
 *   and the call that follows it can both be swallowed by the same syntax
 *   error, so neither "no path was found" nor "this instance was never
 *   traversed" means anything for such a file.
 * - `unresolved_module` BLOCKS both: the specifier that failed to resolve
 *   may BE the absent instance, and the module behind it may call the
 *   target.
 * - `declaration_only_resolution` BLOCKS both: the module that actually
 *   runs was never identified, so its imports and calls are unknown.
 * - `traversal_truncated` DOES NOT BLOCK either. This is the one genuine
 *   exclusion, and the reason is structural rather than convenient: it is
 *   a bound on THIS closure's own walk, and says nothing about how far the
 *   call graph got. The call graph's coverage has its own independent
 *   guard -- `graphTruncated` (VT-202) -- which `buildFinding` already
 *   enforces for every call-graph-derived NOT_AFFECTED. In production both
 *   traversals are bounded by the same `analysis.limits.maxFiles`, so a
 *   truncated closure is accompanied by a truncated graph and the correct
 *   guard engages anyway (verified directly). Treating it as blocking here
 *   would double-count one condition through two mechanisms, and would let
 *   a limit on the closure veto a proof whose own traversal completed.
 *
 * The non-widening {@link DynamicCallReason} values (`unsupported_construct`,
 * `dynamic_member_access`, `unresolved_target`) are NOT APPLICABLE: a
 * closure never emits them (see {@link ClosureIncompletenessReason}), and
 * their uncertainty is bounded to values and modules already discovered,
 * so they could not load a new module even if it did.
 */
export function invalidatesCallGraphNegativeProof(
  reason: ClosureIncompletenessReason,
): boolean {
  return reason !== "traversal_truncated";
}

/**
 * The distinct closure conditions that forbid a call-graph-derived
 * NOT_AFFECTED for this scan (VT-307e), or `[]` when none do.
 *
 * An ABSENT closure yields `[]`, deliberately: `undefined` means no
 * module-load information was available at all (no entrypoints, or a
 * construction failure), which is the pre-VT-307d status quo for these
 * two proofs and is not itself evidence of a blocker. See
 * `buildFinding`'s own note on the residual risk that leaves.
 */
export function callGraphNegativeProofBlockers(
  closure: ModuleLoadClosure | undefined,
): readonly ClosureIncompletenessReason[] {
  if (closure === undefined) {
    return [];
  }
  return [...new Set(closure.incompleteness.map((i) => i.reason))].filter(
    invalidatesCallGraphNegativeProof,
  );
}

/** Whether `filePath` is guaranteed to be loaded from the closure's entrypoint roots. */
export function closureContainsFile(
  closure: ModuleLoadClosure,
  filePath: string,
): boolean {
  return closure.loadedFiles.includes(filePath);
}

/**
 * Whether the installed package instance rooted at `packageInstance` is
 * guaranteed to be loaded. Keyed by install LOCATION, never package name
 * (VT-212/VT-306): `node_modules/foo` and
 * `node_modules/bar/node_modules/foo` share one identity but are two
 * distinct instances, and only the one actually imported belongs to the
 * closure.
 */
export function closureContainsPackageInstance(
  closure: ModuleLoadClosure,
  packageInstance: PackageInstanceId,
): boolean {
  return closure.loadedPackageInstances.includes(packageInstance);
}
