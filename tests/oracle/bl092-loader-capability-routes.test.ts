import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./bl092-loader-capability-routes.cases.js";

/**
 * Task BL-092 (docs/tasks/BL-092-loader-capability-routes.md): the loader
 * capability seen only when spelled, against real Node. See the cases file
 * for what the base measured; each case asserts the sound verdict, never a
 * base verdict.
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
  });
});
