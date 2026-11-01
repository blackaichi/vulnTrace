# BL-118 — Run CI's gates as parallel jobs; correct `vitest.foundation.config.ts`'s stale header

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-118
- **Branch**: `bl-118-ci-parallel-jobs`
- **Base SHA**: `8ca3207b6566dd0ffdaa38a225da36c40c5fe746` (BL-117's merge, PR #123)
- **Commits**:
  - `docs(tasks): BL-118 task file — CI gates as parallel jobs`
  - `ci(BL-118): run the gates as parallel jobs`
  - `docs(BL-118): correct the foundation config's stale header`
  - (this commit) `docs(BL-118): records — account, backlog, progress`
- **Superseded by**: —

## Specification

The row `BL-118` of [`BACKLOG.md`](BACKLOG.md) § 1, decided by the project
owner on 2026-10-27 (task `BL-116`). It says: CI takes 7 to 11 minutes as
one sequential job per Node release. The fast gates should run once, and
the test suites should run as parallel jobs on Node 20 and 26. Every gate
of AGENTS.md § I keeps its command and runs on every pull request. The
foundation subset still runs on its own as well. The row also asks for a
correction to `vitest.foundation.config.ts`'s header, which says
`tests/validation/` needs the network and implies that CI runs only
`npm test`.

## Premises to verify (AGENTS.md § D)

1. CI takes 7 to 11 minutes as one sequential job per Node release.
2. No test suite needs the build output (`dist/`), so a suite's job can
   skip `npm run build`.
3. Nothing in the repository reads `ci.yml`'s structure (a test, the
   scorecard or `check-docs`), and no branch protection requires the
   current job names as status checks.
4. The fast gates (build, typecheck, lint, format, `validate:history`,
   `validate:metadata`, the scorecard check, `check-docs`) do not depend
   on the Node release, so running them once loses no coverage.
5. The header's two claims are false: `tests/validation/` needs the
   network, and CI runs only `npm test`.

## Boundaries

Do not touch: any gate's command, any test, threshold or vitest
configuration other than the header comment, the oracle cache
(BL-117), `scripts/gates.mjs` (the local runner), which Node releases CI
covers (BL-115, a decision). STOP conditions: a suite that fails only
when it runs on its own runner (that would be a hidden dependency between
gates, and a finding); a gate that cannot keep its command.

## Acceptance criteria

- [x] `.github/workflows/ci.yml` runs the fast gates once, in one job, and
      each test suite as its own job on Node 20 and on Node 26, all in
      parallel.
- [x] Every gate of AGENTS.md § I marked "runs in CI" still runs on every
      pull request, with the command § I names. `test:foundation` still
      runs on its own, and `npm test` still contains its files.
- [x] The oracle cache stays off in every CI job (`VT_ORACLE_NODE_CACHE`).
- [x] This branch's own pull request runs the new workflow, and every job
      passes. The wall time is measured against the base's last CI run.
- [x] `vitest.foundation.config.ts`'s header states why
      `tests/validation/` is absent, matching OPEN-DEBTS D-03 and D-09, and
      states that CI runs both `test:foundation` and `npm test`.
- [x] `node scripts/gates.mjs` passes in full, with the validation
      baseline unchanged.

## Gates and report

CI-only and documentation change: no analyzer change, so the graph, proof
and verdict differentials are expected to be zero. The report adds the
CI wall time before and after, measured on the CI runs themselves.

## Account

### Premises, as verified

1. **True.** BL-117's CI run (run `40608917788`, PR #123's head) took
   10 min 01 s wall: the Node 20 job 9 min 57 s and the Node 26 job
   6 min 48 s, in sequence within each job. The oracle step was the
   longest: 5 min 06 s on Node 20, 3 min 46 s on Node 26.
2. **True.** No test reads the repository's own `dist/`. The `dist/`
   paths under `src/` and `tests/` are inside fixture projects that a
   test writes and compiles itself (`tests/oracle/*.cases.ts`,
   `tests/oracle/shapes.test.ts`), or are about `.gitignore`
   (`fixtures-are-committed.test.ts`). The CI run below confirms it: every
   suite job passed without `npm run build`.
