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
 * network. The real-world validation suite (`tests/validation/`) owns no
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
    | "F1"
    | "F2"
    | "F3"
    | "F4"
    | "F5"
    | "F6"
    | "VT-CONTRACT"
    | "P1-A"
    /** The soundness remediation's ADR 0008 (lane A; registered from task A-1). */
    | "ADR-0008"
    /** The soundness remediation's ADR 0010 (lane C; registered from task C-1). */
    | "ADR-0010"
    /** The soundness remediation's ADR 0011 (lane V; registered from task V-3). */
    | "ADR-0011"
    /** The soundness remediation's lane B point fixes (REMEDIATION-PLAN § 7; from task B-1). */
    | "LANE-B";
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
    owners: ["src/cli/result-schema.additivity.test.ts"],
    note:
      "A DIFFERENT invariant from the negative-proof shape contract, and " +
      "owned separately for that reason. An independent audit of F6 found " +
      "this mapped to `result-schema.negative-proof.test.ts`, which tests " +
      "VT-CONTRACT-01/02 and contains no additivity case at all -- coverage " +
      "claimed on paper. The assertions were extracted from " +
      "`cli/output.test.ts` into a focused owner the gate runs.",
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

  // ------------------------------------------------------------------
  // The soundness remediation, lane A (ADR 0008)
  // ------------------------------------------------------------------
  {
    id: "VT-INV-A1-invocation-accounting",
    invariant:
      "Every site of the kinds the census marks `site` (calls, `new`, " +
      "tagged templates, decorators, implicit `super`, assignments into " +
      "an ambient or builtin value) in a walked file yields an account: " +
      "edges, or a no-edge account backed by a proof from ADR 0008 § 2's " +
      "closed set -- there is no third outcome. Every ts.SyntaxKind is " +
      "classified, and every invocation-capable kind that is not yet " +
      "accounted (`pending`) names the open findings and lane-A task " +
      "that own it.",
    foundation: "ADR-0008",
    owners: [
      "src/code-intelligence/invocation-sites.census.test.ts",
      "src/code-intelligence/invocation-sites.site-coverage.test.ts",
      "src/code-intelligence/call-graph.invocation-account.test.ts",
      "src/code-intelligence/call-graph.escape-row.test.ts",
    ],
    note:
      "Task A-1. The census owns the classification of every syntax kind " +
      "(a new TypeScript node kind fails it); the site-coverage test owns " +
      "the walk -- every site of every file walked over the three corpora " +
      "has an account, pruned branches included; the account test owns " +
      "what the three A-1 sites (tagged templates, decorators, implicit " +
      "`super`) are accounted as. Until task A-5a it also owned the " +
      "unproven no-edge ledger; A-5a proved its last two reasons " +
      "(`ambient_static_require`, PRM-15; `provably_dead_branch`, PRM-14), " +
      "each owned by the account test with a named test per refusal, and " +
      "deleted the unproven variant. " +
      "Task A-3a added the two builtin no-edge proofs " +
      "(`primitive_only_arguments`, `non_invoking_builtin`), owned by the " +
      "escape-row test with a named test for each rule a mutation could " +
      "remove (lexical identity, the name exclusion of `new Proxy`, the " +
      "escape row's precedence, the fail-closed default); which positions " +
      "are admitted is decided MECHANICALLY by " +
      "`tests/oracle/builtin-admission.test.ts`, run in CI by " +
      "`npm run test:oracle` (it spawns real Node, so it is not a " +
      "Foundation-gate owner). JSX elements are sites since task A-3b; " +
      "protocol members and accessors since task A-4, which left the " +
      "census with no pending kind.",
  },
  {
    id: "possible-edge-into-walked-file",
    invariant:
      "Every `possible` edge the call graph emits points at a node of the " +
      "graph in a file the walk walked; one that would not is withdrawn to " +
      "an unknown edge naming its target.",
    foundation: "ADR-0008",
    owners: ["src/code-intelligence/call-graph.escape-row.test.ts"],
    note:
      "REMEDIATION-PLAN § 5a, 'A-2 additions', obligation 1; task A-3a, " +
      "the first producer. Enforced after the walk in `buildCallGraph` " +
      "(a resource limit can stop the walk after a file was discovered), " +
      "owned by the escape-row test (the withdrawal under a node limit, " +
      "and the checker `src/testing/possible-edge-obligation.ts`), and " +
      "asserted over the three corpora by the adversarial and validation " +
      "suites and over every oracle case by the harness, through " +
      "`runScanCommand`'s `onCallGraph` seam.",
  },
  {
    id: "affected-path-resolved-edges-only",
    invariant:
      "An AFFECTED path consists of resolved edges only. A `possible` edge " +
      "counts as reachable for family-C completeness but is never part of " +
      "an AFFECTED path, and a target reached only through `possible` " +
      "edges is UNKNOWN.",
    foundation: "ADR-0008",
    owners: [
      "src/analysis/reachability.affected-path.test.ts",
      "src/analysis/verdict.possible-edge.test.ts",
    ],
    note:
      "The project owner's Decision 2 (ADR 0008, 2026-09-26), stated in " +
      "SOUNDNESS-CONTRACT § 1 and § 3 by task A-1. Task A-2 added the " +
      "`possible` edge kind and the other two halves: the reachability " +
      "owner asserts all three on hand-built graphs and against a " +
      "set-based oracle over seeded random graphs; the verdict owner " +
      "asserts them through the production `buildFinding` on real " +
      "projects (UNKNOWN with `possible_invocation`, family C withheld by " +
      "an unknown edge behind a `possible` edge and kept by a clean one, " +
      "family B withdrawn by VT-300 through one). Its producers are tasks " +
      "A-3a, A-3b and A-4, each with production reproductions there.",
  },

  // ------------------------------------------------------------------
  // The soundness remediation, lane V (ADR 0011)
  // ------------------------------------------------------------------
  {
    id: "VT-INV-V-corroboration",
    invariant:
      "A negative proof is built only from facts keyed by exact identity " +
      "(ADR 0011 invariant V). Families B and C are built only from " +
      "branded proof inputs, each produced by one function that checks it: " +
      "a closure corroboration (predicate 1: the closure is present, has " +
      "roots, is complete and records no incompleteness reason, both " +
      "halves read together, with whether the exact instance is loaded " +
      "recorded), for family C every loaded module's top level reached " +
      "beside it (predicate 5), and a target attributed to a node of the " +
      "analyzed graph (predicate 3); an object literal of a branded type is " +
      "a compile error, a production type assertion to one outside its " +
      "producer fails the cast census, and an input no producer made is " +
      "refused at runtime. Site A or B is chosen by the exact package " +
      "instance, never by a package name (predicate 2). Every entrypoint " +
      "root is materialized by declaration position, never by a name, and " +
      "a configured symbol that does not materialize is root " +
      "incompleteness (predicate 4). Every expression in src/analysis and " +
      "src/code-intelligence that finds a graph node or an indexed function " +
      "by its name, or a package instance by its package name, is listed in " +
      "the census with its declared direction (widen-only, refuse-only, " +
      "test-flag-only, or open with its finding and task); a new, removed " +
      "or moved one fails.",
    foundation: "ADR-0011",
    owners: [
      "src/testing/name-lookup-census.test.ts",
      "src/analysis/verdict.identity-keyed-roots.integration.test.ts",
      "src/analysis/verdict.proof-inputs.test.ts",
      "src/testing/proof-input-casts.test.ts",
      "src/analysis/verdict.f2-proof-guards.test.ts",
      "src/analysis/verdict.f4-proof-mutation.test.ts",
      "src/analysis/verdict.site-b-target-authority.integration.test.ts",
    ],
    note:
      "Task V-3 (PRM-25, PRM-31). The census owns ADR 0011 § 2's " +
      "name-keyed-lookup gate, found through the TypeScript checker (a " +
      "self-test plants each kind of lookup in a scratch tree, so the " +
      "scanner cannot go blind); its open entries are PRM-26's, removed " +
      "by task E-1. The integration test owns predicate 4 through the " +
      "production buildFinding over real files; its real-Node ground " +
      "truth is tests/oracle/v3-identity-keyed-roots.test.ts, run in CI " +
      "by `npm run test:oracle` (it spawns real Node, so it is not a " +
      "Foundation-gate owner). Task V-4 registered predicates 1-3 and 5 " +
      "(tasks V-1, V-2) and the branded proof-input types: " +
      "verdict.proof-inputs.test.ts owns the producers, the evidence " +
      "constructors' runtime refusals and (through npm run typecheck, " +
      "which checks its @ts-expect-error lines) the brands; " +
      "proof-input-casts.test.ts owns the cast census, with a self-test; " +
      "the F2 and F4 suites own, through the production buildFinding, " +
      "predicate 1's two halves, predicate 5 and family B's own read of the " +
      "closure (the roots check, graph membership and the runtime marks are " +
      "reached by no production input and are owned by the unit tests " +
      "only); the Site B integration test owns predicate 3 end to end (no " +
      "phantom target). Predicate 2's " +
      "real-Node ground truth is tests/oracle/v1-site-b-corroboration.test.ts, " +
      "run in CI by `npm run test:oracle`.",
  },

  // ------------------------------------------------------------------
  // Lane C: capability flow and runtime resolution (ADR 0010)
  // ------------------------------------------------------------------
  {
    id: "VT-INV-C-runtime-resolution",
    invariant:
      "Every resolution that decides which file Node loads uses Node's " +
      "algorithm, whatever the project's tsconfig says (ADR 0010 invariant " +
      "C2): TypeScript's module resolution is reached in production only " +
      "from module-resolver.ts's runtime path, and only with " +
      "NodeResolutionOptions (moduleResolution NodeNext, allowJs, nothing " +
      "else from the tsconfig), built by its one producer. A tsconfig " +
      "baseUrl / paths mapping is consulted only as a cross-check: when it " +
      "resolves a specifier to a different outcome than Node's resolution, " +
      "the specifier is unresolved, never either answer followed silently. " +
      "A bare specifier into a package that declares exports never falls " +
      "back to main or a sibling file.",
    foundation: "ADR-0010",
    owners: [
      "src/testing/runtime-resolution-census.test.ts",
      "src/code-intelligence/module-resolver.runtime-resolution.test.ts",
    ],
    note:
      "Task C-1 (PRM-33, RWF-083). The census owns the authority, found " +
      "through the TypeScript checker (each call's resolved signature in " +
      "typescript.d.ts, so an alias is seen through; the options " +
      "argument's brand; every assertion to the brand), with a self-test " +
      "that plants each kind of call in a scratch tree. The resolver test " +
      "owns the behaviour against real `node`: ADR 0010 § 1's 40-row " +
      "module x moduleResolution table over PRM-33's package, the " +
      "baseUrl / paths cross-check both ways, and the declaration-only " +
      "fallback for a package with exports. The end-to-end verdicts are " +
      "tests/oracle/c1-runtime-resolution.test.ts, run in CI by " +
      "`npm run test:oracle`.",
  },

  // ------------------------------------------------------------------
  // Lane B: intake, cache, output (REMEDIATION-PLAN § 7)
  // ------------------------------------------------------------------
  {
    id: "VT-INV-B-provider-completeness",
    invariant:
      "Every advisory record the vulnerability provider answers for an " +
      "installed package is accounted: by a finding, or by an " +
      "unreportedCandidates entry per exact instance saying why there is " +
      "none (both, when a usable and an unusable copy share an id). The provider's answer is every OSV results page; an answer " +
      "it cannot read completely (a failed page, a repeated or malformed " +
      "token, more pages than the cap) fails the scan as a provider " +
      "failure, never as a shorter list. A record the normalizer cannot use " +
      "is an `undetermined` entry (`advisory_record_malformed`, " +
      "analysis_precondition_unmet), never only a diagnostic, and never a " +
      "finding that fails the output schema. A withdrawn advisory is a " +
      "`withdrawn` entry with no category, never analyzed.",
    foundation: "LANE-B",
    owners: [
      "src/cli/scan.b1-provider-completeness.test.ts",
      "src/vulnerabilities/osv-provider.pagination.test.ts",
    ],
    note:
      "Task B-1 (PRM-65, AUD-10, AUD-11, AUD-14). The provider test owns " +
      "pagination and its failure modes against a stubbed fetch; the scan " +
      "test owns the accounting end to end through the real OsvProvider, " +
      "the result schema's withdrawn rule and the HTML label. Loud fixture: " +
      "every rule targets an export the application calls, so an advisory " +
      "that disappears is a missing AFFECTED, never a quiet UNKNOWN.",
  },
  {
    id: "VT-INV-B-version-applicability",
    invariant:
      "An advisory is declared out of range for an installed version " +
      "(`not_applicable`) only when the version is a SemVer version and " +
      "every range the advisory declares for the package is a SEMVER range " +
      "that, evaluated as OSV specifies (events sorted by SemVer precedence, " +
      "prereleases included, never coerced), excludes it. A range that cannot " +
      "be ordered against a SemVer version (GIT, ECOSYSTEM, another or no " +
      "type, no introduced event, a bound that is not a SemVer version, two " +
      "event kinds at one version) and an affected entry with no ranges and " +
      "no versions are indeterminate, never empty: an UNKNOWN finding unless " +
      "another range or listed version covers the version.",
    foundation: "LANE-B",
    owners: [
      "src/vulnerabilities/version-applicability.b2.test.ts",
      "src/cli/scan.b2-version-applicability.test.ts",
    ],
    note:
      "Task B-2 (AUD-05, AUD-09, RWF-091). The unit test owns the " +
      "normalize-then-match pipeline against a literal transcription of " +
      "OSV's evaluation pseudo-code over generated, shuffled event lists " +
      "with prereleases, and the census that `semver.coerce` appears nowhere " +
      "in src/; the scan test owns each shape end to end through the real " +
      "OsvProvider, per exact instance. Loud fixture: the rule targets an " +
      "export the application calls, so an advisory wrongly declared out of " +
      "range is a missing AFFECTED.",
  },
  {
    id: "VT-INV-B-cache-authority",
    invariant:
      "A cached answer is served in place of the provider's only when it is " +
      "this cache's own entry for the exact query: a strictly validated " +
      "envelope (format, key, fetch time, and records that pass the " +
      "provider's own schema) written under the same key, fetched no later " +
      "than now and less than the configured TTL ago. The cache directory is " +
      "never inside the scanned project, by any path or symlink; when it " +
      "would be, or cannot be determined, the scan runs uncached and says " +
      "so. A failed cache write never changes an answer or the exit code: it " +
      "is a cache diagnostic.",
    foundation: "LANE-B",
    owners: [
      "src/cache/osv-cache.test.ts",
      "src/cache/cache-location.test.ts",
      "src/cli/scan.b3-osv-cache.test.ts",
    ],
    note:
      "Task B-3 (AUD-06, AUD-07, PRM-35). The store test owns what is " +
      "served (TTL boundary, future stamp, every non-own entry shape, the " +
      "pre-B-3 key) and that a write failure never fails a query; the " +
      "location test owns the default directory and the containment check " +
      "(symlinks, dangling links, fail-closed); the scan test owns each " +
      "finding end to end. Loud fixture: the rule targets an export the " +
      "application calls, so a stale, planted or malformed `[]` served as " +
      "the answer is a missing AFFECTED.",
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
      "Real npm packages against real advisories, replayed from a recorded " +
      "OSV snapshot since D-03 (was live, unconditionally, over the " +
      "network). Not excluded for network reasons any more: five cases " +
      "are deliberately kept failing (OPEN-DEBTS D-09) and the suite " +
      "asserts the expected verdict unconditionally, so it is not meant " +
      "to be all-green. Integration evidence that the analyzer works " +
      "against advisories nobody wrote for it, and a provider-movement " +
      "detector across re-recordings — not a correctness oracle. Not " +
      "removed; classified.",
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
