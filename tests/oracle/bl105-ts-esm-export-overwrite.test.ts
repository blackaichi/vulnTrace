import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  BL105_CASES,
  bl105OracleCase,
} from "./bl105-ts-esm-export-overwrite.cases.js";

/**
 * Task BL-105 against real Node
 * (docs/tasks/BL-105-ts-esm-export-overwrite.md): a TypeScript ES module's
 * own export overwritten through its exports object (RWF-150).
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * `rwf150.*` and `audit.*` cases whose `base` is `NOT_AFFECTED` while
 * `called` is true are the live false `NOT_AFFECTED`s BL-105 closes;
 * `control.*` keep their precision; `cost.*` is the precision BL-105 gives
 * up and `gain.*` the precision it wins, measured.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL105_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
    const result = await runOracleCase({
      ...bl105OracleCase(kase),
      expectation: { verdict: kase.expected, calledMarker: "parse" },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has("parse"),
      "real Node's ground truth",
    ).toBe(kase.called);
  });
});
