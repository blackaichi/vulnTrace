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
  TARGET_MARKER,
  oracleCase,
  type A3aCase,
} from "./a3a-escaped-values.cases.js";

/**
 * Task A-3a: registers the real-Node reproductions in
 * `a3a-escaped-values.cases.ts`. Shared by `a3a-escaped-values.test.ts`
 * (the task's own cases) and `a3a-escaped-values.audit.test.ts` (the
 * cases its independent audit found), split only to keep each vitest file
 * short (backlog BL-033).
 *
 * Every case asserts the one verdict that is sound for it once its escape
 * is accounted for (ADR 0008 § 2, § 3 and § 4), through the harness's own
 * `expectation`, which also checks that real Node agrees. The harness
 * checks the marker only for `AFFECTED` and `NOT_AFFECTED`, so this checks
 * it for `UNKNOWN` too. A case still answered wrongly for a reason A-3a
 * does not own is an open-soundness-defect record, never an expectation.
 */
export function registerA3aCases(cases: readonly A3aCase[]): void {
  // One macrotask turn before each case, so the worker answers vitest's
  // RPC in a long file of scans over synchronous I/O (backlog BL-033).
  beforeEach(async () => {
    await new Promise((resolve) => setImmediate(resolve));
  });

  describe.each(cases.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
    it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
      if (kase.openDefect) {
        // An open-soundness-defect record: fails when the defect is fixed
        // (delete the record) and when it drifts (re-measure).
        const result = await runOracleCase(oracleCase(kase));
        expect(
          result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
          "real Node's ground truth",
        ).toBe(kase.expected !== "NOT_AFFECTED");
        const coverage = result.variant.scan.output?.coverage;
        expect(coverage).toBeDefined();
        const record: OpenSoundnessDefect<Verdict, VerdictObservation> = {
          caseId: kase.id,
          rwf: kase.openDefect.rwf,
          debt: "D-17",
          admissible: [kase.expected, "UNKNOWN"],
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
      if (kase.expected === "UNKNOWN") {
        expect(
          result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
          kase.realNodeCalls === false
            ? "real Node never calls the target in a precision-cost case"
            : "real Node calls the target in a fail-closed case",
        ).toBe(kase.realNodeCalls !== false);
      }
    });
  });
}
