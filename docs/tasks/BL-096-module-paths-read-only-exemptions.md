# BL-096 — Decide: the read-only exemptions for `module.paths` under a replaced `Array.prototype`

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-096
- **Branch**: `bl-096-module-paths-exemptions`
- **Base SHA**: `904d032268b4d1897361123ec71b9ad539a006a0` (BL-109's merge, PR #117)
- **Commits**: (filled in by the last commit)
- **Superseded by**: —

## Project context

Lane C, the loader classifier (ADR 0010; `loader-constructs.ts`). Task
BL-092 made a `Module` instance's lookup list (`module.paths`, reached by
any route) a capability kind of its own, `module_paths` (ADR 0010, "Note —
task BL-092"): any write into it is `loader_hook_mutation`, and an escape
of it is `loader_capability_escape`. ADR 0010 § 4 keeps the non-mutating
uses complete, the "read-only uses of loader state": the methods in
`MODULE_PATHS_READ_METHODS` (`slice`, `includes`, `indexOf` and 13 more),
iteration (`isIteratedLookupList`), every member read (an element,
`length`, a method value), and the primitive-result operators (ADR 0010
§ 4's first bullet; `PRIMITIVE_RESULT_BINARY_OPERATORS`, the template
literal).

RWF-136 (found by BL-092's independent audit) is open, and pinned to this
task. These exemptions assume that `Array.prototype` is Node's own. A
module that replaces `includes`, the array iterator or `join` runs with
the list as `this` and can change which instance a later `require` loads.
This is a live false `NOT_AFFECTED` that already exists on the base. The
backlog row names two options:

- **(a)** each exemption holds only while no loaded file writes a member
  of a builtin prototype, using lane A's builtin-replacement facts
  (RWF-110; ADR 0008, BL-081's decision record);
- **(b)** fail closed on every use except an element or `length` read
  (cost: ADR 0010 § 4's precision controls).

### Premises (AGENTS.md § D)

Measured before this file was committed, on the base, with real Node
v22.11.0 (probe scripts in the task's scratch space, then the oracle
cases below):

- **The exemptions are wider than RWF-136 names.** A member read the
  list does not own (`module.paths.foo`, an index past its end, a method
  read as a value), a property-key conversion (`o[module.paths]`), `await
  module.paths`, and both operands of `instanceof` are also exempt, and
  each hands the list to user code. **Measured.**
- **Option (b)'s "an element read" is not safe as worded.** An index the
  list does not own is an inherited lookup: a getter on
  `Object.prototype`, or a Proxy set as `Array.prototype`'s
  [[Prototype]], runs with the list as receiver. `length` and an own
  index are safe, but an own index is not known statically. **Measured.**
- **One route needs no builtin to be replaced at all**, so option (a)
  cannot close it: `module.paths instanceof H` with a class of the
  program's own that declares `static [Symbol.hasInstance]`. **Measured.**
- **RWF-136's "proof family affected: A".** In BL-092's setup the
  analyzer's proof is family B (the decoy instance is discovered, and the
  closure corroborating it is called complete). **Measured.** The record
  is corrected by an append.
- **"Lane A's builtin-replacement facts" exist as a closure-wide fact.**
  They do not. Lane A decides per store whether it is an escape
  (`escapingAssignmentOf`, `isProvenFreshObject`), and the rule is not
  certified (ADR 0008, BL-094's proposed decision, pending). Option (a)
  would have to be built on it. **Measured** (by reading the code).
- **The precision cost on real code.** Measured, not assumed: see the
  census in "What to do".

## Task

### Problem

The loader classifier exempts read-only uses of the lookup list because
Node's own array methods, iterator and conversions never hand the list to
user code. A module may replace any of them, or define an accessor or a
Proxy on the prototype chain, and then the list reaches user code that can
`shift()` it.

### Why it matters

Soundness: every case is a live false `NOT_AFFECTED` (the critical
failure), pre-existing on the base. Defect class B: the binding is right,
but the value the analyzer assumes for a builtin is not what real Node
runs.

### What to do

This is a decision task. It measures and recommends, and changes no
analyzer behaviour in `src/`. The options are prototypes, applied only to
measure them.

1. **Reproduce** every route against real Node with the oracle harness, in
   BL-092's decoy setup (`tests/oracle/bl096-module-paths-read-only.*`).
   Each live false `NOT_AFFECTED` is an open-soundness-defect record. Add
   sound controls, where real Node never hands the list on under any
   tamper, and precision controls, with no tamper.
2. **Census** the corpora (`scripts/bl096-module-paths-options/census.mjs`):
   how many files use the lookup list at all, and how often option (a)'s
   precondition fails in real code.
3. **Prototype** each option as a patch under
   `scripts/bl096-module-paths-options/`:
   - **(a)** the exemptions conditioned on the closure: no loaded file has
     a store the escape row counts as possibly writing a builtin, plus an
     unconditional fix for the route (a) cannot see;
   - **(b0)** option (b) as worded: fail closed on every use except an
     element or `length` read;
   - **(b1)** option (b) corrected by the measurement: fail closed on
     every use except `length` and the operators real Node never converts
     with (`===`, `!==`, `typeof`, `void`, `!`, the right of `in`,
     `for…in`, a test, `??`, `==` with `null`).
4. **Measure** each prototype, each reported separately: the BL-096 oracle
   cases (no case real Node calls may be `NOT_AFFECTED`); the other
   oracle and unit suites (each control that loses precision is counted);
   the graph, proof and verdict differentials over the corpora
   (`scripts/differential.mjs`).
5. **Recommend.** Append a "PROPOSED — requires project-owner decision"
   section to ADR 0010.
6. **Independent audit** (WORKFLOW § 1.5): verify the measurements, and
   try to break the recommended prototype against real Node.
7. **Records**: FINDINGS (RWF-136 append; new findings registered),
   OPEN-DEBTS, backlog (the implementation task), progress, scorecard.
   Report `NEEDS_DECISION`.

## Boundaries

### Do not touch

- The analyzer's committed behaviour (`src/`). The prototypes are
  patches, applied only for measurement.
- Other tasks' worktrees and branches. The other oracle suites' cases and
  their expected verdicts.
- `Module.builtinModules.includes(…)` (ADR 0010 § 4's other read-only
  exemption). It is not a lookup list, and Node's loader does not read it.
  It is noted, not decided, here.

### STOP conditions

- A prototype gives `NOT_AFFECTED` where real Node calls the target: do
  not recommend it without its fix.
- A live false `NOT_AFFECTED` outside RWF-136's mechanism: register it and
  report it prominently.
- The recommendation needs an exit-code or output-schema change.

## Acceptance criteria

- [ ] Every route is reproduced against real Node, and each live false
      `NOT_AFFECTED` on the base is an open-soundness-defect record with
      its measured observation.
- [ ] The census reports the corpus's uses of the lookup list and the rate
      at which option (a)'s precondition fails.
- [ ] Each option is a patch under `scripts/bl096-module-paths-options/`,
      applicable to the base, and its oracle, unit and differential
      results are measured and reported separately.
- [ ] ADR 0010 carries an appended PROPOSED section with a recommendation.
- [ ] RWF-136's record is corrected by an append, and every new finding is
      registered.
- [ ] `src/` is unchanged on the branch.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: no analyzer change,
so the differential is zero by construction, and the validation baseline
is OPEN-DEBTS D-09's six known failures, unchanged.

## Report

In the format of `AGENTS.md` § J, verdict `NEEDS_DECISION`: the project
owner decides ADR 0010's proposed decision.
