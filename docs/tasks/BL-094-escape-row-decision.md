# BL-094 — Decide: the escape row's "unless proven" rule, structural change or further point fixes

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-094
- **Branch**: `bl-094-escape-row-decision`
- **Base SHA**: `842e808b91f2c1bbfcc2688b0dd233c4c45974ae` (BL-105's merge, PR #115)
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Lane A, the escape row (ADR 0008 § 2) and its BL-081 decision record: a
store is an escape unless the object it writes onto is **proven** to be
one the program created (`isProvenFreshObject`, `escape-row.ts`). The
proof is hand-written over a closed list of store forms and a list of
proven object shapes (literals, functions and classes, `this` in some
class positions, `module.exports`, a `prototype`, and, since BL-095, the
objects TypeScript's emit creates for a namespace or an enum).

The class is **not certified**. BL-081's independent audit ran ten rounds,
BL-091's re-audit three, BL-091's own audit one, BL-095's audit five,
BL-099's and BL-100's audits further rounds; every round found further
live false `NOT_AFFECTED`s, all pre-existing on its base (ADR 0008, "Note
on the BL-081 decision record — BL-091's re-audit"; OPEN-DEBTS D-16/D-17
progress entries for BL-091 and BL-095; FINDINGS RWF-063, RWF-110,
RWF-120, RWF-122..RWF-128, RWF-131, RWF-132, RWF-141..RWF-143, RWF-149).
BL-091 handed the project owner the question this task prepares: whether
the rule should keep being point-fixed, **prove less** (for example no
class at all), or **read more of the build** (the TypeScript target, the
transpiler).

### Premises (AGENTS.md § D) — to verify before relying on them

- "Every audit round found further shapes." To be checked against the
  FINDINGS records and the oracle cases' `base` fields, not taken from
  the ADR's prose.
- "The precision cost of each option is …": nothing is measured yet for
  the "prove less" options; BL-081's 1,880 / 31,641 is the cost of the
  rule itself against the pre-BL-081 base, not of any option here.
- "Reading the build" is assumed to be able to tell what runs. ADR 0010's
  C-1 decision record (C2) ruled that the tsconfig never decides what
  Node loads, because what runs may be built by another tool; whether the
  same reasoning applies to class-field, class and decorator emit is to
  be measured, not assumed.

## Task

### Problem

The rule's soundness rests on two open-ended lists: the store forms
(assignment, pattern, `for…of`, `with`, fields, declarations the emit
turns into stores) and the object shapes it proves the program's own
(with their [[Prototype]] chains and the stores an emit makes that the
source does not show). Each audit round has extended one list or the
other. Point-fixing has no end condition the project can state.

### Why it matters

Soundness: every finding of the class is a live family-C false
`NOT_AFFECTED` (the critical failure). Defect class B (the analyzer's
assumption about what object a store writes onto is not what real Node
does) and C (an emit's several possible outputs collapsed to one).

### What to do

This is a decision task: it measures and recommends, and changes no
analyzer behaviour on its branch.

1. **Inventory.** Classify every historical false `NOT_AFFECTED` of the
   class (each oracle case of BL-081, BL-091, BL-095, BL-099 and BL-100
   whose `base` is `NOT_AFFECTED` and whose replacement real Node runs)
   by the proof clause it broke: a missed store form, a missed value route
   or bookkeeping gap, a class's inheritance, a TypeScript emit, a
   [[Prototype]] change on a non-class object.
2. **Prototype each option** as a patch against the base, outside the
   analyzer's committed code (`scripts/bl094-escape-options/`):
   - **O1** — the status quo (the base): further point fixes and audit
     rounds;
   - **O2** — prove less, in tiers: no class (no class value, class
     `this` or class `prototype` is proven); no class and no object a
     TypeScript emit creates (namespace, enum, legacy field target); and
     a literal-only core;
   - **O3** — read the build: what a tsconfig can and cannot establish
     about the emit that runs (measured against the transpilers in the
     repository, or argued from ADR 0010 C2 where they are absent).
3. **Measure each prototype**, each reported separately: the clean-node
   precision on the JavaScript and the TypeScript `node_modules` corpora
   (`scripts/bl081-builtin-store-escape-corpus.mjs`); the graph, proof
   and verdict differentials over the 139 corpus cases
   (`scripts/differential.mjs`); and the class's oracle cases — no case
   whose replacement real Node runs may be `NOT_AFFECTED`, and every
   control that loses precision is counted.
4. **Recommend**: append a "PROPOSED — requires project-owner decision"
   section to ADR 0008 with the options, the measurements and a
   recommendation, the way Amendment A-0 was proposed.
5. **Independent audit** (WORKFLOW § 1.5): verify the measurements, and
   try to break the recommended option's prototype against real Node.
6. Records: FINDINGS (any new finding), OPEN-DEBTS, backlog (the
   implementation task(s) the decision implies), progress, scorecard.
7. Report `NEEDS_DECISION`. On the owner's decision, record it in ADR
   0008 (a decision record, appended) in this task's pull request.

## Boundaries

### Do not touch

- The analyzer's committed behaviour (`src/`): the options are
  prototypes, applied only in scratch worktrees for measurement.
- Other tasks' worktrees and branches.
- The open-soundness-defect records and the oracle cases' expected
  verdicts.

### STOP conditions

- A measurement shows an option produces a `NOT_AFFECTED` where real Node
  runs the replacement: record it, and do not recommend that option
  without its fix.
- The inventory finds a live false `NOT_AFFECTED` on the base not yet
  registered: register it (FINDINGS) and report it prominently.
- The recommendation needs an exit-code or output-schema change.

## Acceptance criteria

- [ ] Every historical false `NOT_AFFECTED` of the class's oracle suites is
      classified by the proof clause it broke, with counts per clause.
- [ ] Each option (O1, every O2 tier) is prototyped as a patch committed
      under `scripts/bl094-escape-options/`, applicable to the base.
- [ ] Each prototype's JavaScript and TypeScript corpus precision, its
      graph, proof and verdict differentials, and its oracle-case result
      are measured and reported separately.
- [ ] O3 is assessed against what the tsconfig can establish about the
      emit that runs, with the evidence named.
- [ ] ADR 0008 carries an appended PROPOSED section with a recommendation.
- [ ] No file under `src/` changes on the branch.
- [ ] The independent audit ran, and its verdict is in the pull request.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. No analyzer change is
made on the branch, so the expected differentials of the branch itself
are zero; the prototypes' differentials are the task's measurements and
are reported separately. Validation baseline: OPEN-DEBTS D-09.

## Report

In the format of `AGENTS.md` section J. The verdict is expected to be
`NEEDS_DECISION`, with the recommendation and the measurements behind it.
