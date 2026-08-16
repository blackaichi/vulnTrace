import type { ModuleResolver } from "../code-intelligence/module-resolver.js";

/**
 * Phase timings recorded for one scan (see docs/SDD.md § 30: "Performance
 * instrumentation must record: parsing time; resolution time; graph
 * construction time; reachability time; provider time; cache hit/miss").
 *
 * `parsingMs` is *derived*, not independently measured: parsing
 * (`indexSourceFileFromDisk`) and resolution (`resolver.resolve`) are
 * interleaved within `buildCallGraph`'s single on-demand traversal, with
 * no existing seam to instrument parsing in isolation without threading a
 * timing accumulator through `code-intelligence/`'s internals — out of
 * scope for this task (see completion report). Resolution time *is*
 * independently measurable, via {@link createTimingResolver} wrapping the
 * `ModuleResolver` interface that already exists as an injection seam,
 * so `parsingMs = graphConstructionMs - resolutionMs`: the remainder of
 * graph-construction wall time once resolution is subtracted out. This is
 * an honest approximation (also covers node/edge bookkeeping inside
 * `buildCallGraph`), not a pure parse-only timer.
 */
export interface PhaseTimings {
  readonly parsingMs: number;
  readonly resolutionMs: number;
  readonly graphConstructionMs: number;
  readonly reachabilityMs: number;
  readonly providerMs: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly totalMs: number;
}

/** A mutable accumulator `createTimingResolver` adds elapsed time into, read back once the scan completes. */
export interface TimingAccumulator {
  ms: number;
}

/**
 * Wraps a {@link ModuleResolver} to accumulate the total wall time spent
 * inside `resolve()` calls, without modifying `module-resolver.ts` itself
 * — the same non-invasive decorator approach already used for OSV caching
 * (`createCachingProvider`), reusing `ModuleResolver`'s existing injection
 * seam (see AGENTS.md: "Keep provider-specific data behind interfaces").
 */
export function createTimingResolver(
  resolver: ModuleResolver,
  accumulator: TimingAccumulator,
): ModuleResolver {
  return {
    async resolve(specifier, importerFilePath) {
      const start = Date.now();
      try {
        return await resolver.resolve(specifier, importerFilePath);
      } finally {
        accumulator.ms += Date.now() - start;
      }
    },
  };
}
