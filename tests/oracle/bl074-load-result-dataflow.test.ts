import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import { BL074_CASES } from "./bl074-load-result-dataflow.cases.js";
import { TARGET_MARKER, oracleCase } from "./e1-export-write-set.cases.js";

/**
 * Task BL-074 against real Node (docs/tasks/BL-074-load-result-dataflow.md;
 * ADR 0009 § 1, § 4): a load's result that may be one of this file's
 * export objects is censused wherever it flows.
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * `rwf103.*` and `rwf106.*` cases whose `base` is `NOT_AFFECTED` while
 * `called` is true are the live false `NOT_AFFECTED`s BL-074 closes;
 * `control.*` keep their precision; `cost.*` is the precision the rule
 * gives up, measured.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL074_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
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
