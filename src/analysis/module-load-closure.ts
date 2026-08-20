import { buildModuleModel } from "../code-intelligence/module-model.js";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import { indexSourceFileFromDisk } from "../code-intelligence/source-index.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import {
  isClosureWideningReason,
  type CallGraph,
  type DynamicCallReason,
  type SourceLocation,
} from "../domain/graph.js";
import {
  identifyModule,
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
 * - `parse_failure`: a closure member could not be read/parsed, so its own
 *   imports (and therefore everything they would transitively load) are
 *   unknown. Previously invisible entirely -- the VT-307 soundness review
 *   called this out as a missing completeness signal.
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
 * NOTE (VT-307c scope): this type is representation + diagnostics only. No
 * verdict logic consumes it yet -- wiring it into the RWF-002
 * NOT_AFFECTED gate is VT-307d's own, separately-reviewed task.
 */
export interface ModuleLoadClosure {
  /** The configured entrypoint FILES the closure is rooted at (never narrowed by `{file, symbol}` -- see {@link buildModuleLoadClosure}). */
  readonly rootFiles: readonly string[];
  readonly loadedFiles: readonly string[];
  readonly loadedPackageInstances: readonly PackageInstanceId[];
  readonly complete: boolean;
  readonly incompleteness: readonly ClosureIncompleteness[];
}

/**
 * Loader-shaped closure-widening reasons the closure adopts from an
 * already-built {@link CallGraph} rather than re-deriving by its own AST
 * walk (VT-307b classified every one of these; see
 * `classifyLoaderConstruct` in code-intelligence/call-graph.ts).
 *
 * Deliberately excludes `unresolved_module` and
 * `declaration_only_resolution`, the two widening reasons closure
 * traversal detects itself while resolving each specifier: its own record
 * carries the actual specifier text, which the graph edge does not, so
 * taking both would double-report the same fact with strictly less
 * information on one copy.
 */
const LOADER_REASONS_FROM_GRAPH: ReadonlySet<DynamicCallReason> =
  new Set<DynamicCallReason>([
    "dynamic_require",
    "dynamic_import",
    "eval",
    "aliased_require",
    "create_require",
    "function_constructor",
    "aliased_eval",
    "module_require",
  ]);

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
  /**
   * An already-built call graph, used ONLY to adopt loader-shaped
   * closure-widening blockers already classified during graph
   * construction (see {@link LOADER_REASONS_FROM_GRAPH}). Closure
   * *membership* never depends on it -- see {@link ModuleLoadClosure}.
   * Required rather than optional: without it, a file containing
   * `require(dynamicName)` would silently look like a complete closure,
   * and "missing information" must never read as "complete".
   */
  readonly graph: CallGraph;
  /** Bounds traversal (see docs/SDD.md § 26, § 28-29). Reaching it marks the closure incomplete, never silently partial. */
  readonly maxFiles?: number;
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
 */
export async function buildModuleLoadClosure(
  options: BuildModuleLoadClosureOptions,
): Promise<ModuleLoadClosure> {
  const { entrypoints, resolver, graph } = options;
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

    let model;
    try {
      model = buildModuleModel(indexSourceFileFromDisk(filePath));
    } catch {
      incompleteness.push({ reason: "parse_failure", importer: filePath });
      continue;
    }

    const seenSpecifiers = new Set<string>();
    for (const imp of model.imports) {
      if (seenSpecifiers.has(imp.specifier)) {
        continue;
      }
      seenSpecifiers.add(imp.specifier);

      const resolution = await resolver.resolve(imp.specifier, filePath);

      if (resolution.kind === "builtin") {
        continue;
      }
      if (resolution.kind === "unresolved") {
        incompleteness.push({
          reason: "unresolved_module",
          importer: filePath,
          specifier: imp.specifier,
          location: imp.location,
        });
        continue;
      }
      if (resolution.kind === "declaration") {
        incompleteness.push({
          reason: "declaration_only_resolution",
          importer: filePath,
          specifier: imp.specifier,
          location: imp.location,
        });
        continue;
      }

      if (!loadedFiles.has(resolution.resolvedFileName)) {
        queue.push(resolution.resolvedFileName);
      }
    }
  }

  // Adopt loader-shaped widening blockers the call graph already
  // classified, scoped to files this closure actually loads. Scoping
  // matters: a dynamic require in code no entrypoint ever loads says
  // nothing about THIS closure's completeness.
  const moduleByNodeId = new Map(graph.nodes.map((n) => [n.id, n.module]));
  const seenGraphBlockers = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.resolution.kind !== "unknown") {
      continue;
    }
    const { reason } = edge.resolution;
    // Both gates deliberately: membership in the loader set says "this
    // construct is a module loader", and `isClosureWideningReason` is the
    // normative partition (domain/graph.ts). Requiring both means a future
    // edit that reclassifies a reason on either side can never silently
    // let a non-widening construct mark a closure incomplete.
    if (
      !LOADER_REASONS_FROM_GRAPH.has(reason) ||
      !isClosureWideningReason(reason)
    ) {
      continue;
    }
    const importer = moduleByNodeId.get(edge.from);
    if (importer === undefined || !loadedFiles.has(importer)) {
      continue;
    }
    const key = `${reason}|${importer}|${edge.location?.line ?? "?"}:${edge.location?.column ?? "?"}`;
    if (seenGraphBlockers.has(key)) {
      continue;
    }
    seenGraphBlockers.add(key);
    incompleteness.push({ reason, importer, location: edge.location });
  }

  const loadedPackageInstances = new Set<PackageInstanceId>();
  for (const file of loadedFiles) {
    const instance = identifyModule(file).packageInstance;
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