3. **True.** No test, script or document parses `ci.yml`. The scorecard
   and `check-docs` do not read it. `main`'s branch protection requires no
   status checks, so renaming the jobs breaks nothing. The repository is
   public, so the extra runner minutes are not billed.
4. **True, by reading the scripts.** `generate-scorecard.mjs`,
   `scorecard-sources.mjs`, `check-docs.mjs`, `validate-history.mjs` and
   `validate-commit-metadata.mjs` read files and run `git`. None of them
   reads `process.version` or spawns `node`. `tsc`, `eslint` and
   `prettier` do not vary by Node release. The fast gates run on Node 20,
   the oldest release the matrix covers.
5. **True.** The header said `tests/validation/` "needs the network and
   the real OSV database" (false since D-03), and that "CI runs
   `npm test`, which contains all of this" (CI also ran
   `test:foundation`, as its own step). Its gate list ("`npm test` plus
   adversarial, performance, build, typecheck, lint, prettier and
   `validate:history`") was also stale: it lacked the grammar sweep, the
   oracle suite, `validate:metadata`, the scorecard check and
   `check-docs`. It now points to AGENTS.md § I.

### The workflow

- One job, `fast-gates`, on Node 20: build, typecheck, lint, format,
  `validate:history`, `validate:metadata`, the scorecard check,
  `check-docs`, in that order.
- One matrix job, `suite`: six suites (`test:foundation`, `npm test`,
  `test:performance`, `test:adversarial`, `test:binding-grammar`,
  `test:oracle`) times Node 20 and 26, twelve jobs, `fail-fast: false`.
  Each job runs `npm ci` and then its suite's command.
- No job depends on another. `VT_ORACLE_NODE_CACHE: "off"` is set
  workflow-wide. Every job checks out with `fetch-depth: 0`, as before:
  the metadata gate needs the F6 base commit, and
  `commit-metadata-policy.test.ts` and `fixtures-are-committed.test.ts`
  shell out to `git`.
- The performance guards now run on a runner of their own, with no other
  suite before them on it.

### Measurements

Run `41321302275`, dispatched on this branch at `2bc6e49`
(`workflow_dispatch`, the branch's own `ci.yml`), all 13 jobs passed:

| | Base (run `40608917788`) | This branch (run `41321302275`) |
| --- | --- | --- |
| Wall time | 10 min 01 s | 5 min 37 s |
| Jobs | 2 | 13 |
| Runner time, summed | 16 min 45 s | 25 min 52 s |
| Longest job | Node 20, 9 min 57 s | oracle on Node 26, 5 min 34 s |

The oracle suite is now the critical path on its own. Its job time moves
between runs (Node 26: 3 min 46 s inside the base job, 5 min 34 s on its
own runner here; Node 20: 5 min 06 s and 4 min 10 s), so the wall time
is about one oracle run plus a minute of setup. The extra runner time is
each job's checkout, Node setup and `npm ci`.

Tests run per suite, in that run, identical on Node 20 and 26:
`test:foundation` 56 files, 2,445 tests; `npm test` 242 files, 6,817
tests; `test:performance` 1 file, 3 tests; `test:adversarial` 2 files,
124 tests; `test:binding-grammar` 2 files, 296 tests; `test:oracle` 47
files, 1,435 tests (BL-117's own count). The base run's logs are no
longer downloadable, so the other suites' counts are compared with this
branch's local gate run instead (the pull request's validation section).

### Deviations and inclusions

- The format step runs `npm run format`, the command AGENTS.md § I names,
  instead of `npx prettier --check .`. Both run `prettier --check .`.
- Included, as required to correct the header: the header now points to
  `LIVE_SIGNALS` (`src/testing/foundation-invariants.ts`) for why the
  validation suite is absent, and that entry still said "five cases are
  deliberately kept failing (OPEN-DEBTS D-09)". D-09 has listed six since
  BL-075. The entry now names D-09's cases without a count, as BL-089 did
  for the other three records. RWF-119 has an appended note.
- The header keeps its citation "F6 § 25". That is a section of the F6
  task's specification, which is not in the repository, so it could not
  be checked.

### Audit

Not required (backlog: `Audit: no`; CI configuration and documentation
only).
