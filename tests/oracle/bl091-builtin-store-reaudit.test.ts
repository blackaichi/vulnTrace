import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  BL091_CASES,
  BL091_TYPESCRIPT_CASES,
  typeScriptOracleCase,
} from "./bl091-builtin-store-reaudit.cases.js";
import { TARGET_MARKER, oracleCase } from "./e1-export-write-set.cases.js";

/**
 * Task BL-091 against real Node
 * (docs/tasks/BL-091-builtin-store-reaudit.md; ADR 0008's decision record
 * "BL-081"): the re-audit of BL-081's rule that a store is an escape
 * unless the object it writes onto is proven to be the program's own.
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * `rwf124.*`, `rwf126.*`, `rwf127.*` and `rwf128.*` cases whose `base` is
 * `NOT_AFFECTED` while `called` is true
 * are the live false `NOT_AFFECTED`s BL-091 closes; `control.*` keep
 * their precision; `cost.*` is the precision BL-091 gives up, measured.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL091_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
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

describe.each(BL091_TYPESCRIPT_CASES.map((c) => [c.id, c] as const))(
  "%s",
  (_id, kase) => {
    it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
      const result = await runOracleCase({
        ...typeScriptOracleCase(kase),
        expectation: { verdict: kase.expected, calledMarker: "parse" },
      });
      expect(
        result.variant.groundTruth.calledMarkers.has("parse"),
        "real Node's ground truth",
      ).toBe(kase.called);
    });
  },
);
