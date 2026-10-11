# Progress

The state of the work, for a fresh session. One screen; not a transcript.
Updated by every task's last commit ([`WORKFLOW.md`](WORKFLOW.md) § 1.7).

**Last updated:** 2026-10-12, by `B-6`.

## Objective

Close the soundness remediation: every reproduced false `NOT_AFFECTED`,
silent drop and fabricated edge in
[`OPEN-DEBTS.md`](OPEN-DEBTS.md) D-16 and D-17, through the four
structural invariants and two point-fix lanes of
[`REMEDIATION-PLAN.md`](REMEDIATION-PLAN.md), one task at a time. Only
then does capability work (P1-B) resume (OPEN-DEBTS § 4).

## State

- MVP, Foundation (F1–F7), P1-A1..A5 and P1-B1..B3b are merged.
- The remediation is designed (ADRs 0008–0011, the plan's § 6.1
  decisions) and its preparatory tasks are merged: H-0 (real-Node oracle
  harness), A-0 (ADR 0008 coverage reproduction, Amendment A-0 accepted),
  gate enforcement (every hermetic gate runs in CI), BL-001 (a false
  README-notice record corrected), D-03 (`npm test` and
  `npm run test:validation` are both fully offline — OPEN-DEBTS D-03,
  CLOSED) and BL-029 (`node scripts/differential.mjs`: the graph, proof
  and verdict differentials, base against head, over all 139 corpus
  cases — usage in [`WORKFLOW.md`](WORKFLOW.md) § 3).
