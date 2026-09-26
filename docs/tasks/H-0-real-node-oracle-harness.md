# H-0 — the shared real-Node oracle harness

## Status

- **Status**: in-progress
- **Branch**: `h0-real-node-oracle-harness`
- **Base SHA**: `ede37afcf2d2ebeff78ff5cd7d92d9fa131081f4` (main after
  `docs(tasks): mark remediation-reconciliation done`)
- **Commits**: <!-- filled in when done -->
- **Superseded by**:

## Project context

VulnTrace is a proof-producing vulnerability reachability analyzer
(AGENTS.md § A). Three read-only investigations
(`docs/audits/2026-09-premise-sweep-round-1.md`,
`docs/audits/2026-09-premise-sweep-round-2.md`,
`docs/audits/2026-09-independent-audit.md`) reproduced ~67 soundness
defects, registered in `tests/validation/FINDINGS.md`. Each reproduction
used one method, done by hand, ad hoc, per audit: build a fixture project,
run the real scan pipeline (`runScanCommand`) with a synthetic OSV
provider, run real Node on the same fixture for ground truth, assert the
loud-fixture property before scanning, and run a positive control (direct
call → `AFFECTED`) and a negative control (no call → `NOT_AFFECTED`).

`docs/REMEDIATION-PLAN.md` § 5a schedules the fixes for these defects as
one sequential list. H-0 is order 1 in that list — "every later task's
failing-first tests, precision measurements … and grammar sweeps … need
real-Node ground truth; building the shared harness once, first, avoids
each lane reimplementing its own ad hoc version, which is what § 9's
method describes happening already."

Premises verified before building (AGENTS.md § D):

- `main` == `origin/main` at the base SHA above; tree clean;
  `docs/audits/`, `docs/adr/0008–0011` and `docs/REMEDIATION-PLAN.md`'s
  § 5a schedule are all present on `main` — confirmed.
- An existing "module-load-closure differential oracle (VT-307)" and
  `src/testing/open-soundness-defect.ts` were named as machinery to
  reuse. VT-307 (`ModuleLoadClosure`, `src/analysis/module-load-closure.ts`,
  exercised in production wiring by
  `src/cli/scan.module-load-closure.test.ts`) answers a different
  question — module-load reachability, not real-Node ground truth — and
  shares no code with this harness; it is not reused, only left
  untouched, per the task's own STOP condition (see Boundaries).
  `open-soundness-defect.ts`'s `VERDICT_DOMAIN`/`VerdictObservation` IS
  reused directly for the open-defect integration seam (step 2).
- `src/testing/fixtures.ts` (a path helper for the committed
  `fixtures/` directory, unrelated to per-case temp projects) and
  `tests/binding-grammar/harness.ts` (a call-graph-level, not scan-level,
  fixture builder) exist but solve a different problem each; neither is
  extended here.

## Task

### Problem

Every soundness-fix task in `docs/REMEDIATION-PLAN.md` needs to write a
failing-first, real-Node-backed reproduction (AGENTS.md § G). Today that
means re-deriving, per task, the same five things every audit report
above already built independently: a fixture-project writer, a
loud-fixture assertion, a real-scan runner, a real-Node ground-truth
runner, and the positive/negative control convention — with no shared
place to put a case, and no shared enforcement that a case actually
carries all five.

### Why it matters

Test infrastructure, not a soundness fix itself — but it is what makes
every later fix's evidence trustworthy. AGENTS.md § G: "Loud fixtures" and
"Never pin a wrong verdict" are both stated as project-wide rules already;
this task is what turns them from a convention every audit had to
remember by hand into something the type system and the runner enforce.

### What to do

1. Build `src/testing/oracle/` (test support, excluded from the build the
   same way `open-soundness-defect.ts` already is): a `ProjectSpec` +
   `withTempProject` for hermetic per-case temp projects; `assertLoudFixture`
   (real-Node, throws `LoudFixtureViolation`); `runGroundTruth` (real-Node,
   the `hit()`/`CALLED <name>` convention already used by every audit);
   `syntheticProvider` / `injectedOsvProvider` (the latter with no default
   `fetchImpl`, so it cannot reach the network); `compileTypeScript` (the
   repository's own `typescript`); `runOracleScan` (wraps the real
   `runScanCommand`) and `toVerdictObservation` (bridges a scan result into
   `open-soundness-defect.ts`'s existing `VerdictObservation` domain, with
   no new record created); `runOracleCase` (ties a case, its controls and
   its ground truth together, throwing on any violated guarantee); and
   `probeBuiltinInvocation` (the builtin-argument-kind probe for the
   non-invoking-builtin allowlist decision).
2. Prove it with a self-test suite (`tests/oracle/`, its own
   `vitest.oracle.config.ts` and `npm run test:oracle`): the happy path,
   each functional violation (missing loud export, wrong negative
   control, a declared expectation that contradicts ground truth), the
   mutation tests, the builtin probe's own self-test, the open-defect
   bridge, and one demonstration per project shape step 1 lists.
3. Two structural (compile-time) guards live under `src/testing/oracle/`
   itself, not `tests/oracle/` — `tsconfig.json`'s `include` is `["src"]`,
   confirmed empirically (`tsc --noEmit --listFiles` lists zero files
   under `tests/`), so a `@ts-expect-error` guard placed in `tests/oracle/`
   would compile-check nothing.
4. Add `test:oracle` to `AGENTS.md` § I's gate table (the only other line
   this task changes in `AGENTS.md`), and update only H-0's own status
   line in `docs/REMEDIATION-PLAN.md`.

No analyzer file changes. No failing reproduction from `docs/audits/` is
ported (that is every later task's job).

## Boundaries

### Do not touch

Any non-test file under `src/` outside `src/testing/`; `tests/validation/FINDINGS.md`;
`docs/OPEN-DEBTS.md`; `README.md`; `docs/audits/`; `docs/adr/`; `scripts/`;
any worktree but this task's own.

### STOP conditions

If the existing VT-307 module-load-closure oracle and this harness cannot
be reconciled without changing the existing oracle's behaviour: STOP with
`NEEDS_DECISION`. (Not triggered: the two never overlap — see Project
context.)

## Acceptance criteria

- [ ] Task file committed first and marked done at the end
- [ ] Existing oracle machinery discovered and reused where possible
- [ ] Harness supports every shape listed in step 1
- [ ] Loud fixture, controls and ground truth enforced by the type system
      or the harness, not by convention
- [ ] Hermetic: no network, per-case temp dirs, parallel-safe
- [ ] Open-defect helper provided; no record created
- [ ] Builtin probe provided, with its self-test covering the listed cases
- [ ] Self-test covers all cases in step 4, including the mutations
- [ ] Dedicated suite and npm script; `AGENTS.md` gate list updated (one line)
- [ ] No failing reproduction ported; no analyzer file changed
- [ ] Differentials zero; gates green; validation at the five known failures
- [ ] Pushed; no PR; no merge; clean commit metadata

## Gates

The full set in `AGENTS.md` § I, unrelaxed, plus the new `npm run
test:oracle`. Expected: analyzer differentials zero (no analyzer file
changed); `npm run test:validation` at exactly the five documented known
failures (OPEN-DEBTS D-09), same verdicts as baseline.

## Report

In the format of `AGENTS.md` § J, in exactly that order.
