# BL-029 — Shared graph, proof and verdict differential tool

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-029
- **Branch**: bl-029-differential-tool
- **Base SHA**: a42ce00f8277820fbc2dea3cdda61d759a9cea49
- **Commits**: (filled in by the last commit)
- **Superseded by**: —

## Project context

Every analyzer task must report its graph, proof and verdict
differentials separately (`AGENTS.md` § G; `docs/WORKFLOW.md` § 3), and a
zero corpus differential is not evidence of soundness (`OPEN-DEBTS.md`
D-12). There is no shared tool for this. `docs/WORKFLOW.md` § 3 says so
and names the stop-gap: the method of `docs/REMEDIATION-PLAN.md` § 9 (the
validation and adversarial runners' `ID EXPECTED ACTUAL RESULT` tables
diffed case by case, plus a finding dump by case, advisory and instance,
made in a scratch clone and thrown away) and the per-task corpus scripts
under `scripts/` (`scripts/*-corpus.mjs`, each measuring one task's
question and nothing else).

Premises, checked against `main` at the base SHA (`AGENTS.md` § D):

- **Measured.** No committed code dumps call-graph edges or findings by
  case, advisory and instance: `src/cli/` has no graph output, and no
  suite writes a finding dump. The only way to see a scan's call graph is
  to rebuild it outside `runScanCommand`, which can drift from what the
  scan actually built — the exact concern `RunScanOptions.onModuleLoadClosure`
  (VT-307d, `src/cli/scan.ts`) was added to avoid for the module-load
  closure.
- **Measured.** The call graph is final when `buildCallGraph` returns:
  `createAnalysisProofContext` binds it, and nothing in `src/analysis/`
  adds or removes an edge or a node afterwards.
- **Measured.** The scan's JSON output already carries, for each finding,
  the verdict, the evidence (the `AFFECTED` path and exactly one of the
  three negative-proof fields, families A, B and C of
  `docs/SOUNDNESS-CONTRACT.md`) and `unknownReasons`; and it carries
  `unreportedCandidates`. The proof and verdict differentials therefore
  need no analyzer change, only the graph differential does.
- **Measured.** At runtime the analyzer reads, outside `src/`, only
  `schemas/*.json` and `package.json`.
- **Measured.** The adversarial suites define their stub OSV records
  inline in the test files (`ADV_GHSA` in `tests/adversarial/v1/`,
  `VT2_GHSA` in `tests/adversarial/v2/`). The validation suite replays
  `tests/validation/osv-snapshot.json` through `SnapshotOsvProvider`
  (D-03).

This task changes no verdict, proof or finding. It adds one read-only
observation hook to `runScanCommand`; everything else is test
infrastructure. Backlog Audit column: `no`.

## Task

### Problem

Lane tasks A-1 onward each have to report three differentials. Measured
ad hoc, with a different script per task, the numbers cannot be compared
across tasks, a dropped finding is easy to miss (a case-table diff only
sees the one finding each case selects), and nothing records whether a
zero differential came from "no change" or from "nothing was measured".

### Why it matters

It is an instrument for the soundness work, not a soundness fix. It
cannot itself produce a false `NOT_AFFECTED`. A wrong instrument can hide
one, though: a differential that keys findings by `name@version` would
report no change when a sibling install's verdict is borrowed (`AGENTS.md`
§ G, ARCHITECTURE § 4), and a differential that silently skips a case
would report zero. The tool must fail loud on both.

### What to do

1. **Observation hook.** Add `RunScanOptions.onCallGraph`, invoked
   exactly once per scan that builds a call graph, after the truncation
   decision, with a deep copy of the graph and the truncation flag. It
   returns `void`, and nothing reads anything from it. It is not reachable
   from the CLI or `vulntrace.yml`. Test that it fires once, that the scan
   output is byte-identical (apart from the scan ID and timings) with and
   without it, and that mutating what it receives cannot change a verdict.
2. **One source for the adversarial stub records.** Move `ADV_GHSA` and
   `VT2_GHSA` into `src/testing/`, and import them from both suites and
   from the tool, so the tool cannot drift from the suites.
