import { createAnalysisProofContext } from "../analysis/analysis-context.js";
import { buildFinding, type BuildFindingOptions } from "../analysis/verdict.js";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type { CallGraph } from "../domain/graph.js";
import type { KnownPackageRoots } from "../domain/resolved-target.js";
import type { Finding } from "../domain/verdict.js";
import {
  buildGateEligibleModuleLoadClosure,
  type ModuleLoadClosure,
} from "../analysis/module-load-closure.js";

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
  /**
   * The scan's closure. When omitted, this helper BUILDS A REAL ONE from
   * `entrypoints` + `resolver` + `knownPackageRoots`, exactly as
   * `cli/scan.ts` does -- see the note on
   * {@link BuildFindingForTestOptions.syntheticGraphHasNoRealFiles}.
   */
  readonly moduleLoadClosure?: ModuleLoadClosure;
  /**
   * TEST-ONLY OPT-IN for suites whose graphs are entirely synthetic
   * (FOUNDATION-F2/F2-A).
   *
   * A call-graph-derived NOT_AFFECTED now requires a real
   * `ModuleLoadClosure`: an absent one is a blocker
   * (`module_load_closure_unavailable`), because the loader, syntax-
   * validity and execution-capability preconditions it establishes are
   * things the call graph structurally cannot check for itself. That is a
   * production invariant, and this helper deliberately does not let a test
   * slip past it by accident.
   *
   * Some suites, though, assert over graphs built from fake paths that
   * never exist on disk (`/node_modules/fixture-lib/index.js`). No real
   * closure can be built there -- traversal would record `parse_failure`
   * for every unreadable root -- so those tests declare the situation
   * explicitly with this flag and get a closure rooted at their synthetic
   * entrypoints with no incompleteness. This is the same class of
   * narrowly-scoped, deliberately-visible test affordance as
   * `allowSyntheticNameOnlyTargetBinding` on `buildFinding` itself, and it
   * exists for the same reason: the alternative is silently weakening the
   * production guard for everyone.
   *
   * It must never be set by a test that has real files on disk. Those
   * build a real closure through the default path above, which is strictly
   * more faithful to production than what they did before F2-A (no
   * closure at all).
   */
  readonly syntheticGraphHasNoRealFiles?: boolean;
  /**
   * Withhold the closure entirely, so `buildFinding` sees the genuine
   * absence case (FOUNDATION-F2/F2-A).
   *
   * Needed because the default above BUILDS a closure, which makes
   * `moduleLoadClosure: undefined` indistinguishable from "not supplied".
   * The tests that exist to prove absence fails closed must be able to say
   * so explicitly rather than by omission -- an omission that a future
   * reader could not tell apart from an oversight, and that the helper
   * would silently fill in.
   */
  readonly moduleLoadClosureUnavailable?: boolean;
}

export async function buildFindingForTest(
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
    syntheticGraphHasNoRealFiles = false,
    moduleLoadClosureUnavailable = false,
    ...finding
  } = options;

  const closure = moduleLoadClosureUnavailable
    ? undefined
    : (moduleLoadClosure ??
      (await defaultTestClosure({
        entrypoints,
        resolver,
        knownPackageRoots,
        syntheticGraphHasNoRealFiles,
      })));

  return buildFinding({
    ...finding,
    context: createAnalysisProofContext({
      projectRoot,
      resolver,
      entrypoints,
      knownPackageRoots,
      graph,
      // `AnalysisProofContextInput.graphTruncated` is REQUIRED in
      // production (F2-B). Tests that do not care about coverage keep the
      // old ergonomics here, in ONE place, rather than each restating it.
      graphTruncated: graphTruncated ?? false,
      moduleLoadClosure: closure,
    }),
  });
}

/**
 * The closure a test gets when it did not supply one: a REAL one wherever
 * that is possible, and an explicitly-declared synthetic one where it is
 * not (see {@link BuildFindingForTestOptions.syntheticGraphHasNoRealFiles}).
 *
 * `undefined` is still returned for the genuinely-absent cases -- no
 * entrypoints at all, or a construction failure -- so the tests that exist
 * to prove absence fails closed still see absence.
 */
async function defaultTestClosure(input: {
  readonly entrypoints: readonly Entrypoint[];
  readonly resolver: ModuleResolver;
  readonly knownPackageRoots?: KnownPackageRoots;
  readonly syntheticGraphHasNoRealFiles: boolean;
}): Promise<ModuleLoadClosure | undefined> {
  const rootFiles = [...new Set(input.entrypoints.map((e) => e.filePath))];
  if (rootFiles.length === 0) {
    return undefined;
  }

  if (input.syntheticGraphHasNoRealFiles) {
    return {
      rootFiles,
      loadedFiles: rootFiles,
      loadedPackageInstances: [],
      complete: true,
      incompleteness: [],
    };
  }

  try {
    return await buildGateEligibleModuleLoadClosure({
      entrypoints: input.entrypoints,
      resolver: input.resolver,
      knownPackageRoots: input.knownPackageRoots ?? new Map(),
    });
  } catch {
    return undefined;
  }
}
