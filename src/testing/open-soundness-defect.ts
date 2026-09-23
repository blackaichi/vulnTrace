import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  classifyFindingsRegister,
  type FindingsRegister,
} from "../../scripts/scorecard-sources.mjs";

/**
 * OPEN SOUNDNESS DEFECTS -- the record a reproduction test uses while a
 * reproduced soundness defect is still open on `main`.
 *
 * WHY THIS EXISTS. AGENTS.md section G: "Never pin a wrong verdict as a
 * test's expected outcome." A reproduction of an open soundness defect has
 * to observe a wrong result, and the tempting way to keep it green --
 * `expect(verdict).toBe("NOT_AFFECTED")` over a program that really reaches
 * the sink -- states the defect as the specification. A later fix then
 * "breaks" the test, and the fix PR has to invert an assertion that read
 * as correct.
 *
 * A record keeps the two apart:
 *
 * - `admissible` -- every outcome that is SOUND for this case;
 * - `expected`   -- the one outcome the fail-closed fix is expected to give;
 * - `observed`   -- the exact wrong result the analyzer gives today, stated
 *                   separately and never called an expectation;
 * - `rwf`, `debt` -- the open FINDINGS record and OPEN-DEBTS entry that own
 *                   the defect.
 *
 * {@link openSoundnessDefectProblems} requires `expected` to be admissible,
 * `observed` to be NOT admissible (so it really is a defect record and not
 * a disguised expectation), both references to resolve to OPEN records,
 * and the live result to equal `observed` EXACTLY. It therefore fails in
 * both directions a test must notice: the defect is fixed (the record has
 * to be deleted in the fix PR, and the case asserts `expected` instead), or
 * the defect drifts into a different result (the record has to be
 * re-measured).
 *
 * WHAT THIS IS NOT. It is for OPEN SOUNDNESS DEFECTS ONLY -- not a general
 * "expected wrong" facility, not a precision-gap ledger, and not a way to
 * park a failing test. It deliberately shares no code with
 * `tests/binding-grammar/disagreements.ts`, whose guard makes a wrong EXACT
 * fail unconditionally inside that suite. It is also not `it.fails`, which
 * passes on ANY failure, including an unrelated exception.
 */

/**
 * How a record's outcomes are compared. `Pattern` is what `admissible` and
 * `expected` are written in (for a verdict: the verdict; for an edge: a
 * refusal or a specific EXACT target). `Outcome` is a full observation,
 * compared to `observed` by deep equality.
 */
export interface OutcomeDomain<Pattern, Outcome> {
  readonly name: string;
  /** Whether the observed `outcome` is one the `pattern` admits. */
  admits(pattern: Pattern, outcome: Outcome): boolean;
}

export interface OpenSoundnessDefect<Pattern, Outcome> {
  /** The case this record is about, as named in the test. */
  readonly caseId: string;
  /** The open `tests/validation/FINDINGS.md` record, e.g. `RWF-047`. */
  readonly rwf: string;
  /** The open `docs/OPEN-DEBTS.md` entry, e.g. `D-16`. */
  readonly debt: string;
  readonly admissible: readonly Pattern[];
  readonly expected: Pattern;
  readonly observed: Outcome;
}

/** The two documents a record's references must resolve against. */
export interface DefectRegisters {
  readonly findings: string;
  readonly openDebts: string;
}

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

