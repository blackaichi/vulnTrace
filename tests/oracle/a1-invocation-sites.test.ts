import { describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./a1-invocation-sites.cases.js";

/**
 * Task A-1 (docs/tasks/A-1-invocation-account.md): tagged templates
 * (PRM-37), implicit `super` (PRM-19) and decorators (PRM-115), each
 * against real Node.
 *
 * Every case asserts the one verdict that is sound for it once its site
 * is accounted for (ADR 0008 § 2 and § 4), through the harness's own
 * `expectation`, which also checks that real Node agrees. On the base
 * commit every case whose target real Node calls was a family-C false
 * `NOT_AFFECTED` (measured by this task before its fix; see the task
 * file); nothing here pins that result.
 *
 * An `UNKNOWN` case is a fail-closed account: the invocation happens and
 * its callee is not attributable. The harness checks the marker only for
 * `AFFECTED` and `NOT_AFFECTED`, so this test checks it for `UNKNOWN`
 * too -- an `UNKNOWN` over a program that never calls the target would be
 * a precision loss this test did not intend, not the soundness fix it
 * describes.
 */
describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
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
