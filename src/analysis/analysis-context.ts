import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import type { CallGraph } from "../domain/graph.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type { KnownPackageRoots } from "../domain/resolved-target.js";
import type { ModuleLoadClosure } from "./module-load-closure.js";

/**
 * THE PROOF-CONTEXT CONTRACT (VT-CONTRACT-03).
 *
 * A negative proof is only meaningful relative to the analysis it came
 * from. "This exact package instance is absent from a complete module-load
 * closure" says nothing at all if the closure was built for a DIFFERENT
 * project: a foreign closure trivially does not contain this project's
 * install paths, so absence from it is guaranteed and proves nothing.
 *
 * Before VT-CONTRACT-03 that safety property rested entirely on caller
 * discipline. `buildFinding` accepted the project root, the entrypoints,
 * the `KnownPackageRoots`, the call graph, its truncation flag and the
 * `ModuleLoadClosure` as six independent options, so any caller could
 * supply five of them from one scan and the sixth from another. That is
 * not hypothetical -- it was reproduced end-to-end against the merged
 * tree: a package instance that was genuinely loaded AND called (reached
 * through an ESM `export * from` re-export, which call-graph discovery
 * does not follow, so the closure gate is consulted) correctly produced
 * UNKNOWN against its own closure, and a FALSE `NOT_AFFECTED` via proof
 * family A the moment a complete closure from an unrelated project was
 * passed instead. The forged evidence even carried one project's
 * `packageInstance` beside the other project's `entrypointRoots`.
 *
 * This module makes that mixture unrepresentable rather than merely
 * discouraged. Every proof-relevant input a scan produces is carried in
 * ONE immutable object, created once, that `buildFinding` accepts whole.
 * Cross-wiring is no longer a matter of passing the wrong argument -- a
 * caller would have to fabricate an entire context, which the brand below
 * prevents at compile time and the runtime mark detects if the type system
 * is bypassed with a cast.
 *
 * Deliberately NOT branded: `Vulnerability`, `VulnerableSymbolRule`,
 * `VersionMatchResult`, `packageInstance`. Those are per-FINDING inputs,
 * not per-scan state, and one context legitimately serves every finding in
 * a scan (see `cli/scan.ts`, which builds one context and reuses it across
 * every advisory and every installed instance). Branding them would be the
 * over-generalization this task explicitly rules out.
 */

/**
 * Nominal brand. Declared but never exported as a value, so no object
 * literal outside {@link createAnalysisProofContext} can satisfy
 * {@link AnalysisProofContext} -- `{ projectRoot, entrypoints, ... }` is
 * rejected by the compiler even when every visible field is correct.
 */
declare const analysisProofContextBrand: unique symbol;

/**
 * Runtime identity mark, checked by `buildFinding`. Type-level nominality
 * is defeated by a single `as unknown as AnalysisProofContext` cast, and a
 * cast is exactly what a cross-wiring caller would reach for once the
 * compiler starts objecting -- so the invariant is also carried by a
 * value the caller cannot plausibly produce by accident.
 *
 * A module-private `Symbol()` rather than `Symbol.for()`: the global
 * registry would let any code in the process mint the identical symbol.
 * A unique object reference, per the task's guidance -- no UUID, no
 * randomness, nothing to make tests non-deterministic.
 */
const CONTEXT_MARK = Symbol("vulntrace.analysisProofContext");

/**
 * Every proof-relevant artifact of ONE scan, bound together.
 *
 * Immutable and created once per scan. The fields are exactly those a
 * negative proof reads or reports; nothing here is per-finding.
 */
export interface AnalysisProofContext {
  /** Nominal brand -- see {@link analysisProofContextBrand}. */
  readonly [analysisProofContextBrand]: true;
  /** The scanned project's root, used to resolve the rule-target reference file. */
  readonly projectRoot: string;
  /** The resolver this scan's graph and closure were both built with. */
  readonly resolver: ModuleResolver;
  /**
   * The configured/discovered entrypoints this scan analyzed. Families B
   * and C report these as their proof's `entrypointRoots`, so binding them
   * here is what stops a proof from being reported against roots it was
   * never established over.
   */
  readonly entrypoints: readonly Entrypoint[];
  /** This scan's dependency-provenance registry (VT-307c-fix-4b). */
  readonly knownPackageRoots: KnownPackageRoots | undefined;
  /** This scan's call graph. */
  readonly graph: CallGraph;
  /**
   * Whether THIS scan's call-graph construction hit a configured resource
   * limit (VT-202). A per-scan fact and a proof precondition, so it lives
   * with the graph it describes rather than as a loose boolean a caller
   * could set independently of the graph it is supposed to describe.
   */
  readonly graphTruncated: boolean;
  /**
   * This scan's single gate-eligible {@link ModuleLoadClosure}, or
   * `undefined` when none could be built. `undefined` means NO absence
   * proof is available -- never "an empty closure" -- exactly as before.
   */
  readonly moduleLoadClosure: ModuleLoadClosure | undefined;
}

