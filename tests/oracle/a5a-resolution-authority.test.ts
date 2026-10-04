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
} from "./a5a-resolution-authority.cases.js";

/**
 * Task A-5a (docs/tasks/A-5a-resolution-authority.md): ADR 0008 invariant
 * A2 on the call-graph side -- VT-213 (PRM-13), constant folding (PRM-14),
 * the lexical `require` (PRM-15), VT-210 (PRM-16, PRM-17, RWF-071) and
 * `function` declaration stability (PRM-104) -- against real Node. On the
 * base commit every case whose `base` differs from its `expected` was
 * wrong: a false `NOT_AFFECTED` where real Node calls the target, or a
 * fabricated `AFFECTED` path where it never does; nothing here pins a base
 * verdict.
 *
 * Every case asserts its sound verdict through the harness's own
 * `expectation`, and checks real Node's answer against the case's
 * `called`. A case still answered wrongly for a reason A-5a does not own
 * is an open-soundness-defect record, never an expectation.
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
