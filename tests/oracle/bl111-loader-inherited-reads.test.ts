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
 * Each case asserts the sound verdict. A `precisionCost` states an UNKNOWN
 * real Node does not reach, on every release (a control) or on some (task
 * BL-114: real Node's ground truth is the running release's).
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.mechanism} -- ${kase.expected}`, async () => {
    // Real Node's answer depends on the release (task BL-114, RWF-159).
    const called = kase.called();
    const result = await runOracleCase({
      ...oracleCase({ ...kase, called }),
      expectation: { verdict: kase.expected, calledMarker: TARGET_MARKER },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
      `real Node v${process.versions.node}'s ground truth`,
    ).toBe(called);
    if (kase.expected === "UNKNOWN" && !called) {
      // An UNKNOWN real Node does not reach on this release states its cost.
      expect(kase.precisionCost).toBeDefined();
    }
    if (kase.precisionCost !== undefined) {
      expect(kase.expected).toBe("UNKNOWN");
    }
  });
});
