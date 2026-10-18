import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import { BL081_CASES } from "./bl081-builtin-replaced-without-name.cases.js";
import { TARGET_MARKER, oracleCase } from "./e1-export-write-set.cases.js";

/**
 * Task BL-081 against real Node
 * (docs/tasks/BL-081-builtin-replaced-without-name.md; ADR 0008 § 2's
 * escape row): a store that may land on a builtin object is an escape,
 * whatever route reached the object.
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * `rwf110.*`, `rwf063.*`, `rwf120.*` and `fresh.*` cases whose `base` is
 * `NOT_AFFECTED` while `called` is true are the live false
 * `NOT_AFFECTED`s BL-081 closes; `masked.*` were already `UNKNOWN`
 * through another account; `control.*` keep their precision, one per
 * proof that an object is the program's own; `cost.*` is the precision
 * BL-081 gives up, measured.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL081_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
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
