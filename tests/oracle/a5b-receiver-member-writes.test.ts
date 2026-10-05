import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./a5b-receiver-member-writes.cases.js";

/**
 * Task A-5b (docs/tasks/A-5b-receiver-member-writes.md): ADR 0008
 * invariant A2 for a method call's receiver (VT-208, PRM-18) against real
 * Node. On the base commit every case whose `base` differs from its
 * `expected` was a false `NOT_AFFECTED`: real Node calls the target
 * through a method the checker's static receiver type did not name.
 * Nothing here pins a base verdict.
 *
 * Every case asserts its sound verdict through the harness's own
 * `expectation`, and checks real Node's answer against the case's
 * `called`.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
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
