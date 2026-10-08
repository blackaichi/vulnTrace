import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./v3-identity-keyed-roots.cases.js";

/**
 * Task V-3 (docs/tasks/V-3-identity-keyed-roots.md): ADR 0011's
 * predicate 4 against real Node. Every case's replaced answer was wrong
 * (its `base`, or its `firstFix` for a case the task's independent audit
 * found on the first fix): a family-C `NOT_AFFECTED` over a subgraph
 * rooted at the wrong node or at none, or an `AFFECTED` through a decoy
 * root Node never calls. Nothing here pins a base verdict.
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
    // The answer this task replaces was wrong: the base's, or -- for a
    // case its independent audit found -- the first fix's.
    expect(
      kase.firstFix ?? kase.base,
      "the replaced answer was wrong",
    ).not.toBe(kase.expected);
    const finding = result.variant.scan.findings[0];
    if (kase.expectedReason !== undefined) {
      expect(
        finding?.unknownReasons?.map((r) => r.reason),
        JSON.stringify(finding?.unknownReasons),
      ).toContain(kase.expectedReason);
    }
    if (kase.expected === "NOT_AFFECTED") {
      expect(finding?.evidence?.confirmedUnreachableTarget).toBeDefined();
    }
    // Both controls keep their answers: family C for the negative one.
    expect(
      result.controls?.negative.scan.findings[0]?.evidence
        ?.confirmedUnreachableTarget,
    ).toBeDefined();
  });
});
