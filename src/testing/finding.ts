import { createAnalysisProofContext } from "../analysis/analysis-context.js";
import { buildFinding, type BuildFindingOptions } from "../analysis/verdict.js";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type { CallGraph } from "../domain/graph.js";
import type { KnownPackageRoots } from "../domain/resolved-target.js";
import type { Finding } from "../domain/verdict.js";
import type { ModuleLoadClosure } from "../analysis/module-load-closure.js";

/**
 * THE canonical way for a test to call `buildFinding` (VT-CONTRACT-03).
 *
 * VT-CONTRACT-03 moved every per-scan, proof-relevant input behind one
 * branded {@link AnalysisProofContext}, precisely so no caller can assemble
 * a proof out of pieces from two different scans. Tests still want to vary
 * those pieces one at a time -- a synthetic graph here, a hand-built
 * closure there -- so this helper takes the flat shape they already use and
 * builds ONE valid context from it.
 *
 * It exists so there is exactly one place that constructs a test context,
 * rather than sixty ad-hoc ones. That matters for more than tidiness: a
 * test that hand-rolls its own context object is a test that can silently
 * stop exercising the real contract when the contract changes.
 *
 * It deliberately does NOT weaken the production type. Every context it
 * creates goes through the real `createAnalysisProofContext`, so it is
 * genuinely branded, genuinely marked and genuinely internally consistent
 * -- a test using this helper cannot accidentally construct the
 * cross-context state the production API now forbids. Tests that want to
 * prove the guard works must build two contexts and cross-wire them
 * explicitly (see verdict.analysis-context.test.ts), which is exactly the
 * visibility this arrangement is meant to force.
 */
export interface BuildFindingForTestOptions extends Omit<
  BuildFindingOptions,
  "context"
> {
  readonly graph: CallGraph;
  readonly entrypoints: readonly Entrypoint[];
  readonly resolver: ModuleResolver;
  readonly projectRoot: string;
  readonly knownPackageRoots?: KnownPackageRoots;
  readonly graphTruncated?: boolean;
  readonly moduleLoadClosure?: ModuleLoadClosure;
}

export function buildFindingForTest(
  options: BuildFindingForTestOptions,
): Promise<Finding | undefined> {
  const {
    graph,
    entrypoints,
    resolver,
    projectRoot,
    knownPackageRoots,
    graphTruncated,
    moduleLoadClosure,
    ...finding
  } = options;

  return buildFinding({
    ...finding,
    context: createAnalysisProofContext({
      projectRoot,
      resolver,
      entrypoints,
      knownPackageRoots,
      graph,
      graphTruncated,
      moduleLoadClosure,
    }),
  });
}
