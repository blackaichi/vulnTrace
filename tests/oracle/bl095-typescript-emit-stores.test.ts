import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  BL095_CASES,
  bl095OracleCase,
} from "./bl095-typescript-emit-stores.cases.js";

/**
 * Task BL-095 against real Node
 * (docs/tasks/BL-095-typescript-emit-stores.md): the stores TypeScript's
 * emit makes that the source shows as declarations (RWF-131, RWF-132).
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * `rwf131.*` and `rwf132.*` cases whose `base` is `NOT_AFFECTED` while
 * `called` is true are the live false `NOT_AFFECTED`s BL-095 closes;
 * `control.*` keep their precision; `cost.*` is the precision BL-095
 * gives up, measured.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL095_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
    const result = await runOracleCase({
      ...bl095OracleCase(kase),
      expectation: { verdict: kase.expected, calledMarker: "parse" },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has("parse"),
      "real Node's ground truth",
    ).toBe(kase.called);
  });
});
