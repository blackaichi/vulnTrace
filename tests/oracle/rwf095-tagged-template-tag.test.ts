import { beforeEach, describe, expect, it } from "vitest";
import { runOracleCase } from "../../src/testing/oracle/case.js";
import {
  TARGET_MARKER,
  oracleCase,
  type Rwf050Case,
} from "./rwf050-may-execute-operand.cases.js";

/**
 * RWF-095 against real Node (found by BL-063's independent audit; fixed by
 * task BL-065, docs/tasks/BL-065-tagged-template-abrupt-tag.md).
 *
 * A tagged template CALLS its tag: the tag is evaluated, then every
 * substitution, then the tag is invoked (`[[Call]]`, with the member's
 * receiver as `this` for `` h.bail`x` ``). A tag the identity proof
 * resolves to a local callable that can only throw therefore ends module
 * evaluation exactly as `bail(["x"])` would. `isDefinitelyAbruptInvocation`
 * recognised only calls and constructions, so neither the required
 * position (`` bail`x`; ``) nor a MAY one (`` FLAG && bail`x`; ``) was a
 * cutoff, and the later `exports.run = safeOp` stayed authoritative: a
 * false `NOT_AFFECTED` with a complete family C proof.
 *
 * Same fixture as RWF-050 (`rwf050-may-execute-operand.cases.ts`): `wrap/b`
 * holds the exports object from a cycle BEFORE both writes, so only the
 * abrupt-completion machinery (ADR 0009 § 1 clause 3) decides.
 *
 * The precision controls are tagged templates real Node never lets end the
 * load: an `async` tag (a rejected promise, no synchronous throw), a body
 * never called, a caught template, a tag that completes, and an instance
 * field initializer (runs per construction; the class is never
 * constructed).
 */

// One macrotask turn before each case (backlog BL-033).
beforeEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
});

const RWF095_CASES: readonly Rwf050Case[] = [
  // The two spellings RWF-095 pinned as open-soundness-defect records.
  {
    id: "rwf095.tagged-template",
    mechanism: "`` bail`x`; ``",
    abrupt: "bail`x`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf095.tagged-template-may",
    mechanism: "`` FLAG && bail`x`; ``",
    abrupt: "FLAG && bail`x`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The other tag forms the shared identity proof resolves (RWF-028).
  {
    id: "bl065.member-tag",
    mechanism: "`` h.bail`x`; `` with `const h = { bail };`",
    prelude: "const h = { bail };\n",
    abrupt: "h.bail`x`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl065.alias-tag",
    mechanism: "`` alias`x`; `` with `const alias = bail;`",
    prelude: "const alias = bail;\n",
    abrupt: "alias`x`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl065.arrow-tag",
    mechanism: "`` arrowBail`x`; `` with a block-bodied throwing arrow",
    prelude: 'const arrowBail = () => { throw new Error("a"); };\n',
    abrupt: "arrowBail`x`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl065.substitution",
    mechanism: "`` bail`a${0}b`; `` (a template with a substitution)",
    abrupt: "bail`a${0}b`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl065.declarator",
    mechanism: "`` const g = bail`x`; `` (a declarator's initializer)",
    abrupt: "const g = bail`x`;\nvoid g;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl065.static-field",
    mechanism: "`` class S { static x = FLAG && bail`x`; } ``",
    abrupt: "class S { static x = FLAG && bail`x`; }\nvoid S;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "bl065.wrapper",
    mechanism:
      "`viaTag();` with `` function viaTag() { bail`x`; } `` (a callable whose body is the template)",
    prelude: "function viaTag() { bail`x`; }\n",
    abrupt: "viaTag();\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Already `UNKNOWN` on the base, for a different reason: the call graph
  // does not model a construction whose callee is a call result
  // (`unsupported_computed_callee`). A guard that the fix keeps it so, not
  // evidence for the fix.
  {
    id: "bl065.new-of-tag",
    mechanism:
      "`` new Bail`x`; `` (parses as `` new (Bail`x`) ``: the tag call runs first)",
    prelude: 'function Bail() { throw new Error("bail"); }\n',
    abrupt: "new Bail`x`;\n",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Precision controls: real Node never reaches a throwing tag at module
  // time here, so `.run` is `safeOp` on every load.
  {
    id: "bl065.control.async-tag",
    mechanism:
      "`` void abail`x`; `` with an `async` throwing tag (rejects, never throws)",
    prelude: 'async function abail() { throw new Error("a"); }\n',
    abrupt: "void abail`x`;\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl065.control.function-body",
    mechanism: "`` function f() { bail`x`; } `` (never called)",
    abrupt: "function f() { bail`x`; }\nvoid f;\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl065.control.caught",
    mechanism: "`` try { bail`x`; } catch {} ``",
    abrupt: "try { bail`x`; } catch {}\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl065.control.completing-tag",
    mechanism: "`` ok`x`; `` with `function ok() { return 1; }`",
    prelude: "function ok() { return 1; }\n",
    abrupt: "ok`x`;\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "bl065.control.instance-field",
    mechanism: "`` class I { f = bail`x`; } `` (never constructed)",
    abrupt: "class I { f = bail`x`; }\nvoid I;\n",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];

describe.each(RWF095_CASES.map((c) => [c.id, c] as const))(
  "%s",
  (_id, kase) => {
    it(`RWF-095: ${kase.mechanism} -- ${kase.expected}`, async () => {
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
