# RWF-050-repro — Reproduce RWF-026's inherited MAY-execute abrupt-operand gap against real Node; then classify

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: RWF-050-repro
- **Branch**: rwf-050-repro-may-execute-operand
- **Base SHA**: 570a4b6f714f95aee8d832914ca6972458bc30b6
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Order 19 of the remediation schedule
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a), placed
immediately before lane E so that its result can still change lane E's
scope before E's task files are written (plan § 2.4 and § 5a's
placement note). It follows [`B-6`](B-6-rule-package-mismatch-reason.md)
(PR #96, merged 2026-10-11).

**RWF-050** (`tests/validation/FINDINGS.md`) is registered
UNCLASSIFIED: RWF-026's own "Remaining limitations" left a MAY-execute
conditional or logical operand (`flag && bail()`, `flag ? bail() : v`,
`z ||= bail()`) open as "a real, tracked gap, not a settled one", and
none of the three audits reproduced it end to end. OPEN-DEBTS D-17
deliberately does not count it for that reason. The plan's specification
(§ 2.4 row RWF-050): "reproduce end to end against real Node first; only
then classify (defect class, proof family, lane)". A fix it motivates
goes into lane E's task files, not this task.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **True, read**: every CommonJS export-provenance fact reads a
  last-write-wins map gated on `isDefinitelyReachedExportAssignment` →
  `isDefinitelyReachedModuleScopeStatement`, whose cutoff is the first
  top-level statement `mayEndModuleEvaluation` accepts
  (`src/code-intelligence/module-model.ts`). That walk descends into
  statement containers, so `if (FLAG) bail();` is a cutoff (a MAY
  relation, as for any `if` body), but it reaches an expression-level
  `bail()` only through RWF-026's REQUIRED positions; a short-circuit
  right operand, a conditional arm, a logical assignment's right-hand
  side, an optional-chain-guarded argument, a `for` update and a
  `do`/`while` condition are refused.
- **True, measured** (real Node v22, the H-0 oracle harness): the gap
  reaches a real verdict. See "Measured" below.
- **False, measured**: RWF-026's `REFUSED` table premise
  (`module-model.definitely-abrupt-expression-evaluation.test.ts`, "Every
  one of these completes under real Node with `bail` either never called
  or its exception handled"). For the short-circuit, conditional-arm,
  logical-assignment and optional-chain rows it holds only for the flag
  values that test happens to imply; with a truthy `FLAG`, `FLAG &&
  bail()` throws. Those rows assert that the later export KEEPS
  authority, which is the unsound attribution this task reproduces.
- **False, measured**: ADV2-086's fixture comment that its `FLAG &&
  bail()`, `FLAG ? bail() : …` and `mode ||= bail()` decoys are
  positions "none of which ends module evaluation". They end it whenever
  `VT2_CONDITION=yes`. The case's expected verdict (`UNKNOWN`) is
  unaffected.

### Measured on the base (before any record change)

A package `wrap` whose `index.js` requires `./b` first (`b.js` keeps the
exports object and reads `.run` only when called), then writes
`exports.run = dangerousOp`, then one MAY-abrupt operand, then
`exports.run = safeOp`. The entry catches the throw from
`require("wrap")` and calls `require("wrap/b").later("x")`. With the
flag truthy, real Node calls `vuln-lib`'s `parse`. The cycle precedes
every competing write, so no ADR 0009 § 1 clause 4 observation point lies
between them: only the abrupt-completion machinery (clause 3) decides.

| case | real Node calls `parse` | analyzer on base |
| --- | --- | --- |
| `if (FLAG) bail();` (contrast) | yes | `UNKNOWN` (`unresolved_target`) |
| 13 MAY spellings (`&&`, `\|\|`, `??`, both `?:` arms, `&&=`, `\|\|=`, `??=`, in a declarator, nested in a required position, an optional-chain-guarded argument, a `do`/`while` condition, a `for` update) | yes | **`NOT_AFFECTED`**, family C, `vuln-lib#parse`, `reachableSubgraphComplete: true`, 0 unknown edges |
| negative control (no abrupt line) | no | `NOT_AFFECTED` (correct) |
| positive control (direct `parse` call) | yes | `AFFECTED` (correct) |

## Task

### Problem

`mayEndModuleEvaluation` answers a MAY question ("can this statement end
module evaluation?"), but for an expression it consults RWF-026's MUST
relation (`necessarilyEvaluatesAbruptly`). A definitely-abrupt call that
only MAY be evaluated at module time is therefore not a cutoff, and a
later export write stays authoritative though real Node can stop before
it.

### Why it matters

Soundness: a false `NOT_AFFECTED` with a complete family C proof. Defect
class C (AGENTS.md § F): `exports.run` holds `dangerousOp` on the loads
where the operand fires and `safeOp` on the others, and the analyzer
collapses it to the last write.

### What to do

1. Reproduce with the real-Node oracle harness
   (`tests/oracle/rwf050-may-execute-operand.*`): a loud fixture, both
   controls, real-Node ground truth, the statement-form contrast.
2. Pin each reproduced spelling as an open-soundness-defect record
   (`src/testing/open-soundness-defect.ts`; RWF-050, D-17): `expected`
   `UNKNOWN`, the exact observed wrong result recorded separately, never
   a wrong verdict as an expectation. The contrast asserts its sound
   verdict.
3. Classify RWF-050 in FINDINGS (append, and update its register row):
   defect class, proof family, severity, lane.
4. Record the two false premises above (the RWF-026 `REFUSED` rows and
   ADV2-086's comment) as corrections in RWF-050's record.
5. Plan § 2.4 and § 5a, OPEN-DEBTS D-17, backlog: assign the lane, add a
   backlog row for the fix, regenerate the scorecard.

## Boundaries

### Do not touch

- any production file under `src/` (no analyzer change);
- RWF-026's unit tests and ADV2-086's fixture: inverting the `REFUSED`
  rows is the fix's job, in the same change that makes them pass;
- ADR 0009's text (an amendment is the project owner's decision,
  `docs/WORKFLOW.md` § 7);
- another task's worktree.

### STOP conditions

- the gap does not reproduce against real Node, or reproduces only with
  an observation point between the writes (then it is lane E clause 4's,
  not RWF-050's): record and stop;
- a reproduction needs a production change to be observable;
- any differential moves.

## Acceptance criteria

- [ ] Every reproduced spelling is an oracle case with a loud fixture,
      both controls and real-Node ground truth
- [ ] No test asserts a wrong verdict as its expected outcome; each
      reproduction is an open-soundness-defect record against RWF-050 and
      D-17
- [ ] RWF-050 is classified in FINDINGS (register row and section):
      defect class, proof family, severity, lane
- [ ] The false RWF-026 `REFUSED` premise and ADV2-086 comment are
      recorded as corrections
- [ ] A backlog row exists for the fix, with priority and dependencies
- [ ] No production file under `src/` changed
- [ ] Graph, proof and verdict differentials zero; all gates green;
      validation at exactly the five documented failures

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Tests and records
only, so the three differentials are expected to be zero.
`npm run test:validation` at exactly RWB-03, RWB-05, RWB-09b, VAL-002,
VAL-003. Regenerate the scorecard.

## Report

In the format of `AGENTS.md` section J. Item 5 names the ADR 0009 § 8
conflict (E-1's "must stay green" list includes the RWF-026 rows the fix
has to invert) as a decision for the project owner.
