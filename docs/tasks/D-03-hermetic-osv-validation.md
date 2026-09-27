# D-03 — Isolate live OSV from `npm test` and `test:validation`

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: D-03
- **Branch**: d-03-hermetic-osv-validation
- **Base SHA**: a87faa2221929bf001a595cf4ebb60b7f0e70de8
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

`docs/tasks/BACKLOG.md`'s D-03 row cites `OPEN-DEBTS.md` D-03 and "Appendix
A (owner: P1–P2, 'consider doing it early')". **Premise check (AGENTS.md §
D): the "Appendix A" citation is false.** No document in this repository
contains the string "Appendix" anywhere (`grep -rin appendix docs/*.md
tests/validation/FINDINGS.md` returns nothing). The same broken citation
also appears in the `D-12`, `BL-022` and `E-4` rows. This is not fixed by
this task — determining what "Appendix A" was meant to reference (most
likely a lost or never-committed document, the same shape of defect as
`OPEN-DEBTS.md` D-10) is its own piece of work — but it is registered
below (RWF-055) and given a backlog row, per AGENTS.md § C: "the
correction is itself a finding... Report it. Do not work around it
silently."

OPEN-DEBTS D-03 itself is measured and true: `src/vulnerabilities/osv-provider.integration.test.ts`
queries the live `https://api.osv.dev` unconditionally inside `npm test`
(confirmed: `OsvProvider`'s constructor defaults `fetchImpl` to the global
`fetch` and the test constructs `new OsvProvider()` with no override).
`tests/validation/validation.test.ts` does the same for every one of its
17 cases (`runScanCommand` is called with no `provider` option, so
`src/cli/scan.ts:336`'s `options.provider ?? new OsvProvider()` default
applies) — its own header comment says so explicitly ("querying the REAL
live OSV API (no stub)").

Query shape, measured from the code (`src/cli/scan.ts:793-812`,
`src/dependencies/package-instances.ts:667` `advisoryQueryVersions`): one
`queryPackage({ ecosystem: "npm", name, version })` call per **distinct
installed version** of every package name in the scanned project's
dependency tree, not only the name under test. Each `tests/validation/fixtures/*`
project is small (1–4 top-level `node_modules` entries), so the full set
of real queries a validation run issues is tractable to record exactly,
by running the real pipeline once with a query-recording provider wrapped
around the real `OsvProvider`, rather than guessing the key set by hand
from `cases.json` alone.

D-09's five known failures (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`,
`VAL-003`; `OPEN-DEBTS.md` § D-09) must reproduce identically against a
recorded snapshot of the same live answers — a snapshot changes *when*
OSV is queried, not *what* OSV said at recording time.

This task changes no analyzer behaviour (soundness/verdict/proof code is
untouched); it is test infrastructure and records only. No independent
audit (backlog Audit column: `no`).

## Task

### Problem

Two of the project's default-ish gates depend on the network:

1. `npm test` (in CI, on every PR) — one suite,
   `osv-provider.integration.test.ts`, queries live OSV.
2. `npm run test:validation` (local-only) — every case queries live OSV
   via `runScanCommand`'s default provider.