3. **Collector** (TypeScript, run through its own vitest config so it
   compiles the same way the suites do). For each case of the three
   corpora — `tests/validation` (temp copy, `SnapshotOsvProvider`, as the
   suite does), `tests/adversarial/v1` and `tests/adversarial/v2` (in
   place, their stub providers, as the suites do) — run `runScanCommand`
   and record a normalized snapshot: exit code, the call graph (or "not
   observed"), every finding, every unreported candidate. Paths are
   normalized to placeholders, so two roots give identical snapshots.
4. **Differ** (pure JavaScript under `scripts/`, with type declarations, so
   the driver can run it and `npm test` can test it). Report three
   separate sections:
   - **graph**, by case: nodes added and removed; call sites added,
     removed and re-resolved (with resolved→unknown and unknown→resolved
     counted apart); a case whose graph was not observed on either side
     is listed as unavailable, never counted as zero;
   - **proof**, by case, advisory and exact package instance: the proof
     family, the evidence path, the evidence reasons, the negative-proof
     fields, the unknown reasons, the target and the confidence — each
     change marked with whether the verdict also moved;
   - **verdict**, by the same key: verdict changes (moves into
     `NOT_AFFECTED` flagged apart), findings added, findings removed
     (flagged as possible silent drops), and unreported-candidate entries
     added and removed.

   Plus the suites' own view: each case's expected verdict against the
   base and head verdicts, selected with the suites' own selector rules.
5. **Driver** `scripts/differential.mjs`. The head side is the current
   working tree. The base side is a scratch directory holding the base
   commit's `src/` (with the head's `src/testing/`, which holds the
   instrument), `schemas/` and `package.json`. Both sides read the head's
   corpus (fixtures, cases, expected verdicts, OSV snapshot), so a
   difference is attributable to analyzer code only. Refuse a base whose
   `package-lock.json` differs from the head's, unless explicitly told to
   use the head's dependencies anyway. Also: `--collect` (one side only)
   and `--diff` (two snapshot files).
6. **Tests** (`npm test`). Each differential category is shown to fire on
   a planted change. Identity: two installs sharing name and version whose
   verdicts swap produce two verdict changes (a `name@version` key would
   produce none). An unobserved graph is reported unavailable. Paths
   normalize.
7. **Measure.** Run the tool head against head (the noise floor: must be
   zero in all three) and base against head for this branch; report both.
8. **Records.** `docs/WORKFLOW.md` § 3 and `docs/REMEDIATION-PLAN.md` § 9
   (a pointer only) name the tool; backlog, progress.

## Boundaries

### Do not touch

- Any verdict, proof, finding or evidence code path. The only `src/`
  change outside `src/testing/` is the observation hook.
- The oracles: `tests/validation/cases/cases.json` and both
  `expected.json` files, and the validation OSV snapshot.
- The worktree `rwf-046-require-binding-authority`.

### STOP conditions

- The hook cannot be added without changing the scan's output or its
  order of operations: stop, `NEEDS_DECISION`.
- Head against head is not zero (a nondeterministic scan): that is a
  finding; register it and stop if it makes the base-against-head numbers
  unattributable.
- Base against head for this branch shows any proof or verdict difference:
  the hook is not observation-only; stop, `STOPPED_ON_FINDING`.

## Acceptance criteria

- [ ] `RunScanOptions.onCallGraph` exists, fires exactly once per scan
      that builds a graph, receives a copy, and a test shows the scan
      output unchanged with it and a mutation of its argument inert.
- [ ] The adversarial stub records have one definition, used by both
      suites and by the tool.
- [ ] `node scripts/differential.mjs` produces a report with separate
      graph, proof and verdict sections, keyed by case, advisory and exact
      package instance, and a case table with expected, base and head.
- [ ] A case with no observed graph is reported as unavailable, not zero.
- [ ] Tests in `npm test` show each category firing on a planted change,
      and a sibling swap between two same-`name@version` installs
      reported as two changes.
- [ ] Head against head: zero graph, proof and verdict differences.
- [ ] Base against head for this branch: zero proof and verdict
      differences; the graph differential is unavailable on the base side
      (the base has no hook), and the report says so.
- [ ] `docs/WORKFLOW.md` § 3 names the tool and its usage.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. `npm run test:validation`
must show exactly the five known failures of OPEN-DEBTS D-09 (`RWB-03`,
`RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`), with the same actual verdicts
as on the base. The adversarial suites' result tables must be identical to
the base's.

## Report

In the format of `AGENTS.md` § J. Also report the tool's own run time for
the full corpus, one side and both.
