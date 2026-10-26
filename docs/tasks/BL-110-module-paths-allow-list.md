# BL-110 — Implement BL-096's decision on the read-only uses of `module.paths`

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-110
- **Branch**: `bl-110-module-paths-allow-list`
- **Base SHA**: `d7eb631c2bd637f13081b3edf25bbd45b5eda676` (BL-096's merge, PR #118)
- **Commits**:
  - `docs(tasks): BL-110 task file — implement BL-096's decision, an allow-list over the uses of module.paths`
  - `fix(BL-110): an allow-list over the uses of module.paths — no method is read-only; a use outside the closed list of parents is loader_capability_escape — RWF-136, RWF-154, RWF-155, RWF-157`
  - `test(BL-110): the allow-list per rule, its mutations by name, structural step and pass-up counts; BL-096's 41 records flipped, each lost control stated as the decision's cost`
  - (this commit) `docs(BL-110): records — RWF-136 and RWF-154 fixed, RWF-155 and RWF-157 fixed for the lookup list; ADR 0010 note, the certification audit and its re-audits, debts, backlog (BL-112), progress, scorecard`
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

- [x] The rule is implemented as ADR 0010's decision record states it,
      and the prototype's helpers are not duplicated.
- [x] The 41 records that use the list are deleted and assert `UNKNOWN`;
      RWF-156's six stay.
- [x] Every lost control is recorded as the decision's cost, and no
      other control changes.
- [x] Each mutation (a)–(e) is caught by a named test.
- [x] The structural cost (resolutions per file) is measured and
      `test:performance` passes unrelaxed.
- [x] The differentials are reported separately, and no corpus verdict
      moves.
- [x] The records are updated. The certification audit returned
      `CERTIFIED`. Its non-blocking findings were fixed, and the fixes were
      re-audited (see Corrections).

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: the differential is
zero over the 139 corpus cases; the validation baseline is D-09's six.

## Report

In the format of `AGENTS.md` § J.

## Corrections

**2026-10-26, deviations from "What to do".**
- **ADR 0010 § 4's text is left as written.** The backlog row said "amend
  ADR 0010 § 4's read-only bullet". This ADR's sections are append-only, and
  the decision record already amends § 4 by its own text. The task appends
  "Note — task BL-110" instead.
- **The identifier test is call-graph.ts's `isValueReferenceName`, moved
  unchanged to `local-aliases.ts`.** It is not a fourth copy. It already
  counts the left of a qualified name, so the TypeScript `import a = p.x.y`
  chain needed no code of its own.
- **Mutation (e) needed a second test.** Restoring a read-only method in
  `modulePathsMethodReason` alone was caught by no test, because the
  whole-file use check accounts for the same call independently. A test of
  `classifyClosureWideningCall`, which the call graph reads, now pins it.

**2026-10-26, after the certification audit (`CERTIFIED`, with findings).**
- **Finding 1 (P2, introduced by this task):** the pass-up was quadratic in
  selection nesting. A 4,000-term `||` chain took 6.5 s against the base's
  0.29 s. The answer per selection is now remembered, and the case takes
  188 ms. A structural pass-up test pins it, and removing the memo fails it.
- **Finding 4 (precision):** a TypeScript type position naming an alias of
  the list (`let x: typeof p`) was an escape although it is erased.
  - The first fix excluded every type query and type reference.
  - The focused re-audit blocked it on a soundness break: under
    `experimentalDecorators` and `emitDecoratorMetadata`, a decorated
    member's qualified type `p.T` is a runtime read of `p.T`. The auditor
    measured it against real Node, and a getter on `Array.prototype` then
    receives the list.
  - The second fix also excluded a bare-name type reference. That rested on
    the round's premise that its metadata "converts nothing". The next
    round showed the premise false: an interface sharing the alias's name
    makes TypeScript emit `p` itself (`__metadata("design:type", p)`), with
    no compiler diagnostic, which hands the list to a replaced
    `Reflect.metadata`. The auditor measured it against real Node, and
    swc's and Babel's metadata plugins emit the bare name whatever the type.
  - The rule now exempts only a type query (`isInErasedTypePosition`),
    which every emit erases (that round measured it, under legacy and TC39
    decorators, `isolatedModules` and esbuild). The decorated forms (a
    qualified type, a merged-interface bare type, a parameter decorator's
    type) are pinned as escapes. The auditor applied and measured this
    exact rule in its copy: all four probes give
    `loader_capability_escape`, and the alias-only control stays complete.
- **The memo's stored answers** are pinned by per-location tests (the
  re-audit's finding 2). Remembering `exempt` for every selection fails
  them.
- **Findings 2, 3 and 5 (records)** are corrected: the wording about
  linearity, a garbled FINDINGS status line, and RWF-136's remaining routes
  (PRM-21 and BL-040, besides RWF-156).
- **Pre-existing, registered:** backlog `BL-112` (P2). The classifier's
  resolution is exponential on a DAG of `const` aliases, and a deep syntax
  tree overflows the default stack.

Two focused fresh-context audits of the post-certification code changes
followed (both `BLOCKED` on the type-position rule, each fixed as above);
the second one's fix is the rule the auditor applied and measured.