export function loadDefectRegisters(): DefectRegisters {
  return {
    findings: readFileSync(
      path.join(repoRoot, "tests", "validation", "FINDINGS.md"),
      "utf-8",
    ),
    openDebts: readFileSync(
      path.join(repoRoot, "docs", "OPEN-DEBTS.md"),
      "utf-8",
    ),
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Problems with the `rwf` reference: it must name at least one `## <id> —`
 * heading in FINDINGS.md, and its row in FINDINGS.md's `## Status` register
 * must exist and be classified OPEN (`open` or `partlyOpen` -- a finding
 * only partly fixed is not fixed).
 *
 * ONE PARSER. The status is classified by `classifyFindingsRegister`, the
 * same function `docs/SCORECARD.md` is generated from: one designated
 * field, one closed vocabulary. This file used to carry its own reader
 * (`/^Open\b/` on the last cell), which could drift from the scorecard's.
 * A register the shared classifier refuses -- an unknown status value, a
 * contradicted `Fixed`, a missing row or section -- fails the record too,
 * which is the direction this check must fail in: a record that outlives
 * its defect is deleted, never kept green by a permissive match.
 */
export function rwfReferenceProblems(
  rwf: string,
  findings: string,
): readonly string[] {
  const problems: string[] = [];
  const id = escapeRegExp(rwf);
  const headings = findings.match(new RegExp(`^## ${id} — .*$`, "gm")) ?? [];
  if (headings.length === 0) {
    problems.push(`${rwf}: no "## ${rwf} — …" heading in FINDINGS.md`);
  }
  const closedHeading = headings.find((h) =>
    /^## \S+ — (REMEDIATED|FIXED|CLOSED)\b/.test(h),
  );
  if (closedHeading !== undefined) {
    problems.push(
      `${rwf}: FINDINGS.md heading marks it closed: ${closedHeading}`,
    );
  }

  let register: FindingsRegister;
  try {
    register = classifyFindingsRegister(findings);
  } catch (error) {
    problems.push(
      `${rwf}: FINDINGS.md's register cannot be classified, so no status can be read: ${(error as Error).message}`,
    );
    return problems;
  }
  // The classifier refuses duplicate ids, so there is at most one row.
  const row = register.rows.find((candidate) => candidate.id === rwf);
  if (row === undefined) {
    problems.push(
      `${rwf}: expected exactly one row in FINDINGS.md's "## Status" register, found 0`,
    );
    return problems;
  }
  if (row.category !== "open" && row.category !== "partlyOpen") {
    problems.push(
      `${rwf}: register status is not open: "${row.status.slice(0, 60)}" (value "${row.value}", category ${row.category})`,
    );
  }
  return problems;
}

/**
 * Problems with the `debt` reference: it must name a `### <id> —` heading
 * in OPEN-DEBTS.md that is not marked CLOSED.
 */
export function debtReferenceProblems(
  debt: string,
  openDebts: string,
): readonly string[] {
  const heading = openDebts.match(
    new RegExp(`^### ${escapeRegExp(debt)} — .*$`, "m"),
  );
  if (heading === null) {
    return [`${debt}: no "### ${debt} — …" heading in OPEN-DEBTS.md`];
  }
  if (/\bCLOSED\b/.test(heading[0])) {
    return [`${debt}: OPEN-DEBTS.md heading marks it closed: ${heading[0]}`];
  }
  return [];
}

/**
 * Every reason `record` is not a valid open-soundness-defect record for
 * the `live` result. Empty means valid. Pure, so the self-test can drive
 * each rejection directly.
 */
export function openSoundnessDefectProblems<Pattern, Outcome>(
  record: OpenSoundnessDefect<Pattern, Outcome>,
  domain: OutcomeDomain<Pattern, Outcome>,
  live: Outcome,
  registers: DefectRegisters,
): readonly string[] {
  const problems: string[] = [];
  const label = `${record.caseId} [${domain.name}]`;

  if (!record.admissible.some((p) => isDeepStrictEqual(p, record.expected))) {
    problems.push(
      `${label}: expected ${JSON.stringify(record.expected)} is not in the admissible set ${JSON.stringify(record.admissible)}`,
    );
  }
  if (record.admissible.some((p) => domain.admits(p, record.observed))) {
    problems.push(
      `${label}: observed ${JSON.stringify(record.observed)} is ADMISSIBLE, so it is not a defect -- this record would pin a sound result as a known wrong one`,
    );
  }
  for (const p of rwfReferenceProblems(record.rwf, registers.findings)) {
    problems.push(`${label}: ${p}`);
  }
  for (const p of debtReferenceProblems(record.debt, registers.openDebts)) {
    problems.push(`${label}: ${p}`);
  }
  if (!isDeepStrictEqual(live, record.observed)) {
    const fixed = record.admissible.some((p) => domain.admits(p, live));
    problems.push(
      fixed
        ? `${label}: the live result ${JSON.stringify(live)} is now ADMISSIBLE -- ${record.rwf} may be fixed for this case. Delete this record and assert the expected outcome ${JSON.stringify(record.expected)} instead.`
        : `${label}: the live result ${JSON.stringify(live)} differs from the recorded observation ${JSON.stringify(record.observed)} and is still not admissible -- the defect DRIFTED. Re-measure it; do not just copy the new value in.`,
    );
  }
  return problems;
}

// ---------------------------------------------------------------------------
// The two outcome domains the RWF-047 reproductions use.
// ---------------------------------------------------------------------------

export type Verdict = "AFFECTED" | "NOT_AFFECTED" | "UNKNOWN";

/**
 * A verdict-level observation. `admissible` and `expected` are written as
 * bare verdicts; `observed` carries everything the verdict rests on, so a
 * change in ANY of it -- the proof family, the attributed call target, the
 * completeness flag, the count of unresolved edges -- is a drift.
 */
export interface VerdictObservation {
  readonly verdict: Verdict | undefined;
  /** `A`, `B` or `C` for a negative proof; `-` when there is none. */
  readonly proofFamily: "A" | "B" | "C" | "-";
  /** `<module path>#<name>` the probed call resolves to, or `UNKNOWN <reason>`. */
  readonly target: string;
  readonly reachableSubgraphComplete: boolean;
  readonly unknownEdges: number;
}

export const VERDICT_DOMAIN: OutcomeDomain<Verdict, VerdictObservation> = {
  name: "verdict",
  admits: (pattern, outcome) => outcome.verdict === pattern,
};

/**
 * An edge-level pattern. A refusal admits ANY unresolved edge: no reason
 * code is pinned, because the fix chooses the existing reason and pins it
 * then. An EXACT admits only that exact `<module path>#<name>`.
 */
export type EdgePattern =
  | { readonly kind: "refusal" }
  | { readonly kind: "exact"; readonly target: string };

/** The single call edge leaving a probe, as a reproduction observes it. */
export type EdgeObservation =
  | { readonly kind: "exact"; readonly target: string }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "no-edge" }
  | { readonly kind: "ambiguous"; readonly count: number }
  | { readonly kind: "no-probe" };

export const EDGE_DOMAIN: OutcomeDomain<EdgePattern, EdgeObservation> = {
  name: "edge",
  admits: (pattern, outcome) =>
    pattern.kind === "refusal"
      ? outcome.kind === "unknown"
      : outcome.kind === "exact" && outcome.target === pattern.target,
};
