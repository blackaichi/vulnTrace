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
 * RWF-094, found by task BL-063 (docs/tasks/BL-063-may-execute-operand-cutoff.md):
 * a module-time statement that MAY throw, through a callee no proof
 * reaches, is not a module-evaluation cutoff. BL-063 made the cutoff MAY
 * for a call `isDefinitelyAbruptCall` proves can ONLY throw; a call that
 * throws on one path (`maybe(FLAG)`), or a builtin that throws for some
 * input (`JSON.parse`), is still assumed to complete, so the later write of
 * `exports.run` stays authoritative though real Node can stop before it.
 *
 * Same fixture as RWF-050 (`rwf050-may-execute-operand.cases.ts`): `wrap/b`
 * holds the exports object from a cycle BEFORE both writes, so ADR 0009 § 1
 * clause 4's observation point (between the writes) is absent. Each case is
 * an open-soundness-defect record -- the exact wrong result, never the
 * wrong verdict as an expectation (AGENTS.md § G). A fix deletes the record
 * and asserts `expected`.
 *
 * Also pinned here, from BL-063's independent audit: `new C()` running a
 * throwing instance field and a getter read (RWF-094's family). RWF-095, a
 * tagged template of a proven-abrupt callee, was pinned here too until
 * task BL-065 fixed it; its cases now assert the sound verdict in
 * `rwf095-tagged-template-tag.test.ts`.
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
  readonly rwf: "RWF-094";
}

const CASES: readonly PinnedCase[] = [
  {
    id: "rwf094.local-may-throw-callee",
    mechanism:
      "`maybe(FLAG);` with `function maybe(f) { if (f) throw ...; return 1; }`",
    prelude: 'function maybe(f) { if (f) throw new Error("m"); return 1; }\n',
    abrupt: "maybe(FLAG);\n",
    rwf: "RWF-094",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf094.builtin-may-throw",
    mechanism: '`JSON.parse(FLAG ? "{" : "{}");`',
    abrupt: 'JSON.parse(FLAG ? "{" : "{}");\n',
    rwf: "RWF-094",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Found by BL-063's independent audit, measured on its branch: implicit
  // invocations whose callee no proof reaches (RWF-094's family).
  {
    id: "rwf094.construct-instance-field",
    mechanism:
      "`class C { f = bail(); } new C();` (the construction runs the initializer)",
    abrupt: "class C { f = bail(); }\nnew C();\n",
    rwf: "RWF-094",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf094.construct-instance-field-may",
    mechanism: "`class C { f = FLAG && bail(); } new C();`",
    abrupt: "class C { f = FLAG && bail(); }\nnew C();\n",
    rwf: "RWF-094",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf094.getter-read",
    mechanism:
      "`const o = { get v() { FLAG && bail(); return 1; } }; void o.v;`",
    abrupt: "const o = { get v() { FLAG && bail(); return 1; } };\nvoid o.v;\n",
    rwf: "RWF-094",
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
