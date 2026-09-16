/**
 * FOUNDATION F6 — THE INVARIANT OWNERSHIP MAP.
 *
 * One authoritative answer to "which deterministic test owns this
 * invariant, and what command runs it" (F6 § 2). This is a DATA structure
 * rather than a section of a document for one reason: a document drifts
 * silently, and `foundation-invariants.test.ts` fails the moment an owner
 * named here stops existing, stops being executed by the Foundation gate,
 * or is listed twice.
 *
 * WHAT COUNTS AS AN OWNER.
 *
 * An owner is a DETERMINISTIC test file whose failure is an unambiguous
 * report that this specific invariant broke. Supporting coverage that
 * happens to touch the same ground is deliberately NOT listed: F6 § 2 asks
 * for the avoidance of duplicate oracles, and listing every file that
 * incidentally exercises `PackageInstance` identity would turn the map
 * back into the prose it replaces. Where an invariant genuinely has more
 * than one owner, each owns a DIFFERENT face of it, and the comment says
 * which.
 *
 * WHAT IS DELIBERATELY ABSENT.
 *
 * Nothing here is a wall-clock measurement, and nothing here needs a
 * network. The live OSV validation suite (`tests/validation/`) owns no
 * invariant in this map on purpose — see {@link LIVE_SIGNALS}.
 */

/** A Foundation invariant and the deterministic test file(s) that own it. */
export interface InvariantOwnership {
  /** Stable identifier, used in failure output and in RWF-039. */
  readonly id: string;
  /** The invariant itself, stated as the thing that must remain true. */
  readonly invariant: string;
  /** Which Foundation task established it. */
  readonly foundation:
    "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "VT-CONTRACT" | "P1-A";
  /** Repo-relative test files that own it. Each must exist and be gated. */
  readonly owners: readonly string[];
  /** Why these owners, and what each one is responsible for. */
  readonly note: string;
}