A provider outage or an OSV database change can turn `npm test` red (and
therefore block CI) for reasons unrelated to any code change, and can
silently move `test:validation`'s per-case verdicts between two runs of
the identical code, making its differential non-attributable to a change
under review (exactly the problem the backlog row's own Notes column
names: "a live advisory database can move a finding between two runs of
the same code").

### Why it matters

Priority: soundness-adjacent test infrastructure (AGENTS.md § E lists
"Performance never becomes proof authority"; the same discipline applies
to network flakiness never becoming proof authority for a gate). Not a
defect class A/B/C item — no verdict, proof or finding-accounting code
path is touched. It cannot itself produce a false `NOT_AFFECTED`, but a
flaky `npm test` trains reviewers to re-run failures without reading them,
which is exactly the failure mode D-03 names.

### What to do

1. Write `scripts/record-osv-snapshot.mjs` (pattern: imports from
   `../dist/...js`, like `scripts/rwf-045-corpus.mjs`). For every case in
   `tests/validation/cases/cases.json`: copy its fixture to a temp dir
   (same approach as `copyFixtureToTempDir` in `validation.test.ts`), run
   `runScanCommand` with a **recording provider** that wraps a real
   `OsvProvider` and records every `(ecosystem, name, version)` query and
   its raw response. Also record the two queries
   `osv-provider.integration.test.ts` issues directly (`lodash`, no
   version; a fabricated definitely-nonexistent package name, no
   version). Write two committed fixture files:
   - `tests/validation/osv-snapshot.json` — `Record<string,
     RawVulnerability[]>` keyed `"<ecosystem>:<name>@<version>"`, sorted.
   - `src/vulnerabilities/osv-provider.fixtures.json` — the two recorded
     response envelopes for the provider's own test.
2. Add `tests/validation/snapshot-osv-provider.ts`: a
   `VulnerabilityProvider` that loads `osv-snapshot.json` and replays it.
   A query whose key is **not** in the snapshot **throws** (never
   silently returns `[]` — an unrecorded query must never look like "OSV
   found nothing", which is the wrong failure mode for a suite whose job
   is finding soundness gaps). Give it its own unit test.
3. Wire `tests/validation/validation.test.ts` to pass `provider: new
   SnapshotOsvProvider()` to `runScanCommand`. Rewrite the file's header
   comment and the "provider intentionally omitted" inline comment, which
   currently assert live network use.
4. Rewrite `src/vulnerabilities/osv-provider.integration.test.ts` to stub
   `fetchImpl` with the two recorded response bodies from
   `osv-provider.fixtures.json`, instead of hitting the network. This
   keeps it testing the real `OsvProvider` request/response/zod-schema
   pipeline against a real historical OSV response shape — it stops
   testing "is OSV up right now", which was never this suite's job.
   Rewrite its docstring (currently "OsvProvider against the real OSV
   API").
5. Validation: run `npm run test:validation` once against unmodified
   `main` (live OSV) to capture the current PASS/FAIL table, then again
   with the snapshot wired in, and diff case by case. The five D-09
   failures must be exactly the same five, for the same reason each; no
   other case may move.
6. Update every record that currently states live-network use as present
   fact: `AGENTS.md` § I (the `npm test`/`test:validation` network
   bullet), `docs/WORKFLOW.md` § 3 (the `test:validation` live-OSV
   bullet), `README.md`'s "Deterministic vs. live" section, `docs/ARCHITECTURE.md:446`'s
   `npm test` row, `docs/OPEN-DEBTS.md` D-03 (close it, D-07-style —
   "CLOSED by D-03", history kept, not deleted). Regenerate
   `docs/SCORECARD.md` (`node scripts/generate-scorecard.mjs`) after
   updating whatever in `scripts/scorecard-sources.mjs` drives its two
   `npm test`/offline-status cells; never hand-edit the scorecard.
7. While already editing `AGENTS.md` § I's exact paragraph: it currently
   claims CI runs "on every pull request and on every push to `main`" —
   false since `a87faa2` ("Update CI workflow to remove push trigger",
   `main`) removed the push trigger. Correct this in the same edit, and
   the identical claim at `docs/REMEDIATION-PLAN.md:334` if present.
   Register as RWF-054.
8. Register RWF-055 (the "Appendix A" citation, § Project context above):
   a `tests/validation/FINDINGS.md` row/section, and a new backlog row
   (`TODO`, source "discovered in D-03") for tracking down what it should
   have pointed to. Do not attempt to fix the citation itself here — its
   target is unknown.
9. Add one new backlog row for the part of this row's own title this
   task deliberately does not do (§ Boundaries below): moving
   `test:validation` into CI. Priority P2, depends on D-03, source
   "discovered in D-03".

## Boundaries

### Do not touch

- Any verdict, proof, call-graph, export-model, or capability-flow source
  file — this task is test infrastructure and records only.
- `tests/validation/cases/cases.json`'s expected verdicts or `knownFailure`
  flags — D-09's five failures are reproduced exactly, never
  re-scoped or pinned to match a new answer.
- The adversarial suites (`tests/adversarial/`) — already hermetic
  (`fakeProvider`), out of scope.
- The locked worktree `.claude/worktrees/rwf-046-require-binding-authority`
  and its branch.

### STOP conditions

- If the live-OSV baseline run of `npm run test:validation` (step 5)
  shows failures other than the documented five, or the five for
  different reasons, stop before wiring the snapshot in and report —
  something already disagrees with OPEN-DEBTS D-09 independent of this
  task.
- If recording a query for `osv-provider.integration.test.ts`'s
  "nonexistent package" case returns anything other than an empty
  `vulns` array, stop and report — that is itself a finding about OSV's
  contract, not something to route around silently.

### Explicitly out of scope

- **Moving `npm run test:validation` into CI.** The backlog row's title
  ("...so validation is hermetic and can run in CI") reads as if
  hermeticity alone unblocks this. It does not: `validation.test.ts`
  unconditionally asserts `actual === testCase.expected` even for the
  five `knownFailure` cases (D-09), so the suite exits non-zero by design
  today. Promoting it to a required CI gate needs a separate decision —
  converting the five to an explicit "expected to fail" form (e.g.
  vitest's `test.fails`), updating `.github/workflows/ci.yml`, and
  updating AGENTS.md § I's "Runs in CI?" column and WORKFLOW.md § 3's
  local-only rationale — none of which is required to fix the actual
  defect OPEN-DEBTS D-03 names (network dependency). Left as a new
  backlog row (§ What to do, item 9) rather than guessed at here
  (AGENTS.md § D: a false or over-broad premise is not implemented
  because it was instructed).

## Acceptance criteria

- [ ] `scripts/record-osv-snapshot.mjs` exists and can regenerate both
      fixture files from live OSV.
- [ ] `tests/validation/osv-snapshot.json` and
      `src/vulnerabilities/osv-provider.fixtures.json` are committed,
      recorded from real OSV responses.
- [ ] `tests/validation/snapshot-osv-provider.ts` exists, has its own
      test, and throws (never silently empties) on an unrecorded query.
- [ ] `npm test` no longer reaches the network (verified by running it
      with network access disabled).
- [ ] `npm run test:validation` no longer reaches the network (same
      verification) and reproduces exactly the D-09 five known failures,
      case by case, for the same documented reason each.
- [ ] `AGENTS.md`, `docs/WORKFLOW.md`, `README.md`, `docs/ARCHITECTURE.md`
      and `docs/OPEN-DEBTS.md` no longer state that `npm test` or
      `npm run test:validation` reach the network as present fact;
      `docs/SCORECARD.md` is regenerated and matches.
- [ ] `AGENTS.md` § I's CI-trigger claim is corrected (RWF-054
      registered).
- [ ] RWF-055 (the "Appendix A" citation) is registered in
      `tests/validation/FINDINGS.md`, with a new backlog row.
- [ ] A new backlog row exists for CI-promotion of `test:validation`
      (§ Boundaries, "Explicitly out of scope").
- [ ] All gates in AGENTS.md § I pass (see Gates below).

## Gates

The full set in `AGENTS.md` § I, unrelaxed. No analyzer behaviour
changes, so the graph and proof differentials against `main` are zero by
construction (nothing under `src/analysis`, `src/code-intelligence` or
`src/domain` is touched) — the report states this explicitly. The verdict
differential for `npm run test:validation` is the case-by-case comparison
in step 5 above, reported as PASS/FAIL per case, old vs. new, against the
OPEN-DEBTS D-09 baseline (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`,
`VAL-003`).

## Report

In the format of `AGENTS.md` § J (`docs/WORKFLOW.md` § 5), in exactly
that order.
