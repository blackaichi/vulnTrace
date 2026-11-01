import { isDeepStrictEqual } from "node:util";

import {
  classifyFindingsRegister,
  type FindingsRegister,
} from "../../scripts/scorecard-sources.mjs";
import type { OutcomeDomain } from "./open-soundness-defect.js";

/**
 * TRUST-BOUNDARY CASES -- the record a reproduction test uses for a
 * program the soundness contract's trust boundary places outside what a
 * verdict claims (task BL-113; docs/SOUNDNESS-CONTRACT.md § 1, "The trust
 * boundary: the runtime's built-in prototypes").
 *
 * WHY THIS EXISTS. Such a program is reproduced against real Node: real
 * Node may reach the target while the analyzer answers `NOT_AFFECTED`. Its
 * finding is a DOCUMENTED LIMITATION, not an open defect, so it cannot be
 * an open-soundness-defect record (that record requires an open finding,
 * `open-soundness-defect.ts`). And it must never be pinned as an expected
 * verdict (AGENTS.md section G): under the boundary the contract claims
 * nothing about the program, which does not make `NOT_AFFECTED` the right
 * answer for it. A record keeps the three things apart:
 *
 * - `soundWithoutBoundary` -- every outcome that would be SOUND for this
 *   program if the contract made no such assumption (what a fix of the
 *   class, should one ever be decided, would have to give);
 * - `observed` -- the exact result the analyzer gives today, which only
 *   the boundary's assumption keeps from being a defect; never called an
 *   expectation;
 * - `rwf` -- the finding recorded as the boundary's documented limitation.
 *
 * {@link trustBoundaryCaseProblems} requires `observed` to be OUTSIDE
 * `soundWithoutBoundary` (otherwise the analyzer handles the program
 * without the boundary, and the record must go), the finding to be a
 * documented limitation, and the live result to equal `observed` EXACTLY.
 * It therefore fails when the analyzer starts answering soundly without
 * the boundary (delete the record; assert that answer instead), when the
 * result drifts (re-measure), and when the finding's status changes (a
 * finding reopened is an open defect again, and its cases go back to
 * open-soundness-defect records).
 *
 * WHAT THIS IS NOT. It is not a way to park a defect: a finding can only
 * be a documented limitation by citing the contract section that states
 * the boundary (`FINDINGS_STATUS_VOCABULARY`, scripts/scorecard-sources.mjs),
 * and only the project owner decides a boundary. Real Node's ground truth
 * is asserted by the case itself, against the release running it.
 */

export interface TrustBoundaryCase<Pattern, Outcome> {
  /** The case this record is about, as named in the test. */
  readonly caseId: string;
  /** The finding recorded as a documented limitation, e.g. `RWF-156`. */
  readonly rwf: string;
  /** Every outcome that would be sound without the trust boundary. */
  readonly soundWithoutBoundary: readonly Pattern[];
  /** The analyzer's exact result today. */
  readonly observed: Outcome;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Problems with the `rwf` reference: a `## <id> —` heading must exist, and
 * its row of the register's `## Status` table must be classified as a
 * documented limitation by the one classifier the scorecard uses.
 */
export function limitationReferenceProblems(
  rwf: string,
  findings: string,
): readonly string[] {
  const problems: string[] = [];
  if (!new RegExp(`^## ${escapeRegExp(rwf)} — `, "m").test(findings)) {
    problems.push(`${rwf}: no "## ${rwf} — …" heading in the register`);
  }
  let register: FindingsRegister;
  try {
    register = classifyFindingsRegister(findings);
  } catch (error) {
    problems.push(
      `${rwf}: the register cannot be classified, so no status can be read: ${(error as Error).message}`,
    );
    return problems;
  }
  const row = register.rows.find((candidate) => candidate.id === rwf);
  if (row === undefined) {
    problems.push(`${rwf}: no row in the register's "## Status" table`);
    return problems;
  }
  if (row.category !== "limitation") {
    problems.push(
      `${rwf}: register status is not a documented limitation: "${row.status.slice(0, 60)}" (category ${row.category}). A finding that is open again is an open-soundness-defect record's, not this one's.`,
    );
  }
  return problems;
}

/**
 * Every reason `record` is not a valid trust-boundary case for the `live`
 * result. Empty means valid. Pure, so the self-test can drive each
 * rejection directly.
 */
export function trustBoundaryCaseProblems<Pattern, Outcome>(
  record: TrustBoundaryCase<Pattern, Outcome>,
  domain: OutcomeDomain<Pattern, Outcome>,
  live: Outcome,
  findings: string,
): readonly string[] {
  const problems: string[] = [];
  const label = `${record.caseId} [${domain.name}]`;
  const sound = (outcome: Outcome) =>
    record.soundWithoutBoundary.some((p) => domain.admits(p, outcome));

  if (record.soundWithoutBoundary.length === 0) {
    problems.push(
      `${label}: soundWithoutBoundary is empty -- state what a sound answer without the boundary would be`,
    );
  }
  if (sound(record.observed)) {
    problems.push(
      `${label}: observed ${JSON.stringify(record.observed)} is sound WITHOUT the boundary, so the boundary is not what this case rests on -- delete the record and assert the verdict`,
    );
  }
  for (const p of limitationReferenceProblems(record.rwf, findings)) {
    problems.push(`${label}: ${p}`);
  }
  if (!isDeepStrictEqual(live, record.observed)) {
    problems.push(
      sound(live)
        ? `${label}: the live result ${JSON.stringify(live)} is sound without the boundary -- the analyzer now handles this program. Delete this record and assert that verdict instead.`
        : `${label}: the live result ${JSON.stringify(live)} differs from the recorded observation ${JSON.stringify(record.observed)} -- it DRIFTED. Re-measure it; do not just copy the new value in.`,
    );
  }
  return problems;
}
