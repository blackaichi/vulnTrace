import type {
  JsonFinding,
  UnreportedCandidate,
  UnreportedCandidateDisposition,
} from "./output.js";

/**
 * Task B-5 (AUD-12, REMEDIATION-PLAN § 6.1 decision 3) -- what a scan
 * decided, as counts and one outcome, and the exit code that follows from
 * it.
 *
 * Before B-5 the exit code said only "AFFECTED or not": a scan in which
 * nothing was decided exited 0, exactly like a clean one, and the output
 * carried nothing a CI gate could read instead (AUD-12).
 *
 * The outcome is a function of the two arrays the output carries and of
 * nothing else, and the exit code is a function of the outcome and of
 * nothing else. That is what keeps the summary, the arrays and the exit
 * code from ever disagreeing: there is no second place that decides.
 */

/** Counts by verdict; every verdict is present, zero included. */
export interface FindingCounts {
  readonly AFFECTED: number;
  readonly NOT_AFFECTED: number;
  readonly UNKNOWN: number;
}

/** Counts by disposition; every disposition is present, zero included. */
export type UnreportedCandidateCounts = Readonly<
  Record<UnreportedCandidateDisposition, number>
>;

/**
 * - `affected`: at least one finding is `AFFECTED`.
 * - `undecided`: none is `AFFECTED`, and at least one candidate is
 *   undecided -- an `UNKNOWN` finding, or an `unreportedCandidates` entry
 *   whose disposition is `undetermined` (decision 3's "indeterminate").
 * - `decided`: neither. Every candidate is a `NOT_AFFECTED` finding or an
 *   entry with a certain disposition: `not_applicable` (decision 3's "a
 *   determinate not-applicable disposition") or `withdrawn`.
 *
 * `withdrawn` is decided (B-5 settles what B-1 left open, REMEDIATION-PLAN
 * § 5a). Decision 3's text lists neither way: its "decided" list names
 * `NOT_AFFECTED` and "a determinate not-applicable disposition", its
 * "undecided" list an `UNKNOWN` and an indeterminate disposition. A
 * withdrawal is read as the former: the provider states that the advisory
 * applies to no version at all, a determinate statement that it does not
 * apply, made with certainty and no uncertainty category (B-1, decision
 * 10), and nothing further could decide it. Flagged for the project owner.
 */
export type ScanOutcome = "affected" | "undecided" | "decided";

export interface ScanSummary {
  readonly outcome: ScanOutcome;
  readonly findings: FindingCounts;
  readonly unreportedCandidates: UnreportedCandidateCounts;
}

export function summarizeScan(
  findings: readonly Pick<JsonFinding, "verdict">[],
  unreportedCandidates: readonly Pick<UnreportedCandidate, "disposition">[],
): ScanSummary {
  const verdicts = { AFFECTED: 0, NOT_AFFECTED: 0, UNKNOWN: 0 };
  for (const finding of findings) {
    verdicts[finding.verdict] += 1;
  }
  const dispositions = { not_applicable: 0, undetermined: 0, withdrawn: 0 };
  for (const entry of unreportedCandidates) {
    dispositions[entry.disposition] += 1;
  }
  const outcome: ScanOutcome =
    verdicts.AFFECTED > 0
      ? "affected"
      : verdicts.UNKNOWN > 0 || dispositions.undetermined > 0
        ? "undecided"
        : "decided";
  return {
    outcome,
    findings: verdicts,
    unreportedCandidates: dispositions,
  };
}

/**
 * The scan's exit codes for a finished scan. The error codes (2 usage or
 * configuration, 3 analysis failure, 4 provider failure) are returned
 * before a scan finishes and keep their meaning (decision 3).
 */
export const SCAN_EXIT = {
  decided: 0,
  affected: 1,
  /** New in B-5: nothing is AFFECTED, and something is undecided. */
  undecided: 5,
} as const;

/**
 * The exit code for a finished scan. `lenient` (`--lenient-exit`) restores
 * the pre-B-5 behaviour, exit 0 whenever nothing is AFFECTED; it changes
 * this mapping only, never the summary.
 */
export function exitCodeFor(summary: ScanSummary, lenient: boolean): number {
  if (summary.outcome === "undecided" && lenient) {
    return SCAN_EXIT.decided;
  }
  return SCAN_EXIT[summary.outcome];
}
