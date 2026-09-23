import { describe, expect, it } from "vitest";
import {
  EDGE_DOMAIN,
  VERDICT_DOMAIN,
  debtReferenceProblems,
  loadDefectRegisters,
  openSoundnessDefectProblems,
  rwfReferenceProblems,
  type EdgeObservation,
  type EdgePattern,
  type OpenSoundnessDefect,
  type Verdict,
  type VerdictObservation,
} from "./open-soundness-defect.js";

/**
 * The self-test of the open-soundness-defect record. Each rejection the
 * mechanism promises is driven directly, so a record cannot pass by the
 * mechanism quietly accepting what it exists to refuse.
 */

const registers = loadDefectRegisters();

const WRONG: VerdictObservation = {
  verdict: "NOT_AFFECTED",
  proofFamily: "C",
  target: "node_modules/pkg/index.js#run",
  reachableSubgraphComplete: true,
  unknownEdges: 0,
};

const VALID: OpenSoundnessDefect<Verdict, VerdictObservation> = {
  caseId: "self-test",
  rwf: "RWF-047",
  debt: "D-16",
  admissible: ["UNKNOWN", "AFFECTED"],
  expected: "UNKNOWN",
  observed: WRONG,
};

function problems(
  record: OpenSoundnessDefect<Verdict, VerdictObservation>,
  live: VerdictObservation = record.observed,
): readonly string[] {
  return openSoundnessDefectProblems(record, VERDICT_DOMAIN, live, registers);
}

