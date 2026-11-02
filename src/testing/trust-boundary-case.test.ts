import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { readFindingsRegister } from "../../scripts/scorecard-sources.mjs";

import {
  VERDICT_DOMAIN,
  type Verdict,
  type VerdictObservation,
} from "./open-soundness-defect.js";
import {
  limitationReferenceProblems,
  trustBoundaryCaseProblems,
  type TrustBoundaryCase,
} from "./trust-boundary-case.js";

/**
 * The self-test of the trust-boundary case (task BL-113). Each rejection
 * the mechanism promises is driven directly, over a synthetic register, so
 * a record cannot pass by the mechanism quietly accepting what it exists
 * to refuse.
 */

/** A register: its `## Status` table, then one section per row. */
function register(rows: readonly (readonly [string, string])[]): string {
  return [
    "## Status",
    "",
    "| ID | Package | Root cause | Impact | Status |",
    "|---|---|---|---|---|",
    ...rows.map(
      ([id, status]) => `| ${id} | pkg | cause | impact | ${status} |`,
    ),
    "",
    ...rows.flatMap(([id]) => [`## ${id} — a finding`, ""]),
  ].join("\n");
}

const FINDINGS = register([
  [
    "RWF-900",
    "Documented limitation (the trust boundary over the runtime's built-in prototypes, SOUNDNESS-CONTRACT § 1; task `BL-113`)",
  ],
  ["RWF-901", "Open"],
  ["RWF-902", "Fixed"],
]);

const OBSERVED: VerdictObservation = {
  verdict: "NOT_AFFECTED",
  proofFamily: "B",
  target: "vuln-lib#parse",
  reachableSubgraphComplete: false,
  unknownEdges: 3,
};

const VALID: TrustBoundaryCase<Verdict, VerdictObservation> = {
  caseId: "self-test",
  rwf: "RWF-900",
  soundWithoutBoundary: ["UNKNOWN"],
  observed: OBSERVED,
  control: { caseId: "self-test.control", called: false },
};

function problems(
  record: TrustBoundaryCase<Verdict, VerdictObservation>,
  live: VerdictObservation = record.observed,
  findings = FINDINGS,
): readonly string[] {
  return trustBoundaryCaseProblems(record, VERDICT_DOMAIN, live, findings);
}

describe("trust-boundary case: the mechanism rejects what it must", () => {
  it("accepts a well-formed record whose live result equals the observation", () => {
    expect(problems(VALID)).toEqual([]);
  });

  it("REJECTS an observation that is sound without the boundary", () => {
    const record = {
      ...VALID,
      observed: { ...OBSERVED, verdict: "UNKNOWN" as const },
    };
    const found = problems(record);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/is sound WITHOUT the boundary/);
  });

  it("REJECTS a control where real Node calls the target too (R2-3)", () => {
    expect(
      problems({
        ...VALID,
        control: { caseId: "self-test.control", called: true },
      }),
    ).toEqual([expect.stringMatching(/calls the target in the control/)]);
  });

  it("REJECTS a missing or self-referencing control", () => {
    for (const caseId of ["", "self-test"]) {
      expect(
        problems({ ...VALID, control: { caseId, called: false } }),
      ).toEqual([expect.stringMatching(/control must name another case/)]);
    }
  });

  it("REJECTS an empty soundWithoutBoundary", () => {
    expect(problems({ ...VALID, soundWithoutBoundary: [] })).toEqual([
      expect.stringMatching(/soundWithoutBoundary is empty/),
    ]);
  });

  it("FAILS when the analyzer starts answering soundly without the boundary", () => {
    const found = problems(VALID, {
      ...OBSERVED,
      verdict: "UNKNOWN",
      proofFamily: "-",
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/now handles this program\. Delete this record/);
  });

  it("FAILS when the live result drifts, even to another NOT_AFFECTED", () => {
    const found = problems(VALID, { ...OBSERVED, unknownEdges: 4 });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/DRIFTED/);
  });

  it("REJECTS a finding that is open, fixed, or absent", () => {
    for (const rwf of ["RWF-901", "RWF-902"]) {
      expect(problems({ ...VALID, rwf })).toEqual([
        expect.stringMatching(/is not a documented limitation/),
      ]);
    }
    expect(problems({ ...VALID, rwf: "RWF-903" }).join("\n")).toMatch(
      /no "## RWF-903 — …" heading[\s\S]*no row/,
    );
  });

  it("REJECTS a register the classifier refuses (a limitation citing no contract section)", () => {
    const refused = register([["RWF-900", "Documented limitation (BL-113)"]]);
    expect(limitationReferenceProblems("RWF-900", refused)).toEqual([
      expect.stringMatching(/cannot be classified/),
    ]);
  });
});

describe("every documented limitation is reproduced", () => {
  // BL-113's audit, round 1, F1: a finding can only be a documented
  // limitation with at least one trust-boundary case against real Node,
  // so the status never stands on prose alone.
  it("has at least one trust-boundary case in the oracle suite", () => {
    const oracle = path.resolve(
      fileURLToPath(new URL("../../tests/oracle/", import.meta.url)),
    );
    const cited = new Set<string>();
    for (const file of readdirSync(oracle)) {
      if (!file.endsWith(".cases.ts")) continue;
      const text = readFileSync(path.join(oracle, file), "utf-8");
      for (const match of text.matchAll(
        /boundaryCase:\s*\{\s*rwf:\s*"([A-Z]+-\d+[a-z]?)"/g,
      )) {
        cited.add(match[1]!);
      }
    }
    const limitations = readFindingsRegister().limitation.map((row) => row.id);
    for (const id of limitations) {
      expect(cited.has(id), `${id} has a trust-boundary case`).toBe(true);
    }
  });
});
