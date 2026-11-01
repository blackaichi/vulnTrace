import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import { toVerdictObservation } from "../../src/testing/oracle/scan.js";
import {
  loadDefectRegisters,
  openSoundnessDefectProblems,
  VERDICT_DOMAIN,
  type OpenSoundnessDefect,
  type Verdict,
  type VerdictObservation,
} from "../../src/testing/open-soundness-defect.js";
import { trustBoundaryCaseProblems } from "../../src/testing/trust-boundary-case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./bl114-require-esm-inherited-source.cases.js";

/**
 * Task BL-114 (docs/tasks/BL-114-loader-inventory-node-releases.md): the
 * loader routes that are live only on some Node releases, against the real
 * Node running the suite. A case the analyzer misses is an
 * open-soundness-defect record, never an expectation: the analyzer does not
 * know the deployed release (as RWF-085), so the sound verdict is the same
 * on every release, and only real Node's ground truth differs
 * (`node-release-routes.ts`). Task BL-113: RWF-156, RWF-158 and RWF-160
 * are the trust boundary's documented limitation (SOUNDNESS-CONTRACT § 1),
 * and their cases are trust-boundary cases, never an expectation.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.mechanism} -- ${kase.boundaryCase ? `trust boundary; sound without it: ${kase.expected}` : kase.expected}`, async () => {
    const called = kase.called();
    const bl096Case = { ...kase, called };
    if (kase.boundaryCase) {
      // A documented case of the trust boundary (SOUNDNESS-CONTRACT § 1,
      // task BL-113): fails when the analyzer starts answering soundly
      // without the boundary (delete the record), when the result drifts
      // (re-measure), and when the finding is no longer a documented
      // limitation.
      const result = await runOracleCase(oracleCase(bl096Case));
      expect(
        result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
        `real Node v${process.versions.node}'s ground truth`,
      ).toBe(called);
      const coverage = result.variant.scan.output?.coverage;
      expect(coverage).toBeDefined();
      expect(
        trustBoundaryCaseProblems(
          {
            caseId: kase.id,
            rwf: kase.boundaryCase.rwf,
            soundWithoutBoundary: [kase.expected],
            observed: kase.boundaryCase.observed,
          },
          VERDICT_DOMAIN,
          toVerdictObservation(result.variant.scan.findings[0], coverage!),
          loadDefectRegisters().findings,
        ),
      ).toEqual([]);
      return;
    }
    if (kase.openDefect) {
      // Fails when the defect is fixed (delete the record) and when it
      // drifts (re-measure).
      const result = await runOracleCase(oracleCase(bl096Case));
      expect(
        result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
        `real Node v${process.versions.node}'s ground truth`,
      ).toBe(called);
      const coverage = result.variant.scan.output?.coverage;
      expect(coverage).toBeDefined();
      const record: OpenSoundnessDefect<Verdict, VerdictObservation> = {
        caseId: kase.id,
        rwf: kase.openDefect.rwf,
        debt: "D-17",
        admissible: [kase.expected],
        expected: kase.expected,
        observed: kase.openDefect.observed,
      };
      expect(
        openSoundnessDefectProblems(
          record,
          VERDICT_DOMAIN,
          toVerdictObservation(result.variant.scan.findings[0], coverage!),
          loadDefectRegisters(),
        ),
      ).toEqual([]);
      return;
    }
    const result = await runOracleCase({
      ...oracleCase(bl096Case),
      expectation: { verdict: kase.expected, calledMarker: TARGET_MARKER },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
      `real Node v${process.versions.node}'s ground truth`,
    ).toBe(called);
  });
});
