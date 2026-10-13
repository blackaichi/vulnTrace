import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  TARGET_MARKER,
  oracleCase,
  type Rwf050Case,
} from "./rwf050-may-execute-operand.cases.js";

/**
 * RWF-096 and RWF-097 against real Node (found by task BL-065's independent
 * audit; fixed by task BL-066, with BL-067 folded in,
 * docs/tasks/BL-066-callee-summary-required-positions.md).
 *
 * The callee summary (`callableAlwaysThrows` in `module-model.ts`) proves
 * that invoking a local callable cannot complete normally. It missed
 * callables that can only throw, so a module-time invocation of one was not
 * a cutoff and the later write of `exports.run` stayed authoritative, though
 * real Node stops before it: a false `NOT_AFFECTED` with a complete family C
 * proof.
 *
 * - RWF-096: a CONCISE-bodied arrow (`() => bail()`) was refused before its
 *   body was read, on the false premise that it is "trivially never
 *   abrupt". Its body is an expression the call must evaluate.
 * - RWF-097: a block body was proven abrupt only by a literal `throw` or a
 *   BARE invocation statement. A definitely-abrupt call in a required
 *   position of any statement (an argument, a substitution, a declarator
 *   initializer, a `return` expression, an `if` condition) ends the body
 *   too, and so does a default parameter initializer the call runs: one at
 *   or beyond the number of arguments the invocation supplies.
 *
 * Same fixture as RWF-050 (`rwf050-may-execute-operand.cases.ts`): `wrap/b`
 * holds the exports object from a cycle BEFORE both writes, so only the
 * abrupt-completion machinery (ADR 0009 § 1 clause 3) decides.
 *
 * The precision controls are invocations real Node lets complete: a concise
 * arrow whose throwing call is short-circuited away, default parameters the
 * call supplies (directly or by a spread), a body whose own binding
 * shadows `bail`, a default that only WRITES a function, a body that
 * catches, an `async` concise arrow, and a concise arrow whose call
 * completes.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

const DP = "function dp(a, b = bail()) { return 1; }\n";

const CASES: readonly Rwf050Case[] = [
  // The five spellings RWF-096 and RWF-097 pinned as open-soundness-defect
  // records.
  {
    id: "rwf096.concise-arrow-call",
    mechanism: "`ac();` with `const ac = () => bail();`",
    prelude: "const ac = () => bail();\n",
    abrupt: "ac();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf096.concise-arrow-tag",
    mechanism: "`` ac`x`; `` with `const ac = () => bail();`",
    prelude: "const ac = () => bail();\n",
    abrupt: "ac`x`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf097.required-argument",
    mechanism: "`w();` with `function w() { ok(bail()); }`",
    prelude: "function ok() { return 1; }\nfunction w() { ok(bail()); }\n",
    abrupt: "w();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf097.required-substitution",
    mechanism: "`w();` with `` function w() { ok`${bail`x`}`; } ``",
    prelude: "function ok() { return 1; }\nfunction w() { ok`${bail`x`}`; }\n",
    abrupt: "w();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf097.default-parameter",
    mechanism: "`dp();` with `function dp(a, b = bail()) { return 1; }`",
    prelude: DP,
    abrupt: "dp();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Further required statement positions of a block body (RWF-097).
  {
    id: "bl066.declarator",
    mechanism: "`w();` with `function w() { const v = bail(); return v; }`",
    prelude: "function w() { const v = bail(); return v; }\n",
    abrupt: "w();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl066.return-expression",
    mechanism: "`w();` with `function w() { return bail(); }`",
    prelude: "function w() { return bail(); }\n",
    abrupt: "w();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl066.if-condition",
    mechanism:
      "`w();` with `function w() { if (bail()) { return 1; } return 2; }`",
    prelude: "function w() { if (bail()) { return 1; } return 2; }\n",
    abrupt: "w();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Further concise bodies (RWF-096).
  {
    id: "bl066.concise-required-operand",
    mechanism: "`ac();` with `const ac = (x) => [x, bail()];`",
    prelude: "const ac = (x) => [x, bail()];\n",
    abrupt: "ac();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl066.concise-wrapper",
    mechanism:
      "`w();` with `const ac = () => bail(); function w() { ac(); }` (a wrapper hop through a concise arrow)",
    prelude: "const ac = () => bail();\nfunction w() { ac(); }\n",
    abrupt: "w();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Further invocations that run a default parameter (RWF-097).
  {
    id: "bl066.default-parameter-partial",
    mechanism: "`dp(1);` (the second parameter's default runs)",
    prelude: DP,
    abrupt: "dp(1);\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl066.default-parameter-tag",
    mechanism: "`` dp`x`; `` (one argument: the strings array)",
    prelude: DP,
    abrupt: "dp`x`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl066.default-parameter-new",
    mechanism: "`new DP();` with `function DP(a = bail()) { this.a = a; }`",
    prelude: "function DP(a = bail()) { this.a = a; }\n",
    abrupt: "new DP();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl066.default-parameter-concise",
    mechanism: "`dpa();` with `const dpa = (a = bail()) => a;`",
    prelude: "const dpa = (a = bail()) => a;\n",
    abrupt: "dpa();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl066.default-parameter-wrapper",
    mechanism:
      "`w();` with `function w() { dp(); }` (the argument count of a call inside a body)",
    prelude: DP + "function w() { dp(); }\n",
    abrupt: "w();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // A guard, not evidence for the fix: an IIFE's callee is a function
  // expression the identity proof does not resolve (RWF-015's documented
  // limitation), and the call graph answers it `unknown`, so the scan is
  // `UNKNOWN` without any abrupt-completion proof.
  {
    id: "bl066.iife",
    mechanism: "`(() => bail())();` (an IIFE of a concise arrow)",
    abrupt: "(() => bail())();\n",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Precision controls: real Node completes every one of these, so `.run`
  // is `safeOp` on every load.
  {
    id: "bl066.control.concise-short-circuit",
    mechanism:
      "`m();` with `const m = () => false && bail();` (the call is never evaluated)",
    prelude: "const m = () => false && bail();\n",
    abrupt: "m();\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl066.control.concise-completes",
    mechanism: "`ac();` with `const ac = () => ok(1);`",
    prelude: "function ok() { return 1; }\nconst ac = () => ok(1);\n",
    abrupt: "ac();\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl066.control.concise-async",
    mechanism:
      "`void aa();` with `const aa = async () => bail();` (rejects, never throws)",
    prelude: "const aa = async () => bail();\n",
    abrupt: "void aa();\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl066.control.default-supplied",
    mechanism: "`dp(1, 2);` (every default parameter is supplied)",
    prelude: DP,
    abrupt: "dp(1, 2);\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl066.control.default-spread",
    mechanism: "`dp(...[1, 2]);` (a spread: the argument count is unknown)",
    prelude: DP,
    abrupt: "dp(...[1, 2]);\n",
    called: false,
    base: "NOT_AFFECTED",
    // BL-064 (RWF-094): a spread argument is outside the completion grammar, so
    // the writes compete across an unproven call (precision only).
    expected: "UNKNOWN",
  },
  // A parameter-shadowed callee (`function sh(bail, b = bail())`) is not a
  // control here: the call graph answers a call of a parameter `unknown`
  // (`unsupported_callee_binding`), so the scan is `UNKNOWN` on the base
  // already. The unit suite
  // (`module-model.callee-summary-required-positions.test.ts`) pins it.
  {
    id: "bl066.control.body-shadow",
    mechanism:
      "`w();` with `function w() { const bail = () => 1; ok(bail()); }` (`bail` is the body's own)",
    prelude:
      "function ok() { return 1; }\nfunction w() { const bail = () => 1; ok(bail()); }\n",
    abrupt: "w();\n",
    called: false,
    base: "NOT_AFFECTED",
    // BL-064 (RWF-094): a body-local callee is outside the completion grammar, so
    // the writes compete across an unproven call (precision only).
    expected: "UNKNOWN",
  },
  {
    id: "bl066.control.default-writes-function",
    mechanism:
      "`dq();` with `function dq(a, b = () => bail()) { return 1; }` (the default is never called)",
    prelude: "function dq(a, b = () => bail()) { return 1; }\n",
    abrupt: "dq();\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl066.control.caught-in-body",
    mechanism: "`w();` with `function w() { try { ok(bail()); } catch {} }`",
    prelude:
      "function ok() { return 1; }\nfunction w() { try { ok(bail()); } catch {} }\n",
    abrupt: "w();\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];

describe.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.mechanism} -- ${kase.expected}`, async () => {
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
