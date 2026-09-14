import type { AuthoritativePackageEntry } from "../code-intelligence/package-entry.js";
import type { CallGraph } from "../domain/graph.js";
import {
  type KnownPackageRoots,
  type ScanModuleIdentityCache,
  identifyModule,
} from "../domain/resolved-target.js";

/**
 * ONE scan's derived lookup structures (Foundation F5).
 *
 * Everything here is DERIVED from an analysis that is already final --
 * never a second copy of authoritative state, and never a place a value
 * originates. Removing this object changes how much work a scan repeats
 * and changes no finding, no verdict, no evidence, no proof family, no
 * diagnostic and no unreported candidate.
 *
 * WHY THIS SHAPE. F5's baseline profile found the dominant redundancy is
 * not any single expensive call but a MULTIPLIER: `verdict.ts`'s
 * `graphPackageInstances` re-derives "which installed instances of this
 * package name does the call graph contain" by walking EVERY graph node
 * and identifying each one, and it does that once per resolved advisory
 * target. On this repository's real-package corpus that produced 2,614
 * node identifications for 17 target resolutions, and the worst single
 * shape was a 690-node graph built from two files. The cost is
 * `findings x targets x nodes`, unbounded in graph size. One pass, kept,
 * replaces all of them.
 *
 * OWNERSHIP AND LIFETIME. Created exactly once per scan, by
 * `createAnalysisProofContext` -- the same factory that already binds the
 * graph, the registry, the entrypoints and the resolver into one immutable
 * object. That is deliberate rather than incidental: it is what makes the
 * memo keys below COMPLETE. `resolveAuthoritativePackageEntries`, for
 * instance, is keyed on `(packageInstance, specifier)` alone because its
 * other inputs -- the resolver, the reference context derived from
 * `projectRoot`, the entrypoint files, the registry -- are fields of the
 * one context that owns this object and cannot vary while it lives. A
 * caller cannot obtain this object without going through that context, so
 * there is no way to consult it under a different set of those inputs.
 *
 * NOT A PROOF INPUT. `buildFinding` withdraws these caches for a context
 * that fails its runtime identity check, exactly as it withdraws the
 * module-load closure -- an untrusted context's derived state is never
 * consulted, and the analysis falls back to computing everything itself.
 */
export interface ScanAnalysisCaches {
  /** The graph every index here was derived from. Compared by REFERENCE before any index is used. */
  readonly graph: CallGraph;
  /** The registry every index here was derived from. Compared by REFERENCE before any index is used. */
  readonly knownPackageRoots: KnownPackageRoots | undefined;
  /** This scan's module-identity memo (see {@link ScanModuleIdentityCache}). */
  readonly identity: ScanModuleIdentityCache;
  /**
   * `resolveAuthoritativePackageEntries`'s per-analysis memo, keyed
   * `(packageInstance, requestedModuleSpecifier)` by that function itself.
   *
   * This memo already existed with exactly that key; F5 only widens its
   * LIFETIME from one finding to one scan. The widening is what lets two
   * advisories naming the same package share one public-entry resolution
   * -- the shape it was always meant to cover, and the shape a per-finding
   * memo structurally cannot. Its key stays exact: the canonical
   * `PackageInstanceId`, never a package name and never a name@version, so
   * two same-name/same-version installs at different physical roots can
   * never read each other's entries.
   */
  readonly publicEntries: Map<string, AuthoritativePackageEntry[]>;
  /**
   * Lazily built, because a scan that produces no finding must not pay for
   * an index nothing reads. Written exactly once (see
   * {@link graphPackageInstancesByName}).
   */
  graphPackageIndex?: GraphPackageInstanceIndex;
}

/**
 * Every installed package instance the call graph contains, grouped by the
 * package NAME it was attributed to and then by its canonical
 * `PackageInstanceId` -- one forward pass over `graph.nodes`, kept for the
 * scan.
 *
 * IDENTITY IS PRESERVED EXACTLY. The grouping key is the canonical
 * instance root {@link identifyModule} produced, never the package name,
 * never a version, never a directory basename. Two installs of `foo@1.0.0`
 * under two different physical roots are two `PackageInstanceId`s and
 * therefore two entries, in this index exactly as in the scan that walks
 * the graph itself.
 *
 * ORDER IS PRESERVED EXACTLY. The index is built by iterating
 * `graph.nodes` once, in order, appending into each package name's bucket.
 * For any one package name, the instances therefore appear in
 * first-seen-among-that-name's-nodes order -- which is precisely the order
 * the per-name scan it replaces produced, because that scan visited the
 * same nodes in the same order and skipped the others. Callers that
 * materialize `[...instances.entries()]` and select from it see an
 * identical sequence.
 */
