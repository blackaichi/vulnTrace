import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./c1-runtime-resolution.cases.js";

/**
 * Task C-1 (docs/tasks/C-1-runtime-resolution-mode.md): ADR 0010
 * invariant C2 against real Node. See the cases file for what the base
 * measured; each case asserts the sound verdict, never a base verdict.
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
      // An UNKNOWN real Node does not reach is a cost, stated as one.
      expect(kase.expected).toBe("UNKNOWN");
      expect(kase.called).toBe(false);
    }
    if (kase.expectedReason !== undefined) {
      const finding = result.variant.scan.findings[0];
      expect(
        finding?.unknownReasons?.map((r) => r.reason),
        JSON.stringify(finding?.unknownReasons),
      ).toContain(kase.expectedReason);
    }
  });
});
