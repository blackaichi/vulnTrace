# V-2 — `traversal_truncated` blocks families B and C

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: V-2
- **Branch**: v-2-traversal-truncated-blocks-negative-proof
- **Base SHA**: b7daa950f4fa2376ab75b9717aab2f3566d07973
- **Commits**:
  - `3eaba4e` docs(tasks): V-2 task file — traversal_truncated blocks families B and C
  - `9660c6b` test(V-2): a truncated closure withdraws families B and C — unit and real-Node cases
  - `17b1f9a` fix(V-2): traversal_truncated blocks families B and C (PRM-23)
  - (this commit) docs(V-2): records — PRM-23 fixed, plan § 5a, debts, backlog, progress, scorecard
- **Superseded by**: —

## Project context

Second task of lane V of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 9),
after [`V-1`](V-1-site-b-closure-corroboration.md) (PR #86, merged
2026-10-08). V-3 and V-4 depend on it.

The specification is
[ADR 0011](../adr/0011-negative-proof-corroboration.md): invariant V
(§ 1) and its predicate 1 — `closure !== undefined && closure.complete &&
closure.incompleteness.length === 0` for every family B and C proof — the
fail-closed row "closure truncated → `budget_exceeded`,
`traversal_truncated`" (§ 3), the reopened certified decision VT-307e
"`traversal_truncated` DOES NOT BLOCK either" (§ 6), and § 8's V-2 row.
What V-1 left for V-2 is in REMEDIATION-PLAN § 5a, "V-1 additions".

Finding closed: PRM-23 (`tests/validation/FINDINGS.md`; reproduction
`closure-truncation-hides-hook`, `docs/audits/2026-09-premise-sweep-round-1.md`
§ 4).

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **True** (code read): `invalidatesCallGraphNegativeProof`
  (`src/analysis/module-load-closure.ts`) returns `false` for
  `traversal_truncated` only, so `callGraphNegativeProofBlockers` drops it
  and `buildFinding`'s VT-307e guard lets family C stand over a closure
  truncated on its own walk. Family B is already blocked: its
  corroboration in `checkReachability` requires `closure.complete`.
- **True, measured** (unit level, `buildFinding`): a real, attributed,
  unreached target under `closure(["traversal_truncated"])` with
  `graphTruncated: false` is `NOT_AFFECTED`, family C, on the base
  (`verdict.negative-proof.test.ts` case 10b, rewritten; the F4 family-C
  row `closure_incomplete_traversal_truncated`).
- **False, no longer reproducible end to end** (measured, real Node
  v22.11.0, the oracle harness, 4 cases in
  `tests/oracle/v2-traversal-truncated.cases.ts`): the round-1
  reproduction is `UNKNOWN` on the base, not `NOT_AFFECTED`. Two later
  changes withdraw family C before the exclusion matters:
  - lane A's call graph sees the hook itself: the round-1 hook calls the
    original `Module.prototype.require` (`module_internal_load`), and a
    `require.cache` write is a `protocol_value` (an assignment into a
    builtin value is an escape, task A-3a);
  - V-1's family-C closure corroboration (ADR 0011, Amendment V-1):
    the four re-export-only modules are loaded and never evaluated
    (`loaded_module_not_evaluated`).
  In production the second is general, by a counting argument V-1
  recorded: the closure truncates only after loading exactly `maxFiles`
  files, so when every loaded module is evaluated the graph holds at
  least `maxFiles` files and `scan.ts` marks it truncated
  (`hitFileLimit`). The argument depends on `scan.ts` passing one limit
  to both walks; it is not predicate 1. V-2 makes predicate 1 hold by
  itself, so the guard no longer rests on that coincidence.
- **False** (ADR 0011 § 6): the "(verified directly)" claim that a
  truncated closure is accompanied by a truncated graph. The closure
  walks re-export-only files the graph does not.
- **To check while implementing**: § 8's list of existing tests that
  change, against today's test files; the `scan-security.test.ts` VT-202
  test, said to change reason.

## Task

### Problem

