import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  TARGET_MARKER,
  oracleCase,
  type Rwf050Case,
} from "./rwf050-may-execute-operand.cases.js";

/**
 * RWF-094 against real Node (found by task BL-063; fixed by task BL-064,
 * docs/tasks/BL-064-may-throw-statement-cutoff.md).
 *
 * A module-time statement that MAY throw, through anything no proof
 * reaches, between two writes of an export, leaves the earlier write
 * published when it throws, and a module that already holds the exports
 * object observes it. BL-064 (ADR 0009 § 1 clause 4, as amended) makes
 * the last write authoritative only when every evaluation between the
 * first competing write and its own completion is PROVEN to complete; the
 * five shapes RWF-094 pinned as open-soundness-defect records now assert
 * `UNKNOWN`.
 *
 * Same fixture as RWF-050 (`rwf050-may-execute-operand.cases.ts`): `wrap/b`
 * holds the exports object from a cycle BEFORE both writes. Real Node
 * evaluates `FLAG` true.
 *
 * The precision controls are statements real Node completes and the
 * completion grammar proves: a call of a callee that completes, a caught
 * statement, an `if` of completing branches, a `typeof` of an undeclared
 * global, and an `async` callee. One boundary needs no proof at all: a
 * first write of a primitive (TypeScript's `exports.x = void 0;`) is not a
 * competing write, since observing it reaches nothing.
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

const RWF094_CASES: readonly Rwf050Case[] = [
  // The five shapes RWF-094 pinned as open-soundness-defect records.
  {
    id: "rwf094.local-may-throw-callee",
    mechanism:
      "`maybe(FLAG);` with `function maybe(f) { if (f) throw ...; return 1; }`",
    prelude: 'function maybe(f) { if (f) throw new Error("m"); return 1; }\n',
    abrupt: "maybe(FLAG);\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf094.builtin-may-throw",
    mechanism: '`JSON.parse(FLAG ? "{" : "{}");`',
    abrupt: 'JSON.parse(FLAG ? "{" : "{}");\n',
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf094.construct-instance-field",
    mechanism:
      "`class C { f = bail(); } new C();` (the construction runs the initializer)",
    abrupt: "class C { f = bail(); }\nnew C();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf094.construct-instance-field-may",
    mechanism: "`class C { f = FLAG && bail(); } new C();`",
    abrupt: "class C { f = FLAG && bail(); }\nnew C();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf094.getter-read",
    mechanism:
      "`const o = { get v() { FLAG && bail(); return 1; } }; void o.v;`",
    abrupt: "const o = { get v() { FLAG && bail(); return 1; } };\nvoid o.v;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // BL-064: further shapes of the same family, each measured.
  {
    id: "bl064.property-read-of-undefined",
    mechanism: "`void (FLAG && {}.missing.x);` (a `TypeError`)",
    abrupt: "void (FLAG && {}.missing.x);\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl064.try-finally",
    mechanism:
      "`try { maybe(FLAG); } finally {}` (no `catch`: the throw propagates)",
    prelude: 'function maybe(f) { if (f) throw new Error("m"); return 1; }\n',
    abrupt: "try { maybe(FLAG); } finally {}\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl064.nested-callee-may-throw",
    mechanism:
      "`w(FLAG);` with `function w(f) { return maybe(f); }` (the throw is one call down)",
    prelude:
      'function maybe(f) { if (f) throw new Error("m"); return 1; }\nfunction w(f) { return maybe(f); }\n',
    abrupt: "w(FLAG);\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl064.tdz-read",
    mechanism:
      "`void late;` before `let late` (a `ReferenceError` in the temporal dead zone)",
    abrupt: "void (FLAG && late);\nlet late = 1;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The precision controls: real Node completes each, and the grammar
  // proves it.
  {
    id: "bl064.control.completing-callee",
    mechanism: "`ok(FLAG);` with `function ok(v) { return v; }`",
    prelude: "function ok(v) { return v; }\n",
    abrupt: "ok(FLAG);\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl064.control.caught",
    mechanism: '`try { JSON.parse(FLAG ? "{" : "{}"); } catch {}`',
    abrupt: 'try { JSON.parse(FLAG ? "{" : "{}"); } catch {}\n',
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl064.control.if-typeof-global",
    mechanism:
      '`if (typeof window === "undefined") { const z = 1; } else { void 0; }` (`typeof` of an undeclared name)',
    abrupt:
      'if (typeof window === "undefined") { const z = 1; } else { void 0; }\n',
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl064.control.async-callee",
    mechanism:
      "`void am(FLAG);` with an `async` callee that throws (rejects, never throws)",
    prelude: 'async function am(f) { if (f) throw new Error("a"); }\n',
    abrupt: "void am(FLAG);\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl064.control.primitive-first-write",
    mechanism:
      '`exports.run = void 0;` then `JSON.parse("{}");` (a primitive first write is no competitor)',
    first: "exports.run = void 0;\n",
    abrupt: 'JSON.parse("{}");\n',
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];

describe.each(RWF094_CASES.map((c) => [c.id, c] as const))(
  "%s",
  (_id, kase) => {
    it(`RWF-094: ${kase.mechanism} -- ${kase.expected}`, async () => {
      const result = await runOracleCase({
        ...oracleCase(kase),
        expectation: { verdict: kase.expected, calledMarker: TARGET_MARKER },
      });
      expect(
        result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
        "real Node's ground truth",
      ).toBe(kase.called);
    });
  },
);
