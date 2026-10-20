import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  BL099_CASES,
  bl099OracleCase,
} from "./bl099-namespace-export-member-read.cases.js";

/**
 * Task BL-099 against real Node
 * (docs/tasks/BL-099-namespace-export-member-read.md): a use of a
 * namespace's exported member is a read of the namespace's object
 * (RWF-141).
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * `rwf141.*` cases whose `base` is `NOT_AFFECTED` while `called` is true
 * are the live false `NOT_AFFECTED`s BL-099 closes; `control.*` keep their
 * precision; `cost.*` is the precision BL-099 gives up, measured.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL099_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
    const result = await runOracleCase({
      ...bl099OracleCase(kase),
      expectation: { verdict: kase.expected, calledMarker: "parse" },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has("parse"),
      "real Node's ground truth",
    ).toBe(kase.called);
  });
});