`traversal_truncated` is the one closure incompleteness reason that does
not withdraw a call-graph-derived proof. A closure truncated on its own
walk never examined the files past its budget, and a non-call loader
mutation (`Module._extensions`, `require.cache`) is visible only to the
closure's whole-file scan.

### Why it matters

Soundness: a false `NOT_AFFECTED` path (family C) whose only remaining
guard is a cross-function counting argument. Defect class C
(AGENTS.md § F): a closure that is a strict subset of the modules that
run is treated as the whole.

### What to do

1. Tests first, failing on the base: case 10b over a real target, case 16
   and matrix item 7 with `traversal_truncated`, the F2 blocker helper,
   the F4 family-C row (now a mutation, not a control); the real-Node
   cases, which pin the reason (`traversal_truncated`) where the verdict
   was already `UNKNOWN`.
2. Delete the exclusion: `callGraphNegativeProofBlockers` reports every
   incompleteness reason; delete `invalidatesCallGraphNegativeProof`.
   Correct every comment whose premise this makes false.
3. Records: FINDINGS (PRM-23 fixed, with the measured base state), ADR
   0011 § 8 note if needed, REMEDIATION-PLAN § 5a "V-2 additions",
   OPEN-DEBTS, backlog, progress, scorecard.

## Boundaries

### Do not touch

- Family A's gate and the closure builder's truncation itself.
- V-3's and V-4's scope (root identity, the census, branded types).

### STOP conditions

- A verdict that moves toward `NOT_AFFECTED` anywhere.
- A corpus case whose verdict moves for a reason other than this guard.

## Acceptance criteria

- [x] A closure carrying `traversal_truncated` withdraws families B and C
      (`UNKNOWN`, `traversal_truncated`, `budget_exceeded`), over a real,
      attributed target, with `graphTruncated: false`.
- [x] `invalidatesCallGraphNegativeProof` is gone; no test or comment
      asserts the exclusion.
- [x] The tests that pinned the exclusion assert the new rule, and fail on
      the base.
- [x] Real-Node cases for the PRM-23 shape, with controls.
- [x] A mutation restoring the exclusion is caught by named tests.
- [x] Differentials reported; validation baseline unchanged.
- [x] Records updated.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Expected: no verdict
differential on the corpora (no corpus case truncates its closure); the
validation baseline (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`,
`VAL-003`) unchanged.

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5).

## Corrections (task V-2, 2026-10-08)

Measured while implementing, and from the independent audit
(`CERTIFIED`, no blocking finding):

1. **Real-Node cases: 5, not 4.** The premises above say "4 cases"; the
   final file holds five: a `require.cache` hook truncated and untruncated,
   an inert hook truncated, and the round-1 reproduction's own
   `Module.prototype.require` hook truncated and untruncated (added on the
   audit's finding 7). A fourth case drafted first (`maxFiles: 2`, no
   barrel) was dropped: it stopped before `vuln-lib` entered the graph, so
   it measured Site B's `unresolved_target`, not this guard.
2. **Matrix item 7 is not failing-first.** Its new `traversal_truncated`
   entry (family B) passes on the base: family B's own `complete` check
   answers first. It is a regression lock. The failing-first tests are
   case 10b, case 16, the F2 blocker helper and the F4 family-C row.
3. **Family B's reason.** A withdrawn family B reports
   `package_instance_absence_uncorroborated` (its `complete` check), never
   `traversal_truncated`; the first acceptance criterion's reason holds for
   family C.
4. **ADR 0011 § 8's VT-202 note is false.** The `scan-security.test.ts`
   VT-202 truncation test does not change reason: the `graphTruncated`
   branch answers before the closure guard. Recorded in REMEDIATION-PLAN
   § 5a, "V-2 additions".
5. **`invalidatesCallGraphNegativeProof` deleted, not kept returning
   `true`.** ADR 0011 § 5 describes the measured prototype that way; the
   behaviour is the same.
6. **Predicate 1's `complete` half** is not read by the guard (audit
   finding 2): a closure with `complete: false` and an empty list would
   pass. No production closure has that shape; bound to V-4.