describe("open-soundness-defect record: the mechanism rejects what it must", () => {
  it("accepts a well-formed record whose live result equals the observation", () => {
    expect(problems(VALID)).toEqual([]);
  });

  it("REJECTS an observed value inside the admissible set", () => {
    const record = {
      ...VALID,
      observed: { ...WRONG, verdict: "UNKNOWN" as const },
    };
    const found = problems(record);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/observed .* is ADMISSIBLE/);
  });

  it("REJECTS an expected value outside the admissible set", () => {
    const found = problems({ ...VALID, expected: "NOT_AFFECTED" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(
      /expected "NOT_AFFECTED" is not in the admissible set/,
    );
  });

  it("REJECTS a dangling RWF reference", () => {
    const found = problems({ ...VALID, rwf: "RWF-999" });
    expect(found.join("\n")).toMatch(/RWF-999: no "## RWF-999 — …" heading/);
    expect(found.join("\n")).toMatch(/RWF-999: expected exactly one row/);
  });

  it("REJECTS a reference to a CLOSED RWF record", () => {
    // RWF-045 is real, and fixed: its register status is `**Fixed (RWF-045)**`.
    const found = problems({ ...VALID, rwf: "RWF-045" });
    expect(found.join("\n")).toMatch(/RWF-045: register status is not open/);
  });

  it("REJECTS a dangling or closed debt reference", () => {
    expect(problems({ ...VALID, debt: "D-99" }).join("\n")).toMatch(
      /D-99: no "### D-99 — …" heading/,
    );
    // D-07's heading reads "— CLOSED by P1-B1".
    expect(problems({ ...VALID, debt: "D-07" }).join("\n")).toMatch(
      /D-07: OPEN-DEBTS.md heading marks it closed/,
    );
  });

  it("REJECTS a live result that differs from the observation -- the FIXED direction", () => {
    const found = problems(VALID, { ...WRONG, verdict: "UNKNOWN" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/now ADMISSIBLE -- RWF-047 may be fixed/);
  });

  it("REJECTS a live result that differs from the observation -- the DRIFT direction", () => {
    // Still wrong, but wrong differently: same verdict, a different family.
    // A record that only compared verdicts would miss this.
    const found = problems(VALID, { ...WRONG, proofFamily: "A" });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/the defect DRIFTED/);

    const target = problems(VALID, {
      ...WRONG,
      target: "node_modules/pkg/index.js#patched",
    });
    expect(target).toHaveLength(1);
    expect(target[0]).toMatch(/the defect DRIFTED/);
  });
});

describe("open-soundness-defect record: the RWF reference is anchored, not permissive", () => {
  const register = (status: string): string =>
    [
      "## Status",
      "",
      "| ID | Package | Root cause | Impact | Status |",
      "| --- | --- | --- | --- | --- |",
      `| RWF-900 | x | y | z | ${status} |`,
      "",
      "## RWF-900 — a synthetic record",
      "",
    ].join("\n");

  it("an `Open` status resolves", () => {
    expect(
      rwfReferenceProblems("RWF-900", register("Open — not fixed")),
    ).toEqual([]);
  });

  it("follows the scorecard's shared vocabulary: emphasis is stripped, open in part is open", () => {
    // This file once had its own reader (`/^Open\b/`), which refused
    // `**Open**` while the scorecard accepted it. Both now read the same
    // field through the same classifier.
    expect(rwfReferenceProblems("RWF-900", register("**Open**"))).toEqual([]);
    expect(
      rwfReferenceProblems(
        "RWF-900",
        register("**OPEN — classified, not fixed**"),
      ),
    ).toEqual([]);
    expect(
      rwfReferenceProblems("RWF-900", register("Open in part — the ESM half")),
    ).toEqual([]);
  });

  it("a fixed, contradicted or unknown status fails the record", () => {
    expect(
      rwfReferenceProblems("RWF-900", register("**Fixed (RWF-900)**")).join(
        "\n",
      ),
    ).toMatch(/RWF-900: register status is not open/);
    // A `Fixed` whose own cell says it is not: the shared classifier
    // refuses the register, so no status is read and the record fails.
    expect(
      rwfReferenceProblems("RWF-900", register("Fixed; was open")).join("\n"),
    ).toMatch(/cannot be classified/);
    // A value outside the vocabulary is never defaulted to open.
    expect(
      rwfReferenceProblems("RWF-900", register("Triaged")).join("\n"),
    ).toMatch(/cannot be classified.*"triaged" is not in the vocabulary/s);
  });

  it("a REMEDIATED heading closes the record even if the register lags", () => {
    const text =
      register("Open") + "## RWF-900 — REMEDIATED: the synthetic fix\n";
    expect(rwfReferenceProblems("RWF-900", text).join("\n")).toMatch(
      /heading marks it closed/,
    );
  });

  it("the debt check resolves the live D-16", () => {
    expect(debtReferenceProblems("D-16", registers.openDebts)).toEqual([]);
  });
});

describe("open-soundness-defect record: the edge domain", () => {
  const exactRun: EdgeObservation = {
    kind: "exact",
    target: "node_modules/pkg/index.js#run",
  };
  const refusal: EdgePattern = { kind: "refusal" };

  it("a refusal admits an unknown edge under ANY reason (no reason code is pinned)", () => {
    expect(
      EDGE_DOMAIN.admits(refusal, { kind: "unknown", reason: "anything" }),
    ).toBe(true);
    expect(EDGE_DOMAIN.admits(refusal, exactRun)).toBe(false);
  });

  it("an EXACT pattern admits only that exact target", () => {
    const patched: EdgePattern = {
      kind: "exact",
      target: "c1/case.js#patched",
    };
    expect(
      EDGE_DOMAIN.admits(patched, {
        kind: "exact",
        target: "c1/case.js#patched",
      }),
    ).toBe(true);
    expect(EDGE_DOMAIN.admits(patched, exactRun)).toBe(false);
  });

  it("observation-only degeneracies are admitted by nothing", () => {
    for (const o of [
      { kind: "no-edge" },
      { kind: "no-probe" },
      { kind: "ambiguous", count: 2 },
    ] as const) {
      expect(EDGE_DOMAIN.admits(refusal, o)).toBe(false);
    }
  });
});
