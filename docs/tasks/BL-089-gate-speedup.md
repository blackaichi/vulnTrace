# BL-089 — Speed up the local gate run without weakening any gate

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-089
- **Branch**: bl-089-gate-speedup
- **Base SHA**: 54858baef38e69175a2e73186329ff056663c725
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Requested by the project owner on 2026-10-15, ahead of the queue, with
the handling of items 2–4 below approved in the same exchange ("go do
your proposals"). Tooling only: no analyzer code changes, so the backlog
Audit column is `no`. The rules it works under are `AGENTS.md` § I (the
gate set, unrelaxed) and § G, `docs/WORKFLOW.md` § 1.5 and § 3, the
differential tool of `BL-029` (`scripts/differential.mjs`) and the
real-Node oracle harness of `H-0` (`src/testing/oracle/`).

Premises, checked against `main` at the base SHA (`AGENTS.md` § D):

- **Measured: the only overlap is deliberate.** `vitest.config.ts` runs
  `src/**/*.test.ts` except `src/cli/scan-performance.test.ts`.
  `vitest.foundation.config.ts` runs an explicit list of `src/` files,
  every one of which `npm test` also runs. The adversarial, binding-grammar,
  oracle, validation and performance configs include
  `tests/adversarial/**`, `tests/binding-grammar/**`, `tests/oracle/**`,
  `tests/validation/**` and `src/cli/scan-performance.test.ts`: disjoint
  from each other and from `npm test`. The duplication is documented as a
  design decision in `vitest.foundation.config.ts` ("THIS IS A SUBSET,
  NOT A SECOND SUITE", F6 § 25) and in `.github/workflows/ci.yml` ("costs
  one extra short run and can never disagree with the full one").
  Removing it from CI or from the configs changes CI semantics, which the
  owner's request makes a stop condition, so it is removed from the local
  runner only (item 2).
- **Measured: the differential's base side is more than the base
  analyzer and the corpus.** `scripts/differential.mjs` lays this tree's
  instrument over the base commit (`src/testing/`,
  `scripts/differential-lib.mjs`, `tests/differential/`,
  `vitest.differential.config.ts`) and links this tree's `node_modules`.
  A cache keyed by (base SHA, corpus-input hash) alone would serve a stale
  base collection after a change to `src/testing/`, which most tasks
  change. The key is extended (item 3); this only adds invalidation.
- **Measured: a scan reads above the scanned project.** The analyzer
  models Node's ancestor lookups: the nearest `package.json` scope and the
  `node_modules` walk to the filesystem root
  (`src/code-intelligence/module-resolver.ts`, `nearestManifest` and the
  bare-specifier loop), and the installed-tree cross-check covers "one
  Node finds outside the project, in an ancestor `node_modules`"
  (`src/cli/scan.ts`). The adversarial corpora are scanned in place,
  inside the repository; the validation corpus in a copy under
  `os.tmpdir()`. So a base-side record can depend on files above a
  fixture, including above the repository root.
- **Measured: an oracle scan's inputs are more than the project's
  bytes.** `runVariant` (`src/testing/oracle/case.ts`) scans with
  `kase.provider()` (a factory) and `kase.scanOptions`
  (`configPathOverride`, `cveFilter`, `format`, `outputPath`, `noCache`,
  `cacheDir`); a scan's output may also carry the temporary directory's
  path. Keying a reuse on the project's content alone could hand a
  control another case's result under a different advisory.
- **Measured: vitest isolates test files** (`isolate` is on by default in
  every config), so an in-memory reuse lives within one test file of one
  run, and cannot outlive the run.
- **Measured: the validation baseline is machine-readable.**
  `tests/validation/cases/cases.json` marks exactly OPEN-DEBTS D-09's five
  known failures `knownFailure: true` (`VAL-002`, `VAL-003`, `RWB-03`,
  `RWB-05`, `RWB-09b`).

## Task

### Problem

A full local run of `AGENTS.md` § I is slow (per-gate durations below),
and a task runs it after every audit round. The foundation files run
twice; the differential collects the base side again on every run, even
when nothing it reads has changed; and the oracle harness scans a control
project again when an earlier case of the same file scanned the identical
project under the identical provider and options.

### Why it matters

Workflow performance, not analyzer performance. Nothing here can change a
verdict, but a cache can hide a verdict change: a stale base-side
collection would report a wrong base verdict, and a mis-keyed oracle
reuse would let a control pass on another case's result. So every reuse
is keyed on everything its result depends on, falls back to recomputing
whenever that cannot be established, and is reported where it happened.

### What to do

1. **Measure first.** Time each gate of `AGENTS.md` § I alone on the base,
   one after another on an otherwise idle checkout, with the differential;
   record wall clock, exit code, test files and tests per suite below.
2. **Overlap.** Each test file runs exactly once across the local gate
   set, and never by dropping a test from every gate: the local runner
   runs `test:foundation`, then `npm test`'s own config with the foundation
   files excluded, and checks from vitest's own file lists that the two
   runs together are exactly `npm test`'s files, with none in both. CI and
   the vitest configs are unchanged.
3. **Differential.** `scripts/differential.mjs` caches the base side's
   snapshot, keyed by the base commit and by everything the base side
   reads from this checkout or around it: the corpus (fixtures, cases,
   oracles, OSV snapshot), the instrument, the driver, the dependencies,
   the Node version, the directories above the scanned projects, and the
   selection. The head side is never cached. A reused base side is named
   in the report. `--no-cache` forces collection. The header documents the
   key and what invalidates it.
4. **Oracle harness.** A control variant whose project, provider and scan
   options are identical to an earlier variant's in the same run reuses
   that scan result, keyed by content hash. The case's own variant is
   always scanned. The loud-fixture check and the real-Node ground truth
   run for every variant. No reuse when the provider is not a declarative
   `syntheticProvider`, when a scan option reads or writes a path, or when
   the scan's output names its temporary directory. First measure how many
   control scans are actually repeated; if it is negligible, report the
   number and add no cache.
5. **`scripts/gates.mjs`.** Fast gates first (typecheck, lint, format,
   scorecard check, check-docs, plus build, `validate:history` and
   `validate:metadata`, which § I also lists), stopping on the first
   failure; then the test suites in sequence, with each suite's exit code
   and test counts, and `test:validation`'s failures compared case by case
   with the `knownFailure` set; then the differential. Documented in
   `docs/WORKFLOW.md` § 3 as the recommended way to run § I locally.
6. **Workflow guidance.** `docs/WORKFLOW.md` § 1.5 and § 3: between audit
   rounds only the affected suites are re-run; the full gate set runs once
   on the final HEAD before the pull request.

## Boundaries

### Do not touch

- Any analyzer code: nothing under `src/` outside `src/testing/`.
- Every vitest config's `include`, `exclude`, timeouts and thresholds;
  `.github/workflows/ci.yml`; the substance of `AGENTS.md` § I.
- The oracles: `tests/validation/cases/cases.json`, both `expected.json`
  files, the OSV snapshots; every test's assertions.
- Other worktrees: `b-6-rule-package-mismatch-reason`,
  `e-2-forwarding-write-set`, `rwf-046-require-binding-authority`, and
  any other job's scratch checkout.

### STOP conditions

- A speed-up would need a test skipped or weakened, a CI semantics
  change, or a cache whose staleness could hide a verdict change:
  `NEEDS_DECISION`.
- A cached and an uncached run disagree on anything: `STOPPED_ON_FINDING`.

## Acceptance criteria

- [ ] The per-gate durations on the base are recorded in this file.
- [ ] One `gates.mjs` run executes every test file of the gate set
      exactly once, which the runner checks from vitest's file lists; CI
      and the vitest configs are unchanged.
- [ ] `scripts/differential.mjs` reuses the base side on a second run
      with unchanged inputs, collects again when any keyed input changes
      (tests show each input class invalidating the key), never caches
      the head side, names a reused base side in the report, and offers
      `--no-cache`; its header documents the key and the invalidation.
- [ ] A reused base side and a freshly collected one are identical
      (measured on this branch).
- [ ] The oracle reuse is measured (repeated control scans, before and
      after), keyed by project content, provider spec and scan options,
      never applied to a case's own variant, and the loud-fixture check
      and ground truth still run for every variant; tests show each rule.
- [ ] `scripts/gates.mjs` exists and does item 5; `docs/WORKFLOW.md` § 3
      documents it.
- [ ] `docs/WORKFLOW.md` § 1.5 and § 3 carry item 6.
- [ ] Before and after: wall clock and structural numbers.
- [ ] No test skipped, no threshold relaxed, `AGENTS.md` § I unchanged in
      substance.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. No analyzer change, so the
differential must be zero in all three (graph, proof, verdict), and
`npm run test:validation` must show exactly the five known failures of
OPEN-DEBTS D-09, with the same actual verdicts as on the base.

## Measurements on the base

Each gate of `AGENTS.md` § I alone, one after another, in a clean
detached checkout of the base SHA (fresh `npm ci`), on an otherwise idle
machine: 4 cores, 15 GB, Linux, Node v22.11.0, 2026-10-15. Wall clock of
the exact § I command; files and tests from vitest's own summary.

| Gate | Seconds | Exit | Test files | Tests |
| --- | ---: | ---: | ---: | ---: |
| `npm run typecheck` | 49.6 | 0 | | |
| `npm run lint` | 28.1 | 0 | | |
| `npm run format` | 41.8 | 0 | | |
| `npm run build` | 16.6 | 0 | | |
| `npm run validate:history` | 0.7 | 0 | | |
| `npm run validate:metadata` | 0.6 | 0 | | |
| `node scripts/generate-scorecard.mjs --check` | 2.1 | 0 | | |
| `node scripts/check-docs.mjs` | 0.1 | 0 | | |
| `npm run test:foundation` | 154.3 | 0 | 55 | 2,382 |
| `npm test` | 334.6 | 0 | 230 | 6,254 |
| `npm run test:performance` | 31.5 | 0 | 1 | 3 |
| `npm run test:adversarial` | 15.9 | 0 | 2 | 124 |
| `npm run test:binding-grammar` | 13.3 | 0 | 2 | 296 |
| `npm run test:oracle` | 573.6 | 0 | 31 | 946 |
| `npm run test:validation` | 67.8 | 1 | 2 | 23 (6 failed) |
| `node scripts/differential.mjs` | 152.4 | 0 | | 139 cases |
| **Total** | **1,483.0** | | | |

Structural numbers on the base:

- **Test-file executions across the gate set: 323, of which 268 distinct.**
  The 55 foundation files run twice (in `test:foundation` and in
  `npm test`); every other file runs once. Test executions: 10,028, of
  which 2,382 are the foundation's second run.
- **The differential collects the base side on every run**: 76.3 s of its
  152.4 s (head 75.5 s); all three differentials zero, 139 cases.
- **`test:validation`'s six failures** are the five cases `cases.json`
  marks `knownFailure` plus `RWB-09a` (`AFFECTED` → `UNKNOWN`), which
  OPEN-DEBTS D-09 lists as the sixth known failure since task `BL-075`,
  pending the project owner's decision, and `cases.json` does not mark.
  `docs/WORKFLOW.md` § 3, `AGENTS.md` § I and `docs/progress.md` still say
  five, and the committed `tests/validation/REPORT.md` (which the suite
  regenerates on every run) still shows `RWB-09a` passing: records stale
  since `BL-075` (a finding, registered by this task).
- The oracle harness's repeated control scans: measured on this branch
  before the reuse is relied on (item 4), and reported with the outcome.

## Report

In the format of `AGENTS.md` § J. Also report, before and after: the
wall clock of each gate alone and of a whole `gates.mjs` run; test-file
executions across the gate set; base-side collections and oracle scans
performed.
