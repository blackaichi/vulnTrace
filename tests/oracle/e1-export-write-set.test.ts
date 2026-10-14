import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  E1_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./e1-export-write-set.cases.js";

/**
 * Task E-1 against real Node (docs/tasks/E-1-export-write-set.md; ADR 0009
 * § 1, § 4, § 8): the export write set.
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * PRM cases whose `base` is `NOT_AFFECTED` while `called` is true are the
 * live false `NOT_AFFECTED`s E-1 closes (45 on the base); the PRM cases
 * already `UNKNOWN` on the base were closed by earlier tasks (BL-063,
 * BL-064) and stay as regression cases; the `control.*` cases are ADR
 * 0009 § 4's modelled exceptions, which must keep their precision (two
 * were false `AFFECTED`s on the base).
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(E1_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
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
