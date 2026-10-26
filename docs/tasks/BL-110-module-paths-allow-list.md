# BL-110 — Implement BL-096's decision on the read-only uses of `module.paths`

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-110
- **Branch**: `bl-110-module-paths-allow-list`
- **Base SHA**: `d7eb631c2bd637f13081b3edf25bbd45b5eda676` (BL-096's merge, PR #118)
- **Commits**: (filled in by the last commit)
- **Superseded by**: —

## Project context

Lane C, the loader classifier (ADR 0010; `loader-constructs.ts`). The
project owner accepted BL-096's option (b2) on 2026-10-26 (ADR 0010,
"Decision record — BL-096", which amends § 4). The measurements, the four
audit rounds and the prototype are BL-096's:
`scripts/bl096-module-paths-options/` (`b2-allow-list.patch`,
`results.md`) and `tests/oracle/bl096-module-paths-read-only.*` (61 cases
against real Node, 47 open-soundness-defect records).

The findings this task closes, for the lookup list: RWF-136 (the read-only
exemptions assume Node's builtins), RWF-154 (`instanceof` with the
program's own `Symbol.hasInstance`), RWF-155 (a shorthand property) and
RWF-157 (a `const` that may hold another capability). PRM-22's name
collision and PRM-105's array-literal and computed-key forms close for the
lookup list too. RWF-156 (Node's own loader through a replaced builtin)
is not in scope: backlog `BL-111`.

### Premises (AGENTS.md § D) — to verify before relying on them

- "The prototype gives `UNKNOWN` in all 43 cases that use the list and
  costs exactly four unit controls, one oracle control and seven BL-096
  controls." Measured by BL-096 on its base `904d032`. To be re-measured
  on this task's base and on the implementation, not assumed.
- "The prototype is not the implementation." It was written for
  measurement. Its helpers duplicate existing ones (`isWriteTarget`-like
  checks, `isFollowableAliasDeclaration`), and its cost per node was never
  measured. ADR 0010 § 5 warns that this classifier's wall time is
  sensitive to per-identifier resolution. To be measured structurally
  (operation counts, ARCHITECTURE § 10.2), never by relaxing a threshold.
- "No corpus graph, proof or verdict change." Measured on the prototype.
  To be re-measured on the implementation.

## Task

### Problem

`loader-constructs.ts` exempts uses of a `Module` instance's lookup list
as read-only on the premise that Node's own builtins handle the list
(`MODULE_PATHS_READ_METHODS`, `isIteratedLookupList`'s `for…of`, every
member read, every non-consumed position). A module can replace those
builtins, and some positions hand the list to the program's own code with
no replacement at all. 41 live false `NOT_AFFECTED`s are reproduced on
`main` (BL-096).

### Why it matters

Soundness: each is a live false `NOT_AFFECTED`, the critical failure.
The defect classes are B (wrong runtime-value semantics for a builtin)
and C (a multi-valued alias collapsed to one capability: RWF-157).

### What to do

1. **Implement** the decided rule in `loader-constructs.ts`, as ADR 0010's
   decision record states it:
   - delete `MODULE_PATHS_READ_METHODS`; every non-mutating method of the
     list is a `loader_capability_escape`, and the mutating ones keep
     `loader_hook_mutation`;
   - delete `isIteratedLookupList`'s `for…of` half; `for…in` stays exempt;
   - for every expression that may be the lookup list, classify its
     syntactic parent with the allow-list. The parent is exempt, passed up,
     or an escape;
   - an `ambiguous` member named `paths`, or under a computed key into a
     `Module` instance or an `ambiguous` value, may be the list;
   - a `const` alias is exempt only when it is plain and unexported (not
     `using`) and its declared name resolves to the list;
   - in TypeScript, an identifier at the head of an `import a = p.x.y`
     chain is a value reference (walk the `QualifiedName` chain to the
     `ImportEqualsDeclaration`; BL-096's audit, round 4).

   Correct every comment whose premise the change makes false.
2. **Tests.**
   - Flip each of the 41 open-soundness-defect records of
     `tests/oracle/bl096-module-paths-read-only.*` that use the list:
     delete the record and assert `UNKNOWN`. RWF-156's six records stay.
   - Each control that loses its proof is recorded as the decision's cost:
     an expected `UNKNOWN` with a stated `precisionCost`, never a wrong
     verdict. That covers BL-096's seven, BL-092's oracle
     `precision.read-only-uses`, ADR 0010 § 4's control 11, and BL-092's
     three unit controls.
   - Add unit tests for the classifier: every exempt and every pass-up
     parent, the alias rule and the `ambiguous` rule. Add a test for the
     TypeScript `import =` chain.
3. **Mutations.** Each must be caught by a named test:
   - (a) exempt every parent;
   - (b) drop the pass-up (treat a selection as exempt);
   - (c) exempt any `const` initializer;
   - (d) drop the `ambiguous` rule;
   - (e) restore a read-only method.
4. **Performance, structurally.** Count the classifier's resolutions per
   file, with and without the change, and keep `test:performance`
   unrelaxed.
5. **Measure** the graph, proof and verdict differentials
   (`scripts/differential.mjs`) and the validation baseline.
6. **Records.**
   - FINDINGS: RWF-136, RWF-154, RWF-155 and RWF-157 fixed for the lookup
     list, and PRM-22 / PRM-105 noted.
   - ADR 0010: an implementation note, appended.
   - OPEN-DEBTS, backlog, progress and the scorecard.
7. **Independent certification audit** (the decision record names it).
   This is a fresh-context audit of the allow-list against real Node.

## Boundaries

### Do not touch

- RWF-156's records and the loader's own write routes (`BL-111`).
- The call graph's `moduleScopeCalleeReason`, except where the shared
  `classifyLoaderConstruct` changes what it returns.
- Other lanes' code. The resolver's alias lookup (PRM-21 / PRM-22,
  C-2) is out of scope, except through the decided alias rule.

### STOP conditions

- The implementation gives `NOT_AFFECTED` where the prototype gave
  `UNKNOWN`, or a control changes beyond the decided cost.
- A corpus verdict moves.
- A performance threshold would have to move.
- The audit finds a soundness break outside the decided rule. That calls
  for a decision, so the task stops with `NEEDS_DECISION`.

## Acceptance criteria

- [ ] The rule is implemented as ADR 0010's decision record states it,
      and the prototype's helpers are not duplicated.
- [ ] The 41 records that use the list are deleted and assert `UNKNOWN`;
      RWF-156's six stay.
- [ ] Every lost control is recorded as the decision's cost, and no
      other control changes.
- [ ] Each mutation (a)–(e) is caught by a named test.
- [ ] The structural cost (resolutions per file) is measured and
      `test:performance` passes unrelaxed.
- [ ] The differentials are reported separately, and no corpus verdict
      moves.
- [ ] The records are updated, and the certification audit returns
      `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: the differential is
zero over the 139 corpus cases; the validation baseline is D-09's six.

## Report

In the format of `AGENTS.md` § J.
