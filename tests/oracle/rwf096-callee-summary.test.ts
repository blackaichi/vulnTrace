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
 * RWF-096 and RWF-097, found by task BL-065's independent audit
 * (docs/tasks/BL-065-tagged-template-abrupt-tag.md): the callee summary
 * (`callableAlwaysThrows` in `module-model.ts`) misses callables that can
 * only throw, so a module-time invocation of one is not a cutoff and the
 * later write of `exports.run` stays authoritative, though real Node stops
 * before it.
 *
 * - RWF-096: a CONCISE-bodied arrow (`() => bail()`) is refused before its
 *   body is read, on the false premise that it is "trivially never abrupt".
 * - RWF-097: a block body is proven abrupt only by a literal `throw` or a
 *   BARE invocation statement; a definitely-abrupt call in a required
 *   expression position of a statement (`ok(bail());`), and a default
 *   parameter initializer the call runs (`function dp(a, b = bail())`),
 *   are not seen.
 *
 * Same fixture as RWF-050 (`rwf050-may-execute-operand.cases.ts`). Each
 * case is an open-soundness-defect record -- the exact wrong result, never
 * the wrong verdict as an expectation (AGENTS.md § G). A fix deletes the
 * record and asserts `expected`.
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

interface PinnedCase extends Rwf050Case {
  /** The open FINDINGS record that owns the defect. */
  readonly rwf: "RWF-096" | "RWF-097";
}

const CASES: readonly PinnedCase[] = [
  {
    id: "rwf096.concise-arrow-call",
    mechanism: "`ac();` with `const ac = () => bail();`",
    prelude: "const ac = () => bail();\n",
    abrupt: "ac();\n",
    rwf: "RWF-096",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf096.concise-arrow-tag",
    mechanism: "`` ac`x`; `` with `const ac = () => bail();`",
    prelude: "const ac = () => bail();\n",
    abrupt: "ac`x`;\n",
    rwf: "RWF-096",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf097.required-argument",
    mechanism: "`w();` with `function w() { ok(bail()); }`",
    prelude: "function ok() { return 1; }\nfunction w() { ok(bail()); }\n",
    abrupt: "w();\n",
    rwf: "RWF-097",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf097.required-substitution",
    mechanism: "`w();` with `` function w() { ok`${bail`x`}`; } ``",
    prelude: "function ok() { return 1; }\nfunction w() { ok`${bail`x`}`; }\n",
    abrupt: "w();\n",
    rwf: "RWF-097",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf097.default-parameter",
    mechanism: "`dp();` with `function dp(a, b = bail()) { return 1; }`",
    prelude: "function dp(a, b = bail()) { return 1; }\n",
    abrupt: "dp();\n",
    rwf: "RWF-097",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

describe.each(CASES.map((c) => [c.id, c] as const))("%s", (_id, kase) => {
  it(`${kase.rwf}: ${kase.mechanism} -- open, expected ${kase.expected}`, async () => {
    const result = await runOracleCase(oracleCase(kase));
    expect(
      result.variant.groundTruth.calledMarkers.has(TARGET_MARKER),
      "real Node's ground truth",
    ).toBe(kase.called);
    const coverage = result.variant.scan.output?.coverage;
    expect(coverage).toBeDefined();
    const record: OpenSoundnessDefect<Verdict, VerdictObservation> = {
      caseId: kase.id,
      rwf: kase.rwf,
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
