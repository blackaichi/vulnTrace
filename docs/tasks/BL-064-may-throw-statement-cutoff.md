# BL-064 — An evaluation not proven to complete between two competing writes of an export withdraws its attribution

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-064
- **Branch**: bl-064-may-throw-statement-cutoff
- **Base SHA**: 089ff3b3a32fbc2b9549c97f08655a9832158715
- **Commits**: (filled in by the last commit)
- **Superseded by**: —

## Project context

Discovered in [`BL-063`](BL-063-may-execute-operand-cutoff.md) and
registered there as RWF-094 (`tests/validation/FINDINGS.md`): a live
family-C false `NOT_AFFECTED`, defect class C, P0, lane E (ADR 0009 § 1
clauses 3 and 4). Five open-soundness-defect records pin it in
`tests/oracle/rwf094-may-throw-statement.test.ts`. The backlog row says it
needs a project-owner decision first (precision versus soundness).

**The decision.** The project owner was offered (a) an ADR 0009 § 1
clause 4 amendment that makes every evaluation not proven to complete
between two competing writes a withdrawal, (b) narrow point fixes, or
(c) folding it into E-1, with (a) recommended, and gave the go without
choosing; as `BL-063` did, this task takes the recommended option, says
so in its pull request, and records it as a decision record in ADR 0009
that the project owner confirms by merging or drops.

`BL-068` (RWF-098) depends on this task: its oracle cases are the same
fixture (a call between two writes of `exports.run`), so this task may
close them outright.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **Measured.** Every CommonJS export-provenance fact is gated on
  `isDefinitelyReachedExportAssignment` (`module-model.ts`): the export's
  LAST write in source order (`commonJsPropertyExportRhs`,
  `collectModuleExportsAssignments`) is authoritative when it is a
  top-level statement before `firstModuleEvaluationCutoff`. That cutoff
  is a statement `mayEndModuleEvaluation` PROVES can end evaluation; any
  other statement is assumed to complete (RWF-016's deliberate choice).
- **Measured (RWF-094's reproduction).** Real Node calls `parse` and the
  analyzer answers `NOT_AFFECTED` (family C) for `maybe(FLAG);`,
  `JSON.parse(...)`, `new C()` running a throwing instance field, and a
  getter read, each between `exports.run = dangerousOp` and
  `exports.run = safeOp`, with `wrap/b` holding the exports object.
- **To verify against real Node in this task.** (1) An uncaught
  module-scope throw leaves the exports object holding whatever was last
  written before it, visible to any module that already holds the object
  (a cycle, `module.parent` of a child, an escape). (2) An earlier write
  whose value is a primitive (`exports.run = void 0`, TypeScript's emit)
  publishes nothing callable, so an observer of it reaches nothing.
- **Assumed, and to be measured (the precision cost).** Real modules
  rarely write the same export twice with an unproven statement between,
  except TypeScript's `exports.x = void 0;` preamble.

## Task

### Problem

A module-time statement that may throw, through anything no proof
reaches, between two writes of an export, is assumed to complete. The
later write stays authoritative, though a module already holding the
exports object observes the earlier value when the statement throws.

### Why it matters

Soundness: a live false `NOT_AFFECTED` (family C). Defect class C: the
export can hold two values (the earlier write's, observed after an abrupt
completion, and the last write's) and the analyzer collapses them to one.

### What to do

1. Verify the premises above against real Node.
2. The rule (ADR 0009 § 1 clause 4, amended): for export `x` (a property
   name, or the whole-module value), take its **competing writes** at
   module scope: every write of `x` the file spells (`exports.x`,
   `module.exports.x`, a literal key of `module.exports = {...}`) and
   every whole-module replacement, excluding a write whose value is
   provably a primitive. The last write keeps its authority only when
   every evaluation between the first competing write and the last
   write's completion is **proven to complete normally**, by a closed
   grammar (declarations, literals, function and class values, reads of
   initialized module-scope bindings, export writes of such values, calls
   of an exact local callable whose body provably completes). Anything
   else withdraws `x`'s attribution (`UNKNOWN`), and a write inside a
   function body opens the window at the start of the file.
3. Tests first: the five RWF-094 records flip; new real-Node oracle cases
   for the boundaries (a primitive first write, a proven-complete call, a
   `require` between the writes); unit tests for the grammar.
4. Measure the precision cost: the differential over the corpora, and a
   per-task script over every CommonJS file under `node_modules`.
5. Records: FINDINGS RWF-094 status update, ADR 0009 amendment and
   decision record, OPEN-DEBTS, plan § 5a, backlog, progress, scorecard.

## Boundaries

### Do not touch

- E-1's write set (`ExportWriteKind`, aliases, `Object.defineProperty`,
  deferred writes running after load, stale export objects, observation
  by a re-entrant `require` between writes): out of scope, and named as
  such where this task's rule meets them.
- The callee-summary bounds of RWF-098 beyond what this rule closes.
- Other tasks' worktrees.

### STOP conditions

- The measured precision cost withdraws attribution from a large share of
  real multi-write exports: `NEEDS_DECISION`.
- A premise is false in a way that changes the rule.
- The audit blocks for a reason outside the task.

## Acceptance criteria

- [ ] The five RWF-094 records are deleted and assert `UNKNOWN`, against
      real Node.
- [ ] Controls stay `NOT_AFFECTED` where real Node never calls the
      target, including a primitive first write and a proven-complete
      statement between the writes.
- [ ] The amendment is recorded in ADR 0009, with a decision record.
- [ ] The precision cost is measured and reported (corpus differential
      and the `node_modules` sweep).
- [ ] RWF-094's FINDINGS entry has a status update; the records, backlog,
      progress and scorecard are updated.
- [ ] Every gate in `AGENTS.md` § I passes, the validation baseline is
      unchanged, and the independent audit certifies.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Validation baseline:
exactly `RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`.

## Report

In the format of `AGENTS.md` section J.
