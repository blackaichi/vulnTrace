import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./rwf050-may-execute-operand.cases.js";

/**
 * RWF-050 against real Node (task RWF-050-repro reproduced it; task
 * BL-063, docs/tasks/BL-063-may-execute-operand-cutoff.md, fixed it).
 * Every MAY-abrupt spelling was a live false `NOT_AFFECTED`, pinned as an
 * open-soundness-defect record; BL-063 made the module-evaluation cutoff
 * MAY for expressions, deleted the records, and asserts the sound verdict
 * here. The precision controls (`bl063.control.*`) are positions real Node
 * never reaches at module time, and keep `NOT_AFFECTED`.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`RWF-050: ${kase.mechanism} -- ${kase.expected}`, async () => {
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
