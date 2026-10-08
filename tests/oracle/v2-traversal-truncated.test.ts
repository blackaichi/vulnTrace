import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./v2-traversal-truncated.cases.js";

/**
 * Task V-2 (docs/tasks/V-2-traversal-truncated-blocks-negative-proof.md):
 * ADR 0011's predicate 1 against real Node. See the cases file for what
 * the base measured: every case was already `UNKNOWN`, through task V-1's
 * family-C corroboration, so each asserts the sound verdict AND the
 * uncertainty reason that carries it. Nothing here pins a base verdict.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.mechanism} -- ${kase.expected} (${kase.expectedReason})`, async () => {
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
    const finding = result.variant.scan.findings[0];
    expect(
      finding?.unknownReasons?.map((r) => r.reason),
      JSON.stringify(finding?.unknownReasons),
    ).toContain(kase.expectedReason);
    // The negative control is a family-C proof: the guard this task adds
    // must not reach an untruncated scan.
    expect(
      result.controls?.negative.scan.findings[0]?.evidence
        ?.confirmedUnreachableTarget,
    ).toBeDefined();
  });
});
