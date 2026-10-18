import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import { BL084_CASES } from "./bl084-function-own-object.cases.js";
import { TARGET_MARKER, oracleCase } from "./e1-export-write-set.cases.js";

/**
 * Task BL-084 against real Node (docs/tasks/BL-084-function-own-object.md;
 * ADR 0009 § 1): every route to a function's own object is a use of the
 * export object it is the value of.
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * cases whose `base` is `NOT_AFFECTED` while `called` is true are the live
 * false `NOT_AFFECTED`s BL-084 closes; `lazy.*` and `masked.*` were
 * already `UNKNOWN`; `strict.*` ground the routes strict code does not
 * have; `cost.*` is the precision BL-084 gives up, measured; `control.*`
 * keeps its precision. Two `strict.*` cases answer `UNKNOWN` since task
 * BL-081 (a store through a member read is an escape), each marked as
 * that task's precision cost.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL084_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
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
