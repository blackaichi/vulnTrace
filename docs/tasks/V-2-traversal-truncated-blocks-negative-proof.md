# V-2 — `traversal_truncated` blocks families B and C

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: V-2
- **Branch**: v-2-traversal-truncated-blocks-negative-proof
- **Base SHA**: b7daa950f4fa2376ab75b9717aab2f3566d07973
- **Commits**: (filled in by the last commit)
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

- [ ] A closure carrying `traversal_truncated` withdraws families B and C
      (`UNKNOWN`, `traversal_truncated`, `budget_exceeded`), over a real,
      attributed target, with `graphTruncated: false`.
- [ ] `invalidatesCallGraphNegativeProof` is gone; no test or comment
      asserts the exclusion.
- [ ] The tests that pinned the exclusion assert the new rule, and fail on
      the base.
- [ ] Real-Node cases for the PRM-23 shape, with controls.
- [ ] A mutation restoring the exclusion is caught by named tests.
- [ ] Differentials reported; validation baseline unchanged.
- [ ] Records updated.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Expected: no verdict
differential on the corpora (no corpus case truncates its closure); the
validation baseline (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`,
`VAL-003`) unchanged.

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5).
