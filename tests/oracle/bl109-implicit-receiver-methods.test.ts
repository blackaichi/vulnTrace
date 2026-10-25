import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  BL109_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./bl109-implicit-receiver-methods.cases.js";

/**
 * Task BL-109 against real Node
 * (docs/tasks/BL-109-join-protocol-member.md): a method a builtin invokes
 * on its receiver by name -- `join`, and every member of an object literal
 * that sets its `__proto__` to a value not proven ordinary (RWF-151,
 * RWF-152).
 *
 * Every case asserts its sound verdict and real Node's ground truth. The
 * cases whose `base` is `NOT_AFFECTED` while `called` is true are the live
 * false `NOT_AFFECTED`s BL-109 closes; `guard.*` were `UNKNOWN` on the
 * base by another account; `control.*` keep their precision; `cost.*` is
 * the precision BL-109 gives up, measured.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL109_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.name}: ${kase.mechanism} -- ${kase.expected}`, async () => {
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
