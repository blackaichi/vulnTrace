# gate-enforcement — RWF-051, widened: gate enforcement

## Status

- **Status**: in-progress
- **Branch**: `gate-enforcement`
- **Base SHA**: `3cfc7a9` (main after "docs(tasks): record the owner's A-0
  decision in the A-0 task file")
- **Commits**: <!-- filled in when done -->
- **Superseded by**:

## Project context

VulnTrace's soundness rests on structural guarantees enforced by test
suites: the Foundation invariants, the adversarial suites, the
binding-form grammar sweep (whose type-level guard makes a wrong EXACT
disagreement entry unrepresentable), the real-Node oracle suite, and
open-soundness-defect records pinned in those suites. Standing rules are
in `AGENTS.md`; section I lists the gates.

Two premises from the task prompt, both verified:

- **RWF-051** (`tests/validation/FINDINGS.md`): `npm run typecheck` only
  ever type-checked `src/` plus (since task A-0) `tests/oracle/`.
  **Measured true** at the base SHA: `tsc --noEmit -p <scratch config over
  tests/**/*.ts, excluding the three fixture dirs>` reveals exactly one
  latent error, at exactly `tests/binding-grammar/harness.ts:328`
  (`TS2339: Property 'target' does not exist on type 'CallEdgeResolution'`
  inside the `.find()` callback in `observe()`), matching RWF-051's own
  prose exactly.
- **CI runs only `npm test`**: **measured false as stated, true in
  substance.** `.github/workflows/ci.yml` at the base SHA runs, in order:
  `npm run build`, `npm run typecheck`, `npm run lint`,
  `npx prettier --check .`, `npm run test:foundation`, `npm test`,
  `npm run test:performance`, `npm run test:adversarial`,
  `npm run validate:history` (which itself also runs
  `validate-commit-metadata.mjs`) — on `pull_request` only, no `push`
  trigger. So it is more than "only `npm test`", but it is missing
  `test:binding-grammar`, `test:oracle`, `validate:metadata` as its own
  named step, the scorecard `--check` and `check-docs.mjs`, and it never
  runs on push to `main`.

A third premise, discovered while establishing whether `test:oracle` is
hermetic (needed to decide whether it belongs in CI): `docs/SCORECARD.md`
§ 9's generated "Network?" column, produced by `classifyScript` in
`scripts/scorecard-sources.mjs`, claimed `npm run test:oracle` reaches the
live OSV API. **Measured false**: run alone, `npm run test:oracle` is 68
tests across 6 files, real local `node` subprocesses only (the H-0
builtin probe and ground-truth commands), no network, ~55s, and passes
identically on repeat runs. The classifier's config-name allowlist
(`vitest.foundation.config.ts` / `.adversarial.` / `.binding-grammar.`)
was never extended to `vitest.oracle.config.ts` when task A-0 added it, so
it fell through to the default "assume network" branch. Corrected per
AGENTS.md § C (see WHAT CHANGED).

## Task

### Problem

See the pasted task prompt this file was committed from: (a) the
type-level half of the binding-grammar `@ts-expect-error` guard has never
run under any gate; (b) most of the project's own gates run only when an
agent runs them locally, never in CI.

### Why it matters

Tooling, not soundness directly — but the guards these gates protect
*are* soundness-load-bearing (AGENTS.md § F, § G), so a gate that silently
does not run is a false sense of protection. Lane A (ADR 0008) is about to
add `tests/binding-grammar/` rows that rely on the type-level guard, so it
must be enforced by a gate first (REMEDIATION-PLAN § 5a, order 1b).

### What to do

1. Type-check every `.ts` file under `tests/` (fixture packages under
   `tests/adversarial/{v1,v2}/fixtures/` and `tests/validation/fixtures/`
   excluded — they are analyzer INPUT DATA, real/synthetic npm packages
   the tool scans, not test code, and are already excluded the same way
   from lint and prettier). Fix every revealed error, classify each as a
   test defect or cosmetic.
2. Prove the binding-grammar type guard bites: widen
   `KnownDisagreement.observed`'s type to admit an `{kind: "exact"}`
   variant, show `npm run typecheck` now fails on the `@ts-expect-error`
   pin in `guard.test.ts`, revert.
3. Make CI run every hermetic gate in `AGENTS.md` section I, on pull
   requests and on push to `main`. Leave `test:validation` local-only
   (live OSV, OPEN-DEBTS D-03).
4. Close RWF-051; update `AGENTS.md` section I (CI vs. local-only) and
   section H (one-commit-per-micro-task rule, permanent); update
   `docs/REMEDIATION-PLAN.md`'s task 1b line; regenerate the scorecard.

## Boundaries

### Do not touch

- Any non-test file under `src/` (no analyzer change).
- ADRs, `docs/audits/`, `README.md`.
- `scripts/` except a script whose OWN correctness gates rely on
  (reported as a deviation): `scripts/scorecard-sources.mjs`'s
  `classifyScript` had a verified-false network claim about
  `test:oracle`, corrected because this task's own step 3 depends on
  knowing which gates are hermetic.
- `tests/validation/FINDINGS.md` except RWF-051's appended text.
- `docs/REMEDIATION-PLAN.md` except the task-1b line.
- Any worktree but this task's own.
- Do not add `test:validation` to CI. Do not weaken any test or
  threshold.

### STOP conditions

- A revealed type error can only be fixed by changing what a test
  asserts in a way that weakens it. (Did not occur: the one revealed
  error was a TypeScript closure-narrowing limitation, fixed by hoisting
  an already-narrowed local out of the callback, with no behavior
  change.)

## Acceptance criteria

- [x] Task file committed first; will be marked done in the last commit
- [x] CI's current gates reported exactly; "only `npm test`" corrected
- [x] Every TypeScript file under `tests/` (excluding fixture input data)
      is type-checked by the gate
- [x] The one revealed type error fixed; classified cosmetic (TS closure
      narrowing limitation, no runtime behavior change); no test weakened
- [x] Binding-grammar type guard proven to fail typecheck when widened,
      then reverted
- [x] CI runs every hermetic gate in section I on pull requests and on
      push to main; `test:validation` recorded as local-only with reason
- [x] Workflow validated locally; job names to watch listed in the report
- [x] RWF-051 closed by appended text; AGENTS.md section I marks CI vs.
      local-only; plan line updated
- [x] No analyzer file changed; differentials zero; gates green;
      validation at the five known failures
- [ ] Pushed; no PR; no merge; clean commit metadata

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Analyzer differentials
zero (no analyzer file changed). Validation: exactly the five documented
failures (VAL-002, VAL-003, RWB-03, RWB-05, RWB-09b; OPEN-DEBTS D-09),
same verdicts.

## Report

In the format of `AGENTS.md` section J, plus: CI before vs. after
(gate-by-gate table); the type-error classification; the guard proof
(both `tsc` runs); expected CI wall time; the job names the owner should
see pass; the `test:oracle` network-classification correction.