- Lane A has started. `A-1` made every invocation site of a walked file
  yield an account (ADR 0008 invariant A1: a census of every
  `ts.SyntaxKind`, a handler table, `InvocationAccount`), fixed
  tagged templates, decorators and implicit `super` (PRM-37, PRM-115,
  PRM-19), and found and fixed RWF-057 (a `vm` tag). The no-edge branches
  still taken without a proof are named in `UNPROVEN_NO_EDGE_LEDGER`
  (`src/domain/graph.ts`) with the task that removes each (A-3, A-5).
  `A-2` added the `possible` edge kind (ADR 0008 § 1): reachability
  searches the code behind one, never reports an `AFFECTED` path through
  one, and answers `UNKNOWN` (`possible_invocation`) for a target reached
  only through one. `A-3a` (the first half of `A-3`, split by the project
  owner) is its first producer: ADR 0008 § 2's escape row, § 3's
  fail-closed default and § 4's documented invoking builtins. A builtin is
  identified by binding, never by spelling, and accounted by a table
  (`src/code-intelligence/builtin-callables.ts`) whose non-invoking
  positions are admitted mechanically by a real-Node test run in CI
  (`tests/oracle/builtin-admission.test.ts`); assignments into builtin
  values are escapes. Fixed AUD-01, PRM-12, PRM-114, PRM-117, RWF-060.
  `A-3b` (the second half) removed the last unproven builtin-side no-edge
  account (`module_scope_callee`): an own-export call gets an unknown
  edge, and a JSX element is a site (`jsx`) with its factory's unknown
  edge and possible edges to what it hands the factory -- both fail
  closed, by the project owner's decisions of 2026-10-02 (precision:
  backlog `BL-041`, `BL-042`). Fixed AUD-02, PRM-116, RWF-066. `A-4`
  accounted ADR 0008 § 2's protocol members (a definition the runtime may
  invoke implicitly: a possible edge from the owner that evaluates it;
  the iterator's `next` / `return` / `throw` added, RWF-068) and made every
  accessor its own node, reached by a possible edge (Amendment A-0 part
  B), by the project owner's decisions of 2026-10-04; the census has no
  pending kind left. It re-admitted the builtin positions that fire only
  protocol hooks, restoring RWB-07. Fixed PRM-38, PRM-112, PRM-113,
  PRM-118, RWF-068. `A-5a` (the first half of `A-5`, split by the project
  owner) applied resolution authority on the call-graph side: VT-213's
  callback edge is gone, `==` folds only same-type literals, `require` is
  ambient only when proven lexically in a proven CommonJS module, VT-210
  refuses escaping functions and written parameters, a reassigned
  `function` declaration is unresolved; every no-edge account carries a
  proof (`UNPROVEN_NO_EDGE_LEDGER` deleted). ADR 0008 § 4's receiver-bound
  invoking builtins resolve on a proven receiver (the owner's decision).
  Fixed PRM-13, 14, 15, 16, 17, 104, RWF-071, RWF-072, RWF-073. `A-5b`
  (the second half) replaced VT-208's checker-typed receiver with the
  receiver authority (a stable class for a static call, a `const` bound to
  `new C()` for an instance call, over plain class declarations) and
  withdraws a resolved method edge when any prepared file may write the
  member (`member-writes.ts`, reason `receiver_member_written`). Fixed
  PRM-18. `A-6`, the last of lane A, applied it on the binder side: a
  callee binds to an export only when its whole member chain is consumed
  (PRM-20, at every site); a single trailing `.call` / `.apply` is kept for
  a function export under the same member-write check (RWF-075, found and
  fixed); a destructured require is named by its key (PRM-108's origin; a
  computed key is still open at the consumer, C-4). What binds A-7, E and C
  next: REMEDIATION-PLAN § 5a, "A-3a additions" through "A-6 additions".
- Lane V has started. `V-1` (ADR 0011 predicates 2 and 3) deleted Site
  B's phantom target: a package with no node in the call graph is proved
  unreachable only by family A, and is otherwise `UNKNOWN` (PRM-101); Site
  A vs Site B is chosen by the exact `packageInstance`, never by the
  manifest's name (PRM-102). By the project owner's decision it also added
  ADR 0011 Amendment V-1: family C stands only when every module the
  closure loads has its top level reached from an entrypoint, closing
  RWF-078 (a module loaded only through a re-export declaration is never
  evaluated). `V-2` (predicate 1) made a closure truncated on its own walk
  (`traversal_truncated`) withdraw families B and C like every other
  closure reason (PRM-23; the exclusion and its false premise, "a truncated
  closure is accompanied by a truncated graph", are gone). `V-3`
  (predicate 4) materializes every entrypoint root by declaration
  position: a configured symbol through the export bindings that publish
  it, a root requirement witnessed by a position only, never a node name;
  a symbol that does not materialize is root incompleteness (PRM-25, and
  PRM-31, which ADR 0011 § 2 assigns to lane V). ADR 0011 § 2's
  name-keyed-lookup census is a Foundation test (`VT-INV-V-corroboration`).
  `V-4`, the last of lane V, made the corroboration structural (ADR 0011
  § 2): families B and C are built only from branded proof inputs, each
  produced by one function in `verdict.ts` that checks it
  (`corroborateClosure`: predicate 1, both halves; `corroborateEvaluation`:
  predicate 5; `attributeTarget`: predicate 3); an object literal of one is
  a compile error, a production cast to one fails a Foundation cast census,
  and an input no producer made is refused at runtime. What binds every
  later lane: REMEDIATION-PLAN § 5a, "V-1 additions" through "V-4
  additions".
- Lane C has started. `C-1` (ADR 0010 invariant C2) made module
  resolution run in Node's resolution mode whatever the tsconfig says: one fixed, branded set of
  NodeNext options (`NodeResolutionOptions`, module-resolver.ts), and a
  tsconfig `baseUrl` / `paths` mapping consulted only as a cross-check --
  one that disagrees with Node is `unresolved_module`. Fixed PRM-33 (22 of
  40 tsconfig shapes named `main` where Node loads `exports`) and RWF-083
  (a mapping shadowing an installed package or a sibling instance). By the
  project owner's decision (strict C2), ADV-023, ADV2-015 and ADV2-016 are
  `UNKNOWN`: real Node cannot load their aliased imports (RWF-084). Its
  audit's findings, fixed: the `types` export condition (RWF-087) and the
  declaration fallback's `exports` guard (RWF-088). The
  census `VT-INV-C-runtime-resolution` guards the authority. What binds
  C-2..C-5: REMEDIATION-PLAN § 5a, "C-1 additions".
- Lane B has started. `B-1` made every advisory OSV returns end in a
  finding or an accounted `unreportedCandidates` entry: the provider
  follows `next_page_token` to the end (a page cap, a repeated token or a
  failed page is a provider failure, exit 4), and the OSV cache key marks
  the paginated answer format (PRM-65); a record the normalizer cannot use,
  an empty `id` included, is an `undetermined` entry per instance
  (`advisory_record_malformed`), never only a diagnostic or a lost report
  (AUD-10, AUD-11); a withdrawn advisory is the new `withdrawn`
  disposition, output schema `0.7` (AUD-14, decision 10). Invariant
  `VT-INV-B-provider-completeness`. What binds B-2..B-6: REMEDIATION-PLAN
  § 5a, "B-1 additions". `B-2` made version applicability SemVer's and
  OSV's: strict SemVer precedence with prereleases, never `semver.coerce`
  (AUD-05); a range VulnTrace cannot order (GIT, ECOSYSTEM, untyped, no
  `introduced`, an entry with no bounds) is `indeterminate`, an `UNKNOWN`
  finding, never `not_applicable` (AUD-09); SEMVER events are walked
  sorted, as OSV specifies (RWF-091, found by it; RWF-092 from its
  audit). Invariant
  `VT-INV-B-version-applicability`. REMEDIATION-PLAN § 5a, "B-2
  additions". `B-3` made the OSV cache the user's, never the scanned
  project's: the user cache directory (`XDG_CACHE_HOME`, `LOCALAPPDATA`,
  `~/.cache`), and a directory inside the project, by any path or
  symlink, is refused and the scan runs uncached (AUD-07); an entry is a
  validated envelope served only for its own key and for `ttlHours`
  (default 24) after the provider answered (AUD-06); a write failure is
  a `cache` diagnostic, never exit 4 (PRM-35). Invariant
  `VT-INV-B-cache-authority`. REMEDIATION-PLAN § 5a, "B-3 additions".
  `B-4` made every installed package reach the report: a lock entry is
  never dropped for a missing name or version (a nameless `file:` entry is
  named by its manifest or linking entry, PRM-34; a named, versionless one
  is an instance, RWF-093); an instance with no established version is
  queried without one and is `UNKNOWN` per advisory (decision 4, PRM-64);
  an unreadable manifest is recorded (PRM-66); and the installed tree plus
  the closure's loaded instances are cross-checked against the lockfile,
  each unlisted package an identity entry by its exact instance (decision
  9, AUD-08). Four reason subtypes, no new category. Invariant
  `VT-INV-B-inventory-identity`. REMEDIATION-PLAN § 5a, "B-4 additions".
  `B-5` made the exit code say whether anything was left undecided
  (decision 3, AUD-12): `1` when something is `AFFECTED`, else `5` when a
  finding is `UNKNOWN` or an unreported candidate is `undetermined`, else
  `0` (`withdrawn` is decided); `--lenient-exit` restores `0` for the
  undecided case. Every result carries a `summary` of counts (schema
  `0.8`) from which the exit code is computed. An empty `--cve` is a usage
  error and an unmatched one is said (PRM-111); the versionless "no
  advisory" detail uses the unfiltered set (PRM-36); the HTML overview
  falls back to `unknownReasons` (PRM-110). Invariant
  `VT-INV-B-exit-decision`. REMEDIATION-PLAN § 5a, "B-5 additions".
  `B-6`, the last of lane B, made a rule apply only to the package it
  names (AUD-15): a finding for another package of a multi-package
  advisory is `UNKNOWN` with `rule_package_mismatch`, decided before any
  instance matching. REMEDIATION-PLAN § 5a, "B-6 additions".
- Numbers: [`SCORECARD.md`](SCORECARD.md) (measured, generated) and
  [`OPEN-DEBTS.md`](OPEN-DEBTS.md) (debts, P1-B entry criteria).

## Known limitations

**Until the remediation closes, treat every `NOT_AFFECTED` as `UNKNOWN`.**
OPEN-DEBTS § 3 criterion 3 is false on `main`: D-16 and D-17 record
dozens of reproduced paths to a false `NOT_AFFECTED` or a silently
dropped finding. The README says this (`README.md:80-88`, since
`ae82d33`); its `## Status` section now points there too (`BL-001`,
`tests/validation/FINDINGS.md` RWF-053 — an earlier version of this line
said the notice did not exist, which was false).
`npm run test:validation` is hermetic since `D-03` (replays a recorded
OSV snapshot) but is still not run in CI: five of its cases are
deliberately kept failing (OPEN-DEBTS D-09) and the suite exits non-zero
by design regardless of network access (backlog `BL-030`).

## Key decisions

- Soundness > explainability > precision > coverage > performance;
  `UNKNOWN` is first-class (ARCHITECTURE § 2, ADR 0002).
- Remediation invariants: ADR 0008 (call graph, lane A), 0009 (export
  model, E), 0010 (capability flow and resolution, C), 0011 (negative-proof
  corroboration, V). The owner's decisions: REMEDIATION-PLAN § 6.1 and the
  decision records appended to ADR 0008.
- One task at a time; the agent opens the pull request and never merges
  (AGENTS.md § H, [`WORKFLOW.md`](WORKFLOW.md)).

## Current task

`B-6` — Rule/package mismatch reason
([task file](tasks/B-6-rule-package-mismatch-reason.md)):
`READY_FOR_REVIEW`, its pull request awaiting the project owner. `B-5`
merged as PR #95.

## Next

The order is [`tasks/BACKLOG.md`](tasks/BACKLOG.md) § 1. After `B-6`:
`RWF-050-repro`, then lane E. The P1 gaps `BL-057` and `BL-058`
(small, `module-resolver.ts` only, from C-1), `BL-048`
(RWF-074, small, reusing A-5b's whole-graph check), `BL-050` (RWF-076),
`BL-040`, `BL-043` and `BL-051` (live family-A false `NOT_AFFECTED`s) are
candidates to reorder ahead of them.

## Recently discovered

From `B-6`: `BL-061` (P2: one rule per advisory id, so the second package
of a multi-package advisory can never be `AFFECTED`) and `BL-062` (P3: an
aliased instance reported under two names). AUD-15's recorded reason had
already changed before B-6 (measured).
