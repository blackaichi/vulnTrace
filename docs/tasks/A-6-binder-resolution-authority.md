# A-6 — Resolution authority, binder side: trailing chains; import names for string/computed keys

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: A-6
- **Branch**: a-6-binder-resolution-authority
- **Base SHA**: 9292cb3b8e13bc0dad36ba19daeb3d459ad015e6
- **Commits**:
  - `cf20fc6` docs(tasks): A-6 task file — trailing chains; import names for string/computed keys
  - `423fdd6` test(A-6): real-Node reproductions — trailing chains, .call/.apply, string and computed keys
  - `de30565` fix(A-6): resolution authority, binder side — whole-chain exports, .call/.apply, key-named imports
  - (this commit) docs(A-6): records — findings, plan § 5a, debts, backlog, progress, scorecard
- **Superseded by**: —

## Project context

Last task of lane A of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 7),
after [`A-5b`](A-5b-receiver-member-writes.md) (PR #84, merged
2026-10-05). It is scheduled last in lane A because E-4 and C-4 consume
its import-name and trailing-chain fix (plan § 5a, order 7).

The specification is
[ADR 0008](../adr/0008-invocation-accounting-and-resolution-authority.md)
invariant A2 ("a **resolved** edge exists only when an authority from a
closed set has proved that the callee denotes exactly one function at
that site on every execution: … an exact export with the whole member
chain consumed …") and § 8's A-6 row: "`symbol-binder.ts`,
`source-index.ts` | PRM-20 (all three spellings), PRM-108 origin |
**`symbol-binder.test.ts` 'ignores a trailing method chain on an
already-bound named import'** (pins the false premise: must now expect
`not_an_import`, except a single trailing `.call`/`.apply`)".
REMEDIATION-PLAN § 5a, "A-5a additions", binds this task: the PRM-108
fix must keep A-5a's condition that `extractRequireBindings` binds a name
only through the ambient `require`.

Findings closed: PRM-20 (all three spellings, and every site that
resolves a callee through the binder: a call, a tag, a decorator, a
`new`, an `extends` base, a VT-214 alias), PRM-108's origin. PRM-108's
consumer half stays open for task C-4.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **Measured (real Node v22.11.0, the oracle harness, 28 cases in
  `tests/oracle/a6-binder-resolution-authority.cases.ts`).** 16 are a
  false `NOT_AFFECTED` on the base:
  - PRM-20's three spellings (`api.parse()`, `lib.api.parse()`,
    `lib.safe.call.call(lib.parse)`), in every binding form: a named
    require, a literal element key, a named ESM import, a whole-module
    require, an ESM namespace and an ESM default import;
  - the same truncation at the sites task A-1's audit named (a tag, a
    legacy class decorator, an `extends` base) and at a `new`;
  - the VT-214 alias paths (`const f = api.parse`, `const a = api;
    a.parse()`, `const p = lib.api.parse`), which resolve the value
    through the same binder;
  - `lib.safe.call = lib.parse; lib.safe.call(…)`: the `.call` the ADR
    keeps is read off a member a write replaces (found by this task);
  - PRM-108: `const { "fork": f } = require("child_process")`, and the
    computed keys `["fork"]` and `[k]`.

  One more is `AFFECTED` only through a fabricated edge:
  `lib.parse.bind(null)("x")` (the `bind` call is attributed to `parse`).
  The rest are precision guards and regression guards, the base already
  sound (`lib.parse.call(…)`, `.apply`, a named `parse.call`, an imported
  class's static method, a class's own static `call`, an identifier key, an
  ESM string import name, a string key into a package).
- **True** (code read): `bindCallee`'s named branch never consulted the
  chain ("the chain is intentionally not consulted",
  `symbol-binder.ts`), and its default/namespace branch took the first
  member as the export and dropped the rest. Its `unconsumedChain` (task
  A-3a) was read by the escape row, the class authority and `extends`,
  but not by `classifyCallee`, `classifyNew` or `resolveAliasedValue`.
- **True**: a builtin's chain is already consumed whole (the builtin
  table's key, task A-3a); only the package side truncates.
- **False, corrected by this task**: the `symbol-binder.ts` comment that
  `loader-constructs.ts` reads the import table "refusal-only by
  construction" (PRM-108's cited premise). It classifies a builtin member
  from `importedName`, and a member it misses never widens the closure.
- **Premise of a pinned control, corrected**:
  `unsupported-construct.test.ts` "does not label a call whose receiver
  is locally bound and resolvable" used an imported object literal
  (`helper.execute()`), "resolvable" only through PRM-20's truncation
  (an edge to `helper`, then `unresolved_target`). Its resolvable side is
  now an imported class with a static method, which task A-5b's receiver
  authority really resolves.

## Task

### Problem

