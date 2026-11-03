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
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./bl126-main-module-children.cases.js";

/**
 * Task BL-126 (docs/tasks/BL-126-trust-boundary-all-builtins.md; its
 * independent audit, round 1, B1): a change to a module loader object
 * reached through `process.mainModule.children`, inside the claim under
 * the trust boundary (SOUNDNESS-CONTRACT § 1), against real Node. A route
 * the analyzer misses is an open-soundness-defect record (RWF-165), never
 * an expectation; the modeled route and the control assert their verdicts.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.mechanism} -- ${kase.expected}`, async () => {
    if (kase.openDefect) {
      // Fails when the defect is fixed (delete the record) and when it
      // drifts (re-measure).
      const result = await runOracleCase(oracleCase(kase));
      expect(
        result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
        `real Node v${process.versions.node}'s ground truth`,
      ).toBe(kase.called);
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
      ...oracleCase(kase),
      expectation: { verdict: kase.expected, calledMarker: TARGET_MARKER },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
      `real Node v${process.versions.node}'s ground truth`,
    ).toBe(kase.called);
  });
});