export interface GraphPackageInstanceIndex {
  /** The graph this index describes. */
  readonly graph: CallGraph;
  /** The registry the attributions were made under. */
  readonly knownPackageRoots: KnownPackageRoots | undefined;
  /**
   * `graph.nodes.length` when the index was built.
   *
   * A STALENESS GUARD, not a completeness proof. The analysis contract is
   * that the graph is final before any finding is built, and production
   * upholds it: `cli/scan.ts` builds the graph, decides truncation, and
   * only then creates the context this index hangs off. This check exists
   * because F4 recorded -- and deliberately did not close -- the fact that
   * a context's referenced inputs are live aliases rather than transitive
   * snapshots. If the node list grows or shrinks after this index was
   * taken, every query falls back to scanning the graph directly, so an
   * index can never answer for a graph it no longer describes. It does NOT
   * detect a node mutated in place; nothing in this codebase does, and F5
   * does not claim to (see the F5 record's mutability note).
   */
  readonly nodeCount: number;
  readonly byPackageName: ReadonlyMap<string, ReadonlyMap<string, Set<string>>>;
}

/**
 * Builds {@link GraphPackageInstanceIndex} in one forward pass.
 *
 * Every node is identified through `cache`, so the per-scan identity memo
 * absorbs the repetition WITHIN this pass too (a 690-node graph built from
 * two files costs two identifications, not 690).
 */
export function buildGraphPackageInstanceIndex(
  graph: CallGraph,
  knownPackageRoots: KnownPackageRoots | undefined,
  cache: ScanModuleIdentityCache | undefined,
): GraphPackageInstanceIndex {
  const byPackageName = new Map<string, Map<string, Set<string>>>();
  for (const node of graph.nodes) {
    const identity = identifyModule(node.module, knownPackageRoots, cache);
    if (identity.packageName === undefined || !identity.packageInstance) {
      continue;
    }
    let byInstance = byPackageName.get(identity.packageName);
    if (byInstance === undefined) {
      byInstance = new Map<string, Set<string>>();
      byPackageName.set(identity.packageName, byInstance);
    }
    const files = byInstance.get(identity.packageInstance);
    if (files === undefined) {
      byInstance.set(identity.packageInstance, new Set<string>([node.module]));
    } else {
      files.add(node.module);
    }
  }
  return {
    graph,
    knownPackageRoots,
    nodeCount: graph.nodes.length,
    byPackageName,
  };
}

/**
 * The instances of `packageName` the call graph contains, from `caches`'s
 * index -- or `undefined` when this query must not be answered from an
 * index at all, which is every case where the caller's own inputs are not
 * provably the ones the index was derived from:
 *
 * - no caches were supplied (an untrusted context, or a direct
 *   `buildFinding` caller that has none);
 * - the caller's graph or registry is not the one the caches were bound to
 *   (reference inequality -- a cross-wired or re-derived input);
 * - the graph's node count no longer matches the indexed one.
 *
 * `undefined` means "scan the graph yourself", never "there are none". The
 * two are opposite claims and conflating them would be exactly the
 * cached-absence defect a performance layer must never introduce: an empty
 * result here would read as "this package instance was never traversed",
 * which is positive evidence in `resolveTargetNodes`.
 */
export function graphPackageInstancesByName(
  caches: ScanAnalysisCaches | undefined,
  graph: CallGraph,
  knownPackageRoots: KnownPackageRoots | undefined,
  packageName: string,
): ReadonlyMap<string, Set<string>> | undefined {
  if (
    !caches ||
    caches.graph !== graph ||
    caches.knownPackageRoots !== knownPackageRoots
  ) {
    return undefined;
  }
  let index = caches.graphPackageIndex;
  if (index === undefined) {
    index = buildGraphPackageInstanceIndex(
      graph,
      knownPackageRoots,
      caches.identity,
    );
    caches.graphPackageIndex = index;
  }
  if (index.nodeCount !== graph.nodes.length) {
    return undefined;
  }
  return index.byPackageName.get(packageName) ?? EMPTY_INSTANCES;
}

/**
 * The answer for a package name the graph contains no instance of.
 *
 * Shared and empty rather than freshly allocated: it is never written to
 * (the index is built once and read thereafter), and a package name with
 * no graph instances is the common case on any project with more
 * dependencies than advisories.
 */
const EMPTY_INSTANCES: ReadonlyMap<string, Set<string>> = new Map<
  string,
  Set<string>
>();

/** Creates the one {@link ScanAnalysisCaches} for one scan. */
export function createScanAnalysisCaches(input: {
  readonly graph: CallGraph;
  readonly knownPackageRoots: KnownPackageRoots | undefined;
  readonly identity: ScanModuleIdentityCache;
}): ScanAnalysisCaches {
  return {
    graph: input.graph,
    knownPackageRoots: input.knownPackageRoots,
    identity: input.identity,
    publicEntries: new Map<string, AuthoritativePackageEntry[]>(),
  };
}