/**
 * Whether `closure` was built over exactly `entrypoints` -- i.e. whether it
 * is THIS context's closure at all.
 *
 * Bundling the proof inputs into one object stops them being MIXED by
 * accident, but a deliberate caller can still hand
 * {@link createAnalysisProofContext} one scan's graph beside another
 * scan's closure. Nothing about the closure's own shape reveals that: a
 * foreign closure is a perfectly well-formed, `complete` closure, and its
 * not containing this project's install paths -- the very thing family A
 * reads as proof -- is guaranteed rather than informative. That is exactly
 * how the pre-fix reproduction manufactured a false NOT_AFFECTED.
 *
 * `rootFiles` is what makes the association checkable without hashing
 * anything: `buildModuleLoadClosure` sets it to precisely the deduplicated
 * `filePath`s of the entrypoints it traversed, so a closure belongs to
 * this context if and only if those two sets are equal. A closure from
 * another project fails on the paths themselves; a closure from the SAME
 * project built over a DIFFERENT entrypoint set also fails, which is
 * correct -- "unreachable from these roots" is not transferable to other
 * roots.
 *
 * O(number of entrypoints), on an array that is normally one to a handful
 * of paths. Deliberately NOT a hash of the project, a comparison of
 * `loadedFiles`, or any traversal of the closure's contents.
 */
function closureRootsMatchEntrypoints(
  closure: ModuleLoadClosure | undefined,
  entrypoints: readonly Entrypoint[],
): boolean {
  if (!closure) {
    return false;
  }
  const roots = new Set(closure.rootFiles);
  const expected = new Set(
    entrypoints.map((entrypoint) => entrypoint.filePath),
  );
  if (roots.size !== expected.size) {
    return false;
  }
  for (const root of roots) {
    if (!expected.has(root)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether `graph` was built over these same entrypoints -- i.e. whether the
 * closure and the graph describe ONE analysis.
 *
 * Binding the closure to the entrypoints alone is not enough, and this was
 * demonstrated rather than assumed: a caller who swaps the entrypoints AND
 * the closure together keeps that pair mutually consistent, so the root
 * check passes, while the graph, `KnownPackageRoots` and `packageInstance`
 * still come from the project under analysis. That combination forged a
 * family-A NOT_AFFECTED for a genuinely loaded-and-called instance -- the
 * original hazard, reassembled one layer up.
 *
 * `buildCallGraph` indexes each entry FILE as a module node keyed by its
 * own path (see `moduleNode` in verdict.ts, which resolves entrypoints the
 * same way), so a graph built over different roots simply does not contain
 * these entrypoints. Checking that closes the swap: the attacker's donor
 * entrypoints are absent from the victim project's graph.
 *
 * Computed ONCE per context, not per proof: one pass over the node list to
 * build the lookup, then a set membership test per entrypoint. No hashing,
 * no closure traversal, and nothing recomputed per finding.
 */
function graphCoversEntrypoints(
  graph: CallGraph,
  entrypoints: readonly Entrypoint[],
): boolean {
  if (entrypoints.length === 0) {
    return false;
  }
  const moduleFiles = new Set(
    graph.nodes
      .filter((node) => node.kind === "module")
      .map((node) => node.module),
  );
  return entrypoints.every((entrypoint) =>
    moduleFiles.has(entrypoint.filePath),
  );
}

/** The inputs one scan supplies; the brand and mark are added here. */
export interface AnalysisProofContextInput {
  readonly projectRoot: string;
  readonly resolver: ModuleResolver;
  readonly entrypoints: readonly Entrypoint[];
  readonly knownPackageRoots?: KnownPackageRoots;
  readonly graph: CallGraph;
  readonly graphTruncated?: boolean;
  readonly moduleLoadClosure?: ModuleLoadClosure;
}

/**
 * Creates the one proof context for a scan.
 *
 * Call this ONCE per scan, after the dependency graph, `KnownPackageRoots`,
 * entrypoints, call graph and module-load closure all exist, and thread
 * the result into every `buildFinding` call. Never call it per finding:
 * that would not be unsound (each context would still be internally
 * consistent) but it would rebuild the same object for every advisory and
 * lose the single-context property this exists to express.
 *
 * The returned object is frozen, with `entrypoints` copied and frozen too,
 * so a later mutation cannot retroactively change what a proof was
 * established over.
 */
export function createAnalysisProofContext(
  input: AnalysisProofContextInput,
): AnalysisProofContext {
  const entrypoints = Object.freeze([...input.entrypoints]);

  const context = {
    projectRoot: input.projectRoot,
    resolver: input.resolver,
    entrypoints,
    knownPackageRoots: input.knownPackageRoots,
    graph: input.graph,
    graphTruncated: input.graphTruncated ?? false,
    // The closure is kept only if it and the graph BOTH belong to these
    // entrypoints. Either check alone is defeatable: binding the closure to
    // the entrypoints lets a caller swap the pair together, and binding the
    // graph alone says nothing about which analysis produced the closure.
    // Together they pin one scan. A closure that fails either test is
    // dropped rather than carried, so the finding falls through the same
    // conservative path a scan with no closure already takes.
    moduleLoadClosure:
      closureRootsMatchEntrypoints(input.moduleLoadClosure, entrypoints) &&
      graphCoversEntrypoints(input.graph, entrypoints)
        ? input.moduleLoadClosure
        : undefined,
  };

  // Non-enumerable so the mark never reaches JSON.stringify, Object.keys,
  // a spread, or any serialized output. It is an internal correctness
  // mechanism, not evidence (see the serialization tests).
  Object.defineProperty(context, CONTEXT_MARK, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return Object.freeze(context) as unknown as AnalysisProofContext;
}

/**
 * Whether `value` is a context this module actually created.
 *
 * `buildFinding` fails CLOSED on `false`: it keeps analyzing, but with
 * every negative proof withdrawn, so a fabricated context can never
 * manufacture a `NOT_AFFECTED`. It deliberately does not throw -- see
 * `buildFinding`'s own comment for why an exception would be the wrong
 * failure mode for a library entry point.
 */
export function isAnalysisProofContext(
  value: unknown,
): value is AnalysisProofContext {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[CONTEXT_MARK] === true
  );
}
