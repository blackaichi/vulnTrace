# BL-118 — Run CI's gates as parallel jobs; correct `vitest.foundation.config.ts`'s stale header

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-118
- **Branch**: `bl-118-ci-parallel-jobs`
- **Base SHA**: `8ca3207b6566dd0ffdaa38a225da36c40c5fe746` (BL-117's merge, PR #123)
- **Commits**: filled in by the last commit
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

- [ ] `.github/workflows/ci.yml` runs the fast gates once, in one job, and
      each test suite as its own job on Node 20 and on Node 26, all in
      parallel.
- [ ] Every gate of AGENTS.md § I marked "runs in CI" still runs on every
      pull request, with the command § I names. `test:foundation` still
      runs on its own, and `npm test` still contains its files.
- [ ] The oracle cache stays off in every CI job (`VT_ORACLE_NODE_CACHE`).
- [ ] This branch's own pull request runs the new workflow, and every job
      passes. The wall time is measured against the base's last CI run.
- [ ] `vitest.foundation.config.ts`'s header states why
      `tests/validation/` is absent, matching OPEN-DEBTS D-03 and D-09, and
      states that CI runs both `test:foundation` and `npm test`.
- [ ] `node scripts/gates.mjs` passes in full, with the validation
      baseline unchanged.

## Gates and report

CI-only and documentation change: no analyzer change, so the graph, proof
and verdict differentials are expected to be zero. The report adds the
CI wall time before and after, measured on the CI runs themselves.

## Account

Filled in while working.
