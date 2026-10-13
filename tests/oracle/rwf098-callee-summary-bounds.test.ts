import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import { toVerdictObservation } from "../../src/testing/oracle/scan.js";
import {
  loadDefectRegisters,
  openSoundnessDefectProblems,
  VERDICT_DOMAIN,
  type OpenSoundnessDefect,
  type Verdict,
  type VerdictObservation,
} from "../../src/testing/open-soundness-defect.js";
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
 * is an open-soundness-defect record -- the exact wrong result, never the
 * wrong verdict as an expectation (AGENTS.md § G). A fix deletes the record
 * and asserts `expected`.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

/** The wrong result: `.run` attributed to `safeOp`, `parse` proven unreachable. */
const FAMILY_C: VerdictObservation = {
  verdict: "NOT_AFFECTED",
  proofFamily: "C",
  target: "vuln-lib#parse",
  reachableSubgraphComplete: true,
  unknownEdges: 0,
};

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
  it(`RWF-098: ${kase.mechanism} -- open, expected ${kase.expected}`, async () => {
    const result = await runOracleCase(oracleCase(kase));
    expect(
      result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
      "real Node's ground truth",
    ).toBe(kase.called);
    const coverage = result.variant.scan.output?.coverage;
    expect(coverage).toBeDefined();
    const record: OpenSoundnessDefect<Verdict, VerdictObservation> = {
      caseId: kase.id,
      rwf: "RWF-098",
      debt: "D-17",
      admissible: [kase.expected],
      expected: kase.expected,
      observed: FAMILY_C,
    };
    expect(
      openSoundnessDefectProblems(
        record,
        VERDICT_DOMAIN,
        toVerdictObservation(result.variant.scan.findings[0], coverage!),
        loadDefectRegisters(),
      ),
    ).toEqual([]);
  });
});
