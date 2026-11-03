import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import { toVerdictObservation } from "../../src/testing/oracle/scan.js";
import {
  loadDefectRegisters,
  VERDICT_DOMAIN,
} from "../../src/testing/open-soundness-defect.js";
import { trustBoundaryCaseProblems } from "../../src/testing/trust-boundary-case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./bl122-trust-boundary-reach.cases.js";

/**
 * Task BL-122 (docs/tasks/BL-122-trust-boundary-reach.md): the builtin
 * objects outside the intrinsic prototypes that Node's own loader touches,
 * against real Node. Task BL-126: under the project owner's (W-all)
 * decision every one is a built-in object the trust boundary covers
 * (SOUNDNESS-CONTRACT § 1), so a route the analyzer misses is a
 * trust-boundary case (RWF-161, RWF-162, RWF-163, documented
 * limitations), never an expectation; a control asserts its sound verdict.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.mechanism} -- ${kase.boundaryCase ? `trust boundary; sound without it: ${kase.expected}` : kase.expected}`, async () => {
    if (kase.boundaryCase) {
      // A documented case of the trust boundary (SOUNDNESS-CONTRACT § 1,
      // tasks BL-113 and BL-126): fails when the analyzer starts answering
      // soundly without the boundary (delete the record), when the result
      // drifts (re-measure), and when the finding is no longer a
      // documented limitation.
      const result = await runOracleCase(oracleCase(kase));
      expect(
        result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
        `real Node v${process.versions.node}'s ground truth`,
      ).toBe(kase.called);
      const coverage = result.variant.scan.output?.coverage;
      expect(coverage).toBeDefined();
      const ctrl = ALL_CASES.find((c) => c.id === kase.boundaryCase!.control);
      if (ctrl === undefined) {
        throw new Error(
          `${kase.id}: no control case ${kase.boundaryCase.control}`,
        );
      }
      expect(
        trustBoundaryCaseProblems(
          {
            caseId: kase.id,
            rwf: kase.boundaryCase.rwf,
            soundWithoutBoundary: [kase.expected],
            observed: kase.boundaryCase.observed,
            control: {
              caseId: kase.boundaryCase.control,
              called: ctrl.called,
            },
          },
          VERDICT_DOMAIN,
          toVerdictObservation(result.variant.scan.findings[0], coverage!),
          loadDefectRegisters().findings,
        ),
      ).toEqual([]);
      return;
    }
    const result = await runOracleCase({
      ...oracleCase(kase),
      expectation: { verdict: kase.expected, calledMarker: TARGET_MARKER },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
      `real Node v${process.versions.node}'s ground truth`,
    ).toBe(kase.called);
  });
});