export const FOUNDATION_INVARIANTS: readonly InvariantOwnership[] = [
  // ------------------------------------------------------------------
  // PackageInstance identity (P1-A5 / F1)
  // ------------------------------------------------------------------
  {
    id: "package-instance-exact-isolation",
    invariant:
      "Two installed copies of a package are two PackageInstances. Nothing " +
      "— name, version, scope, alias or symlink — may merge or substitute them.",
    foundation: "P1-A",
    owners: [
      "src/dependencies/package-instances.differential-oracle.test.ts",
      "src/dependencies/package-instances.test.ts",
      "src/domain/resolved-target.workspace-twins.test.ts",
    ],
    note:
      "The differential oracle owns the question against REAL Node (twins, " +
      "aliases, scoped collisions, symlink convergence, workspace identity); " +
      "`package-instances` owns enumeration and registry behaviour; " +
      "`workspace-twins` owns the workspace/installed identity pair that F5's " +
      "caches could most plausibly collide.",
  },
  {
    id: "package-instance-proof-binding",
    invariant:
      "A negative proof about instance A never certifies instance B: every " +
      "proof names the finding's own instance.",
    foundation: "F4",
    owners: ["src/analysis/verdict.f4-proof-mutation.test.ts"],
    note:
      "The mutation harness's package-instance and target-identity matrices " +
      "own this; it is the only suite that attacks the binding rather than " +
      "merely observing it hold.",
  },

  // ------------------------------------------------------------------
  // Negative proof families (F4)
  // ------------------------------------------------------------------
  {
    id: "proof-family-exclusivity",
    invariant:
      "Families A, B and C are mutually exclusive, and a NOT_AFFECTED carries " +
      "exactly one of them.",
    foundation: "F4",
    owners: [
      "src/analysis/verdict.negative-proof.test.ts",
      "src/cli/result-schema.negative-proof.test.ts",
    ],
    note:
      "`verdict.negative-proof` owns the analyzer-side exclusivity; the " +
      "schema test owns it STRUCTURALLY at the output boundary " +
      "(VT-CONTRACT-01), so a future producer cannot emit two proofs even if " +
      "the analyzer would not.",
  },
  {
    id: "f4-unsafe-survival-zero",
    invariant:
      "No mutation that removes a proof family's own prerequisite leaves that " +
      "family standing. unsafe_survival === 0.",
    foundation: "F4",
    owners: ["src/analysis/verdict.f4-proof-mutation.test.ts"],
    note:
      "THE sound invariant of F4, and the hard gate. Informational counts in " +
      "the same summary are asserted only as lower bounds, so coverage may " +
      "grow without editing the gate.",
  },
  {
    id: "harness-closure-not-fabricated",
    invariant:
      "A package-sensitive default closure cannot be fabricated by a test " +
      "harness, and an intentionally absent closure is explicit.",
    foundation: "F4",
    owners: ["src/testing/finding.f4-closure-hardening.test.ts"],
    note:
      "Owns the harness itself rather than the analyzer: synthetic F4 states " +
      "must not be presentable as production-reachable evidence.",
  },

  // ------------------------------------------------------------------
  // Fail-closed guards (F2)
  // ------------------------------------------------------------------
  {
    id: "absent-mlc-fails-closed",
    invariant:
      "An ABSENT module-load closure is never read as a satisfied guard. No " +
      "closure means no family-A proof.",
    foundation: "F2",
    owners: [
      "src/analysis/verdict.f2-proof-guards.test.ts",
      "src/analysis/verdict.module-load-absence.test.ts",
    ],
    note:
      "`f2-proof-guards` owns absence and the guard's fail-closed direction; " +
      "`module-load-absence` owns the proof that is legitimately produced " +
      "when the closure IS present, which is what makes the first non-vacuous.",
  },
  {
    id: "graph-truncated-fails-closed",
    invariant:
      "A truncated call graph withdraws every proof that depends on graph " +
      "completeness.",
    foundation: "F2",
    owners: ["src/analysis/verdict.f2-proof-guards.test.ts"],
    note: "Owned alongside the other F2 preconditions, in one guard suite.",
  },
  {
    id: "unknown-dynamic-call-reason-fails-closed",
    invariant:
      "A DynamicCallReason the classifier does not recognise is treated as " +
      "possible loading, never as safe.",
    foundation: "F2",
    owners: [
      "src/analysis/module-load-closure.test.ts",
      "src/analysis/module-load-closure.differential-oracle.test.ts",
    ],
    note:
      "The unit suite owns the classifier's own fail-closed default; the " +
      "differential oracle owns the INVARIANT behind it against real Node, " +
      "catching construct families nobody has thought of yet.",
  },
  {
    id: "analysis-proof-context-binding",
    invariant:
      "Proof-relevant inputs are bound into one branded, frozen context; a " +
      "foreign, stale, thawed or unbranded context withdraws every proof.",
    foundation: "VT-CONTRACT",
    owners: [
      "src/analysis/verdict.analysis-context.test.ts",
      "src/cli/scan.analysis-context.test.ts",
    ],
    note:
      "VT-CONTRACT-03. The analysis suite owns the contract; the CLI suite " +
      "owns it AT THE PRODUCTION BOUNDARY — that `cli/scan.ts` really does " +
      "build exactly one context per scan.",
  },

  // ------------------------------------------------------------------
  // Output contract (F3)
  // ------------------------------------------------------------------
  {
    id: "three-verdicts-only",
    invariant:
      "The analyzer emits exactly three verdicts: AFFECTED, NOT_AFFECTED, " +
      "UNKNOWN.",
    foundation: "F3",
    owners: ["src/domain/verdict.test.ts"],
    note: "The domain type owns its own closed vocabulary.",
  },
  {
    id: "unknown-is-structured",
    invariant:
      "Every UNKNOWN carries structured, categorised reasons from a closed " +
      "vocabulary — never prose alone.",
    foundation: "F3",
    owners: [
      "src/analysis/verdict.f3-uncertainty-taxonomy.test.ts",
      "src/domain/uncertainty.test.ts",
    ],
    note:
      "The taxonomy suite owns which reasons a verdict acquires; the domain " +
      "suite owns the vocabulary and its reason->category mapping.",
  },
  {
    id: "unreported-candidate-distinct-from-finding",
    invariant:
      "A candidate that produced no finding is recorded in its own array, " +
      "with `not_applicable` distinct from `undetermined`, and is never a " +
      "verdict.",
    foundation: "F3",
    owners: [
      "src/cli/scan.f3-no-finding.test.ts",
      "src/cli/scan.metadata-uncertainty.test.ts",
    ],
    note:
      "`f3-no-finding` owns the distinction and the disposition rules; " +
      "`metadata-uncertainty` owns the identity-stage candidates a malformed " +
      "or contradictory manifest produces.",
  },
  {
    id: "schema-additivity",
    invariant:
      "Output added by later Foundation tasks does not invalidate results a " +
      "pre-F3 consumer would have accepted.",
    foundation: "F3",
    owners: ["src/cli/result-schema.negative-proof.test.ts"],
    note:
      "Owns `schemas/result.schema.json` against both old-compatible and " +
      "current structured output.",
  },

  // ------------------------------------------------------------------
  // Workspace / dependency uncertainty (F1)
  // ------------------------------------------------------------------
  {
    id: "workspace-incompleteness-is-machine-visible",
    invariant:
      "Workspace discovery that could not complete is reported structurally, " +
      "not as silence.",
    foundation: "F1",
    owners: [
      "src/dependencies/workspaces.truncation.test.ts",
      "src/cli/scan.workspace-uncertainty.test.ts",
    ],
    note:
      "The dependencies suite owns truncation detection; the CLI suite owns " +
      "its appearance in the scan's own output channels.",
  },

  // ------------------------------------------------------------------
  // Per-scan caches and indexes (F5)
  // ------------------------------------------------------------------
  {
    id: "f5-index-refusal-is-not-absence",
    invariant:
      "A graph index that returns `undefined` means 'this index cannot " +
      "answer', never 'this package is absent'. Refusal falls back to the " +
      "authoritative walk.",
    foundation: "F5",
    owners: ["src/analysis/scan-caches.f5-graph-index.test.ts"],
    note:
      "The single most dangerous F5 failure mode: an accelerator mistaken " +
      "for an authority would manufacture family-B proofs.",
  },
  {
    id: "f5-cache-identity-isolation",
    invariant:
      "No per-scan memo merges two distinct PackageInstanceIds, and a failed " +
      "filesystem or manifest operation is never memoized as a success.",
    foundation: "F5",
    owners: [
      "src/domain/resolved-target.f5-identity-cache.test.ts",
      "src/cli/scan.f5-performance-foundation.test.ts",
    ],
    note:
      "The domain suite owns key exactness and failure non-memoization; the " +
      "CLI suite owns cross-scan isolation — concurrent scans share no state.",
  },
  {
    id: "f5-multiplier-structural",
    invariant:
      "Verdict-phase identity work is O(graph nodes) + O(1) per advisory, " +
      "never O(graph nodes x advisories).",
    foundation: "F5",
    owners: ["src/analysis/scan-caches.f5-multiplier.test.ts"],
    note:
      "An exact OPERATION-COUNT gate, not a stopwatch. The wall-clock ratio " +
      "it replaced was measurably anti-correlated with the regression it " +
      "claimed to catch (RWF-038 § CI gate remediation).",
  },

  // ------------------------------------------------------------------
  // Foundation-wide gates (F6)
  // ------------------------------------------------------------------
  {
    id: "semantic-differential-offline",
    invariant:
      "The analyzer's SEMANTICS — verdicts, proof families, candidates, " +
      "diagnostics, ordering — are pinned by a differential that needs no " +
      "network, and that differential is non-vacuous in every class it claims.",
    foundation: "F6",
    owners: ["src/testing/foundation-differential.test.ts"],
    note:
      "Closes the two coverage gaps RWF-038's audit recorded: zero " +
      "unreportedCandidates and a single diagnostic source.",
  },
  {
    id: "output-determinism",
    invariant:
      "Findings, proofs, unknownReasons, unreportedCandidates and diagnostics " +
      "are ordered as a function of WHAT was analysed, not of input order.",
    foundation: "F6",
    owners: ["src/testing/foundation-differential.test.ts"],
    note:
      "Owned by the differential because determinism is only meaningful " +
      "against the same semantic corpus that proves the ordering non-trivial.",
  },
  {
    id: "fixture-integrity",
    invariant:
      "Every file under `fixtures/` and `tests/` is committed — no ignore " +
      "rule may silently swallow test input.",
    foundation: "F6",
    owners: ["src/testing/fixtures-are-committed.test.ts"],
    note:
      "Guards the exact `dist/` shape that once passed locally and broke CI, " +
      "and asserts that rule is still ignored so the check is not vacuous.",
  },
  {
    id: "gate-ownership-is-accurate",
    invariant:
      "Every invariant in this map names an owner that exists and that the " +
      "Foundation gate actually executes, and the gate contains nothing the " +
      "map does not account for.",
    foundation: "F6",
    owners: ["src/testing/foundation-invariants.test.ts"],
    note:
      "The map's own owner, and deliberately self-referential: a coverage " +
      "map that can drift reports coverage that is not there, which is worse " +
      "than having no map. It also pins the three wall-clock thresholds, so " +
      "raising one to make CI green is a two-file change (F6 § 11).",
  },
  {
    id: "commit-metadata-hygiene",
    invariant:
      "Commits added after the F6 base carry no model name in an identity " +
      "trailer and no session telemetry.",
    foundation: "F6",
    owners: ["src/testing/commit-metadata-policy.test.ts"],
    note:
      "Both directions: forbidden forms rejected, ordinary prose accepted. " +
      "The git walk lives in `scripts/validate-commit-metadata.mjs` and runs " +
      "under `validate:history`.",
  },
];

