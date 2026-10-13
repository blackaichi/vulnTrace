import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  TARGET_MARKER,
  oracleCase,
  type Rwf050Case,
} from "./rwf050-may-execute-operand.cases.js";

/**
 * RWF-098, found by task BL-066
 * (docs/tasks/BL-066-callee-summary-required-positions.md): the callee
 * summary's remaining refusals of an invocation real Node never completes.
 * Each is a module-time invocation that is not a cutoff, so the later write
 * of `exports.run` stays authoritative, though real Node stops before it: a
 * false `NOT_AFFECTED` with a complete family C proof. None is introduced by
 * BL-066 (each answers the same on its base), and none is a shape BL-066
 * set out to prove:
 *
 * - an argument supplied as a value that is certainly `undefined`
 *   (`dp(1, undefined)`, `dp(1, void 0)`): the default runs, but the
 *   summary counts only the arguments OMITTED;
 * - a destructuring parameter's own nested default
 *   (`function dd({ a = bail() } = {})`, `dd()`), which the summary does not
 *   read;
 * - unconditional self-recursion (`function rec() { rec(); }`, `rec()`):
 *   refused by `callablesInProgress` on RWF-028's premise that it "never
 *   throws either" -- false, V8 throws `RangeError: Maximum call stack size
 *   exceeded`, a catchable throw;
 * - a third wrapper hop (`h3()` -> `h2()` -> `h1()` -> `bail()`): refused by
 *   `MAX_CALLABLE_ABRUPT_SUMMARY_DEPTH`, RWF-028's documented bound.
 *
 * Same fixture as RWF-050 (`rwf050-may-execute-operand.cases.ts`). Each case
 * was an open-soundness-defect record until task BL-064
 * (docs/tasks/BL-064-may-throw-statement-cutoff.md) closed the family: the
 * statement between the two writes of `exports.run` is not PROVEN to
 * complete, so neither write is authoritative (ADR 0009 § 1 clause 4, as
 * amended). Each now asserts `UNKNOWN`. The callee summary itself still
 * refuses these shapes; its two unit-level authority records (a single
 * write, no competing one) stay open for backlog `BL-068`.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

const DP = "function dp(a, b = bail()) { return 1; }\n";

const CASES: readonly Rwf050Case[] = [
  {
    id: "rwf098.undefined-argument",
    mechanism:
      "`dp(1, undefined);` (the default runs for an `undefined` argument)",
    prelude: DP,
    abrupt: "dp(1, undefined);\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf098.void-argument",
    mechanism: "`dp(1, void 0);`",
    prelude: DP,
    abrupt: "dp(1, void 0);\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf098.nested-pattern-default",
    mechanism: "`dd();` with `function dd({ a = bail() } = {}) { return a; }`",
    prelude: "function dd({ a = bail() } = {}) { return a; }\n",
    abrupt: "dd();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf098.self-recursion",
    mechanism: "`rec();` with `function rec() { rec(); }` (a `RangeError`)",
    prelude: "function rec() { rec(); }\n",
    abrupt: "rec();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf098.third-wrapper-hop",
    mechanism: "`h3();` with `h3 -> h2 -> h1 -> bail` (four bodies)",
    prelude:
      "function h1() { bail(); }\nfunction h2() { h1(); }\nfunction h3() { h2(); }\n",
    abrupt: "h3();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

describe.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`RWF-098: ${kase.mechanism} -- ${kase.expected}`, async () => {
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
