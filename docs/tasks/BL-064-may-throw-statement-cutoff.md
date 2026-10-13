# BL-064 — An evaluation not proven to complete between two competing writes of an export withdraws its attribution

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-064
- **Branch**: bl-064-may-throw-statement-cutoff
- **Base SHA**: 089ff3b3a32fbc2b9549c97f08655a9832158715
- **Commits**:
  - `docs(tasks): BL-064 task file — an evaluation not proven to complete between two competing writes of an export withdraws its attribution`
  - `test(BL-064): an evaluation between two competing writes, against real Node — RWF-094, RWF-098`
  - `fix(BL-064): an evaluation not proven to complete between competing writes withdraws the export — RWF-094, RWF-100`
  - (this commit) `docs(BL-064): records — RWF-094 fixed, RWF-098 narrowed, RWF-100 found and fixed, ADR 0009 amendment, plan § 5a, debts, backlog, progress, scorecard`
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

## Outcome

### Acceptance criteria

- [x] The five RWF-094 records are deleted and assert `UNKNOWN`, against
      real Node (`tests/oracle/rwf094-may-throw-statement.test.ts`, with
      four more shapes measured on the base).
- [x] Controls stay `NOT_AFFECTED` where real Node never calls the target,
      including a primitive first write and a proven-complete statement
      between the writes (five controls in the same file).
- [x] The amendment is recorded in ADR 0009, with a decision record.
- [x] The precision cost is measured and reported (corpus differential
      zero; `scripts/bl064-competing-write-window-corpus.mjs`: 93 of 8,659
      export bindings in `node_modules`, 9 of 441 in the validation corpus,
      none on a validation finding's path).
- [x] RWF-094's FINDINGS entry has a status update; RWF-098's too; RWF-100
      is registered; the records, backlog, progress and scorecard are
      updated.
- [x] Every gate in `AGENTS.md` § I passes, the validation baseline is
      unchanged, and the independent audit certifies (see the pull
      request; round 3 CERTIFIED).

### Deviations from this file (`AGENTS.md` § D)

- **An observability gate.** "What to do" step 2 applied the window to
  every file. Measured: 273 hermetic tests then failed, nearly all
  precision controls in files nothing can observe; real Node deletes a
  failed module from `require.cache` and `module.children`, so without a
  holder no earlier value is ever seen. The window applies only when the
  file's own census says its objects can be observed.
- **Narrowed competitors.** A whole-module write competes for a property
  only if its value can carry the name (measured: RWB-08's real `debug`
  went `AFFECTED` → `UNKNOWN` without it, though `debug.humanize` is
  `undefined` before its write).
- **A wider grammar** than listed (`try`/`catch`, `if`, `typeof`, nested
  completing callees to depth 3, `async` callees, supplied defaults,
  tagged templates), so that the real-Node oracle controls of BL-063,
  BL-065 and BL-066 keep `NOT_AFFECTED`; four of them could not be kept
  and now assert `UNKNOWN` (backlog `BL-070`).
- **Audit-driven additions** (two BLOCKED rounds, all inside this task's
  scope): RWF-100's stale-property withdrawal, a census of code that may
  make a write fail, Annex B refusals, a memoized callee proof.
- **RWF-098** is closed at the verdict level here rather than by `BL-068`,
  which is narrowed to its two single-write unit records and lowered to P2.