PRM-20: `bindCallee` binds a callee to the first export its chain names
and discards the members read after it, so `api.parse()` is an edge to
`api`, and family C certifies `parse` unreachable. PRM-108:
`extractRequireBindings` records the local name as the imported name for
a string or computed destructuring key, so the loader classifier reads
`const { "fork": f } = require("child_process")` as a member named `f`,
and `f(worker)` never widens the module-load closure (family A).

### Why it matters

Soundness: both are reproduced false `NOT_AFFECTED`s. Defect class A
(identifier text, or a prefix of the chain, standing for the binding's
real value).

### What to do

1. Tests first: the oracle cases above (failing on the base), the
   binder's and the index's unit tests, a graph-level test per refusal.
2. `bindCallee`: `"resolved"` only when the whole chain is consumed;
   `"resolved_function_method"` for a single trailing `.call` / `.apply`;
   `"not_an_import"` for any other chain past a package export. A
   builtin's chain stays the table's key. `unconsumedChain` is removed,
   so a resolved binding cannot carry one.
3. `classifyCallee`: a `.call` / `.apply` edge to a function export only
   (not a class constructor, an accessor or a module), recorded for task
   A-5b's whole-graph member-write check on the method's name. Every
   value reader (`resolveAliasedValue`, the escape row, the class
   authority, `classifyNew`) accepts `"resolved"` only.
4. `extractRequireBindings`: the imported name is the key, read under
   `named-bindings.ts`'s shape boundary (an identifier or a string
   literal); a numeric or computed key records no name.
5. Correct the pinned test and every comment whose premise the change
   makes false.

## Boundaries

### Do not touch

- `loader-constructs.ts` (PRM-108's consumer half is task C-4's).
- The export model and its write set (lane E).
- Another task's worktree (`rwf-046-require-binding-authority`).

### STOP conditions

- A precision guard (an exact export call, `.call` / `.apply` on a
  function export, an imported class's static method) turns `UNKNOWN`
  for a reason this task cannot remove without a decision.
- The validation baseline (OPEN-DEBTS D-09) changes in a way the change
  does not explain.

## Acceptance criteria

- [x] Every oracle case's sound verdict holds, real Node's ground truth
      matches `called`, and every case whose base differs from its
      expected fails on the base commit.
- [x] `bindCallee` returns `not_an_import` for every chain past a package
      export except a single trailing `.call` / `.apply`; the pinned
      `symbol-binder.test.ts` test asserts it.
- [x] A `.call` / `.apply` edge is withdrawn on a write of the method's
      name in any prepared file, and is never an edge to a class
      constructor or a value read.
- [x] `extractRequireBindings` names a string-keyed element by its key and
      records no name for a numeric or computed key.
- [x] Each new guard has a mutation caught by a named test.
- [x] PRM-108's remaining consumer gap is an open-soundness-defect record,
      never an expectation.
- [x] Records: FINDINGS (PRM-20, PRM-108, the new `.call` member-write
      finding), OPEN-DEBTS, plan § 5a "A-6 additions", backlog, progress,
      scorecard.

## Gates

The full set in `AGENTS.md` section I, unrelaxed, and
`node scripts/differential.mjs` against the base. Expected: verdicts move
only from a false `NOT_AFFECTED` (or a fabricated `AFFECTED`) to
`UNKNOWN`; the validation baseline stays the five known failures.

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5).

## Corrections

- **The base count.** "16 are a false `NOT_AFFECTED` on the base" above
  was a miscount of the same measurement: the list it gives has 18 (seven
  trailing-chain spellings, four sites, three aliases, the member-written
  `.call`, three PRM-108 keys). With the cases the independent audit added,
  the suite has 32 cases: 20 false `NOT_AFFECTED` and one fabricated
  `AFFECTED` on the base; 18 and the fabricated one are `UNKNOWN` after;
  two remain false `NOT_AFFECTED` as on the base, as open-soundness-defect
  records (`{ [k]: f }`, PRM-108's consumer; RWF-077).
- **What to do, step 4.** "a numeric or computed key records no name" was
  the first version of the fix, and the independent audit BLOCKED it
  (finding 1): dropping the row for a computed key turned
  `const { ["fork"]: fork } = …` and `const { [k]: fork } = …` from
  `UNKNOWN` on the base into false `NOT_AFFECTED`s, because the base's
  local-name row was the loader classifier's only (accidental) evidence.
  The rule now: an identifier, string or computed string-literal key names
  the element by its text; a numeric key records no name; an unreadable
  computed key keeps the base's local-name row -- not an import name, kept
  only because the classifier can only widen on it -- until C-4 fails
  closed there. The shape boundary is therefore NOT `named-bindings.ts`'s
  (which refuses every computed key); the call graph's attribution still
  refuses them, so it fails closed.
- **Scope.** The audit's findings 2 and 3 are pre-existing and out of
  scope: RWF-076 (backlog `BL-050`) and RWF-077 (`BL-051`).
