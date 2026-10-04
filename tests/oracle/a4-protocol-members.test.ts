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
} from "./a4-protocol-members.cases.js";

/**
 * Task A-4 (docs/tasks/A-4-protocol-members.md): protocol members
 * (PRM-38, PRM-112, PRM-113, RWF-068) and accessor bodies (PRM-118),
 * against real Node. On the base commit every case marked so was wrong --
 * a false `NOT_AFFECTED` where real Node calls the target, a fabricated
 * `AFFECTED` path where it never does, or (`accessor.literal-getter.read`)
 * the right verdict on a path that does not exist; the case's `base`
 * records each base verdict, and nothing here pins it. The audit's
 * regression guards (`base: "UNKNOWN"`) failed on the version the audit
 * found them on.
 *
 * Every case asserts `UNKNOWN`, the one sound verdict once the member is
 * reached by a possible edge, through the harness's own `expectation`, and
 * checks real Node's answer against the case's `called`. A case still
 * answered wrongly for a reason A-4 does not own (RWF-070, outside ADR
 * 0008's list) is an open-soundness-defect record, never an expectation.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
    if (kase.openDefect) {
      // Fails when the defect is fixed (delete the record) and when it
      // drifts (re-measure).
      const result = await runOracleCase(oracleCase(kase));
      expect(
        result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
        "real Node's ground truth",
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
      "real Node's ground truth",
    ).toBe(kase.called);
  });
});