/**
 * Signals that are real evidence but are NOT deterministic owners of any
 * invariant above (F6 § 15).
 *
 * The distinction is the point. Each of these can fail for reasons that
 * have nothing to do with this repository — an advisory database changing
 * its mind, a network hiccup, a busy machine — so making core Foundation
 * CI depend on them would convert provider movement into analyzer
 * "regressions". They remain valuable, and are run and reported
 * separately.
 */
export const LIVE_SIGNALS: readonly {
  readonly id: string;
  readonly command: string;
  readonly why: string;
}[] = [
  {
    id: "live-osv-validation",
    command: "npm run test:validation",
    why:
      "Hits the real OSV API over the network against real npm packages. " +
      "Integration evidence that the analyzer works against advisories " +
      "nobody wrote for it — and a provider-movement detector, not a " +
      "correctness oracle. Not removed; classified.",
  },
  {
    id: "adversarial-suites",
    command: "npm run test:adversarial",
    why:
      "Deterministic and offline, but deliberately KEEPS scenarios that " +
      "disagree with the analyzer rather than fixing the analyzer to pass " +
      "them. It measures overfitting, so its pass/fail line is a research " +
      "record rather than an invariant. Run in full CI, not in the fast gate.",
  },
  {
    id: "wall-clock-performance",
    command: "npm run test:performance",
    why:
      "Coarse catastrophic-regression smoke. Generous absolute ceilings " +
      "(5,000ms / 20,000ms / 10,000ms) that answer 'did something explode', " +
      "never 'is the complexity contract intact' — that is " +
      "`f5-multiplier-structural`'s job. See F6 § 10 and § 11.",
  },
];
