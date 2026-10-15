import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import { BL075_CASES } from "./bl075-builtin-reader-trust.cases.js";
import { TARGET_MARKER, oracleCase } from "./e1-export-write-set.cases.js";

/**
 * Task BL-075 against real Node (docs/tasks/BL-075-builtin-reader-trust.md;
 * ADR 0009 § 1): no builtin is trusted to only read an export object.
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * `rwf104.*` cases whose `base` is `NOT_AFFECTED` while `called` is true
 * are the live false `NOT_AFFECTED`s BL-075 closes; `masked.*` were
 * already `UNKNOWN` through the call graph; `cost.*` is the precision
 * BL-075 gives up, measured; `control.*` keeps its precision.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL075_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
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
