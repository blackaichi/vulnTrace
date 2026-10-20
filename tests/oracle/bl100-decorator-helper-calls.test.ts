import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  BL100_CASES,
  bl100OracleCase,
} from "./bl100-decorator-helper-calls.cases.js";

/**
 * Task BL-100 against real Node
 * (docs/tasks/BL-100-decorator-helper-calls.md): what TypeScript's
 * decorator helpers do with a decorator's result (RWF-142).
 *
 * Every case asserts the sound verdict and real Node's ground truth. The
 * `rwf142.*` cases whose `base` is `NOT_AFFECTED` while `called` is true
 * are the live false `NOT_AFFECTED`s BL-100 closes; `masked.*` were
 * already `UNKNOWN`; `control.*` keep their precision; `cost.*` is the
 * precision BL-100 gives up, measured.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

describe.each(BL100_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
    const result = await runOracleCase({
      ...bl100OracleCase(kase),
      expectation: { verdict: kase.expected, calledMarker: "parse" },
    });
    expect(
      result.variant.groundTruth.calledMarkers.has("parse"),
      "real Node's ground truth",
    ).toBe(kase.called);
  });
});
