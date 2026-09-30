import { describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  ALL_CASES,
  TARGET_MARKER,
  oracleCase,
} from "./a3a-escaped-values.cases.js";

/**
 * Task A-3a (docs/tasks/A-3a-escaped-values.md): escaped function values,
 * the documented invoking builtins, the assignment form of the escape row,
 * RWF-060's forwarded arguments and `Reflect.construct`, each against real
 * Node.
 *
 * Every case asserts the one verdict that is sound for it once its escape
 * is accounted for (ADR 0008 § 2, § 3 and § 4), through the harness's own
 * `expectation`, which also checks that real Node agrees. On the base
 * commit every case whose target real Node calls was a false
 * `NOT_AFFECTED` (measured by this task before its fix; see the task
 * file); nothing here pins that result.
 *
 * The harness checks the marker only for `AFFECTED` and `NOT_AFFECTED`,
 * so this test checks it for `UNKNOWN` too: every `UNKNOWN` case here is a
 * program that does call the target, and `UNKNOWN` is the account of an
 * invocation the analyzer cannot prove happens.
 */
describe.each(ALL_CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.finding}: ${kase.mechanism} -- ${kase.expected}`, async () => {
    const result = await runOracleCase({
      ...oracleCase(kase),
      expectation: { verdict: kase.expected, calledMarker: TARGET_MARKER },
    });
    if (kase.expected === "UNKNOWN") {
      expect(
        result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
        "real Node calls the target in every UNKNOWN case",
      ).toBe(true);
    }
  });
});
