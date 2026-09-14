import type { Evidence } from "./evidence.js";
import type { VulnerableSymbolTarget } from "./target.js";
import type { UncertaintyClassification } from "./uncertainty.js";

/**
 * The three allowed verdicts (see docs/SDD.md § 5, AGENTS.md). `UNKNOWN`
 * must never be coerced into `NOT_AFFECTED`.
 */
export type Verdict = "AFFECTED" | "NOT_AFFECTED" | "UNKNOWN";

/**
 * A single scan finding: one vulnerability matched against one installed
 * package/version, with its verdict and (when available) the
 * vulnerable-behavior target and evidence that produced it
 * (see docs/SDD.md § 6, § 24, schemas/result.schema.json).
 *
 * Not modeled as a discriminated union on `verdict`: every documented
 * example and the checked-in schema use the same flat shape regardless of
 * verdict (only `confidence`/`target`/`evidence` presence varies in
 * practice — e.g. an `UNKNOWN` from an unresolved vulnerable target has no
 * `target` yet), so a union would add ceremony without a real type-safety
 * gain here. Contrast with {@link ReachabilityResult} in graph.ts, where
 * the payload genuinely differs per state.
 */
export interface Finding {
  readonly vulnerability: string;
  readonly package: string;
  /**
   * The installed version this finding is about, or `undefined` when the
   * instance's own version could not be established at all (P1-A5) -- a
   * private, versionless workspace package is the genuine case. Optional
   * rather than defaulted: borrowing a sibling instance's version, or
   * substituting a sentinel, would state something about this instance
   * that nothing established.
   *
   * No finding that had a version before P1-A5 lost one: a versionless
   * instance previously produced NO finding at all, so this widens what
   * can be reported without changing the shape of anything already
   * reported.
   */
  readonly version?: string;
  /**
   * WHICH installed instance this finding is about (P1-A5), rendered for
   * output by `describePackageInstance` -- project-relative when the
   * instance is inside the scanned project, canonical absolute otherwise.
   *
   * This is what makes two findings for the same advisory and the same
   * `package`@`version` distinguishable, which they must be: two installs
   * of `foo@1.2.0` at different roots are two packages with two
   * independent verdicts, and one may be AFFECTED while the other is
   * NOT_AFFECTED. Without it a reader sees two identical rows and cannot
   * tell which one the evidence belongs to.
   *
   * Presentation only. The canonical `PackageInstanceId` remains the
   * identity everywhere inside the analyzer; this is never compared or
   * parsed back. Optional because `buildFinding` callers may omit
   * `packageInstance` (see BuildFindingOptions).
   */
  readonly packageInstance?: string;
  readonly verdict: Verdict;
  readonly confidence?: number;
  readonly target?: VulnerableSymbolTarget;
  readonly evidence?: Evidence;
  /**
   * FOUNDATION F3 -- why this finding is `UNKNOWN`, machine-readably.
   *
   * Present ONLY on an `UNKNOWN`, and present on every one of them. An
   * `AFFECTED` has a reproduced path and a `NOT_AFFECTED` has a positive
   * proof; neither is uncertain, so neither carries this. That is a
   * structural statement, asserted by the F3 soundness suite, and it is
   * what keeps the field from ever being read as "how unsure are we about
   * this AFFECTED" -- a question this analyzer does not answer and must
   * not appear to.
   *
   * ADDITIVE AND OBSERVATIONAL. It duplicates no decision and makes none:
   * every entry is derived from the SAME blockers the verdict rules
   * already acted on, after those rules have run. Removing this field
   * would change no verdict anywhere, which is precisely the invariant F3
   * § 24 requires.
   *
   * NOT A REPLACEMENT FOR `evidence.reasons`. The prose there is retained
   * verbatim and still carries the specifics -- which module, which file
   * and line, which of several resolution failures. These entries carry
   * the classification and the count, which prose cannot. A consumer that
   * wants to explain a scan to a human reads the prose; one that wants to
   * aggregate a corpus reads this.
   *
   * ORDERED BY DECLARATION, NOT OBSERVATION -- see `aggregateUncertainty`.
   */
  readonly unknownReasons?: readonly UncertaintyClassification[];
}
