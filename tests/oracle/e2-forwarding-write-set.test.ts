import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import { TARGET_MARKER, oracleCase } from "./e1-export-write-set.cases.js";
import { E2_CASES } from "./e2-forwarding-write-set.cases.js";

/**
 * Task E-2 against real Node (docs/tasks/E-2-forwarding-write-set.md; ADR
 * 0009 § 1, § 8): the forwarding hop consults the export write set.
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * `rwf105.*` cases whose `base` is `NOT_AFFECTED` while `called` is true
 * are the live false `NOT_AFFECTED`s E-2 closes; `prm61.*` are PRM-61's
 * reproduced shapes, closed by E-1's model; `control.*` keep their
 * precision; `cost.*` is the precision E-2 gives up, measured. One control
 * answers `UNKNOWN` since task BL-081, marked as that task's precision
 * cost.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(E2_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
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
