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
} from "./a3b-own-exports-jsx.cases.js";

/**
 * Task A-3b (docs/tasks/A-3b-own-exports-jsx.md): own-export calls
 * (AUD-02), JSX elements (PRM-116), the automatic JSX runtime's implicit
 * load (RWF-066), each against real Node. On the base commit every case
 * was a false `NOT_AFFECTED` (measured by this task before its fix; see the
 * task file); nothing here pins that result.
 *
 * Every case asserts `UNKNOWN`, the one verdict that is sound once its
 * invocation is accounted for by an unknown edge, through the harness's
 * own `expectation`, and checks that real Node calls the target (the
 * harness checks the marker only for `AFFECTED` and `NOT_AFFECTED`). A
 * case still answered wrongly for a reason A-3b does not own (RWF-065,
 * lane C) is an open-soundness-defect record, never an expectation.
 */

// One macrotask turn before each case, so the worker answers vitest's RPC
// in a file of scans over synchronous I/O (backlog BL-033).
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
      ).toBe(true);
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
      "real Node calls the target in a fail-closed case",
    ).toBe(true);
  });
});
