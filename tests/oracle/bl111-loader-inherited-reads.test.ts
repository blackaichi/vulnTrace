import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./bl111-loader-inherited-reads.cases.js";

/**
 * Task BL-111 (docs/tasks/BL-111-loader-writes-builtins.md): the reads by
 * inheritance its inventory found in Node's own loader, against real Node.
 * Each case asserts the sound verdict. A control's `precisionCost` states
 * an UNKNOWN real Node does not reach.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.mechanism} -- ${kase.expected}`, async () => {
    const result = await runOracleCase({
      ...oracleCase(kase),
      expectation: { verdict: kase.expected, calledMarker: TARGET_MARKER },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
      "real Node's ground truth",
    ).toBe(kase.called);
    if (kase.precisionCost !== undefined) {
      expect(kase.expected).toBe("UNKNOWN");
      expect(kase.called).toBe(false);
    }
  });
});
