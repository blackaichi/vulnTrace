# BL-065 — A tagged template of a proven-abrupt callee is a definitely-abrupt invocation

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-065
- **Branch**: bl-065-tagged-template-abrupt-tag
- **Base SHA**: 36d0b735af8a49fc54ec2f63431e4e6f102808fa
- **Commits**: —
- **Superseded by**: —

## Project context

Discovered in [`BL-063`](BL-063-may-execute-operand-cutoff.md) (PR #98,
merged 2026-10-12) by its independent audit, and registered there as
RWF-095 (`tests/validation/FINDINGS.md`): a live family-C false
`NOT_AFFECTED`, defect class C, P0, lane E (ADR 0009 § 1 clause 3). Two
open-soundness-defect records pin it in
`tests/oracle/rwf094-may-throw-statement.test.ts` (`rwf095.tagged-template`,
`rwf095.tagged-template-may`). The backlog row says no decision is needed.

`BL-064` (RWF-094), first in the queue, waits on a project-owner decision
(precision versus soundness); this task does not touch it, and RWF-094's
five records stay open.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **Measured.** `isDefinitelyAbruptInvocation`
  (`src/code-intelligence/module-model.ts`) recognises a
  `CallExpression` and a `NewExpression` only; a `TaggedTemplateExpression`
  falls to `return false`.
- **Measured.** `mayEndModuleEvaluation`'s BL-063 MAY check is gated on
  `ts.isCallExpression(node) || ts.isNewExpression(node)` before it asks
  `isDefinitelyAbruptCall`, so widening the predicate alone would fix the
  required position (`` bail`x`; `` through RWF-026's MUST relation) but
  not the MAY one (`` FLAG && bail`x`; ``).
- **Measured.** The cutoff's only consumer is
  `isDefinitelyReachedExportAssignment`: a new cutoff only withdraws a
  later export write's authority (toward `UNKNOWN`), never adds one.
- **Measured against real Node v22.11.0.** A tagged template evaluates
  the tag, then every substitution, then calls the tag (`[[Call]]`, with
  the member's receiver as `this` for `` h.bail`x` ``); an always-throwing
  tag (declaration, block-bodied arrow, object member) throws; an `async`
  tag returns a rejected promise and completes normally, so it must stay
  refused (RWF-016's reason); `` new C`x` `` parses as `` new (C`x`) ``,
  so the tag call happens first.

## Task

### Problem

A tagged template whose tag resolves, through
`resolveExactLocalCallable`, to a local callable that can only throw is
not a definitely-abrupt invocation, so it is never a module-evaluation
cutoff, in a required position or a MAY one. A later export write stays
authoritative though real Node stops before it.

### Why it matters

Soundness: a false `NOT_AFFECTED` with a complete family C proof
(defect class C: the export holds the earlier write's value on the loads
the template ends, and the analyzer keeps only the later write).

### What to do

1. Failing first: delete the two RWF-095 records and assert `UNKNOWN`
   for both spellings, plus oracle cases for the other tag forms the
   identity proof resolves (object member, one-hop alias, block-bodied
   arrow, a substitution, a declarator initializer, a static field, a
   wrapper callable whose body is a tagged template). Precision controls
   that must keep `NOT_AFFECTED`: an `async` tag, a never-called function
   body, a caught template, a tag that completes. Show the new cases
   failing on the base.
2. The fix, `module-model.ts` only: `isDefinitelyAbruptInvocation`
   treats a `TaggedTemplateExpression` like a call of its tag (same
   `resolveExactLocalCallable` identity proof, same `callableAlwaysThrows`),
   and the MAY check in `mayEndModuleEvaluation` visits it.
3. Records: FINDINGS RWF-095 status update (fixed), OPEN-DEBTS D-17,
   REMEDIATION-PLAN § 5a, backlog § 2, progress, scorecard.

## Boundaries

### Do not touch

- any production file other than `src/code-intelligence/module-model.ts`;
- the identity proof (`resolveInvocationTargetIdentity`,
  `resolveExactLocalCallable`) and the body proof (`callableAlwaysThrows`);
- RWF-094 (`BL-064`) and its records;
- another task's worktree.

### STOP conditions

- the fix moves any verdict toward `NOT_AFFECTED`, or moves any
  `AFFECTED`;
- a new case cannot be grounded against real Node;
- the performance smoke needs a threshold change.

## Acceptance criteria

- [ ] Both RWF-095 open-soundness-defect records are deleted and their
      cases assert `UNKNOWN`, with real Node calling the target
- [ ] The other tag forms and the precision controls are oracle cases
      with loud fixtures, both controls and real-Node ground truth
- [ ] Each new `UNKNOWN` case fails on the base commit and passes after
      the fix
- [ ] A mutation that removes the predicate's tagged-template branch, and
      one that removes it from the MAY check only, are each caught by a
      named test
- [ ] Only `module-model.ts` changed under `src/` (besides tests)
- [ ] Graph, proof and verdict differentials reported separately; no
      verdict moves toward `NOT_AFFECTED`
- [ ] All gates green; validation at exactly the five documented failures

## Gates

The full set in `AGENTS.md` section I, unrelaxed.
`npm run test:validation` at exactly RWB-03, RWB-05, RWB-09b, VAL-002,
VAL-003. `node scripts/differential.mjs` against the base. Regenerate the
scorecard.

## Report

In the format of `AGENTS.md` section J.
