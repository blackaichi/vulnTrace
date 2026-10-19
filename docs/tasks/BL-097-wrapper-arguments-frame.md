# BL-097 — The CommonJS wrapper's `arguments` reached through a function's frame (`g.caller.arguments`) in the loader classifier (RWF-137)

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-097
- **Branch**: `bl-097-wrapper-arguments-caller`
- **Base SHA**: `670a839b78e90a0227d85e7962543c8c56ea14bd` (BL-095's merge, PR #111)
- **Commits**:
  - `docs(tasks): BL-097 task file — the CommonJS wrapper's arguments reached through a function's frame`
  - `test(BL-097): a caller's frame against real Node — RWF-137, RWF-144`
  - `fix(BL-097): a read of a caller's frame, by a name it spells, is a loader capability escape — RWF-137`
  - (this commit) `docs(BL-097): records — RWF-137 fixed, RWF-144, AUD-04's second inspector route, the independent audit's two rounds, debts, backlog, progress, scorecard`
- **Superseded by**: —

## Project context

Lane C, the loader classifier (`src/code-intelligence/loader-constructs.ts`,
`findClosureWideningConstructs`): every loaded file is scanned whole for a
construct that may load a module the module-load closure does not follow,
and one such construct makes the closure incomplete, which withholds the
negative proofs that need it (families A and B, SOUNDNESS-CONTRACT § 4).
Task BL-092 made the CommonJS wrapper's own `arguments` (`arguments[1]` is
`require`, `arguments[2]` is `module`) a capability by what it is, not by
spelling (RWF-134). Its independent audit found that the same object is
reachable through a function's frame without spelling `arguments` at module
scope, a live false `NOT_AFFECTED` pre-existing on BL-092's base
(`tests/validation/FINDINGS.md`, RWF-137):

- `function g() { return g.caller.arguments[2]; } const m = g(); m.paths.shift();`
- `function g() { return g.caller.arguments[1]; } g()(<path>)`
- in a second module, `function g() { return g.caller.arguments; } g()[2].constructor._resolveFilename = hook;`

The export census already reads these routes by name: `fileReachesLoaderRegistry`
(`src/code-intelligence/module-model.ts`, tasks BL-074 and BL-084) counts a
member named `caller`, `prepareStackTrace`, `getThis` or `getFunction`
spelled as a member, a literal key, a destructuring key or any string. A
key computed at run time spells no name there either (RWF-109, backlog
`BL-080`, a precision decision).

### Premises (AGENTS.md § D) — measured before relying on them

Measured with real Node v22.11.0 and with the oracle harness on the base
`670a839` (`tests/oracle/bl097-wrapper-arguments-frame.cases.ts`, each
case's `base`):

- RWF-137's three reproductions are live false `NOT_AFFECTED`s.
  **Confirmed.** The proof the analyzer gives is family **B** in this
  setup (a decoy instance of the same name is in the graph), not family A
  as RWF-137's header says: a correction to the record.
- A sloppy function called at module scope has the wrapper as `caller`,
  and the wrapper's own `arguments` property, read while it runs, is its
  arguments object. **Confirmed.** So are two hops (`g.caller.caller`),
  `arguments.callee.caller`, `Reflect.get(g, "caller")`,
  `Object.getOwnPropertyDescriptor(g, "caller").value` (a sloppy
  function's `caller` is an own data property in V8), a destructuring key,
  a sloppy function exported by another module and called at this
  module's top level (it reaches the caller's wrapper), and V8's call
  sites (`Error.prepareStackTrace = (e, s) => s`: the module-scope frame's
  `getFunction()` is the wrapper, `getThis()` is `exports`). Every one is a
  live false `NOT_AFFECTED` on the base.
- In a strict function `g.caller` throws, and a file under `"use strict"`
  compiles a strict wrapper. **Confirmed**; not relied on (a strict
  reader can still read a sloppy function's `caller`).
- The backlog row's fix direction includes keys computed at run time.
  **Measured**: `g["call" + "er"]`, `Reflect.get(g, ["call", "er"].join(""))`,
  ``g[`${a}er`]`` and a call site's `getFunction` under a joined key are
  live false `NOT_AFFECTED`s on the base too. RWF-109 says the frame names
  belong to its class and that no false `NOT_AFFECTED` was measured for it;
  for the loader classifier that is now measured false. Failing closed on
  them is RWF-109's precision decision (BL-080: any read through a key
  computed at run time from a value that may be a function), so this task
  registers them (RWF-144) and does not decide them.

## Task

### Problem

The loader classifier does not see a read of a caller's frame, so a module
that reaches its own (or its importer's) wrapper's `require` or `module`
through it loads a module the closure does not follow, while the closure
is called complete.

### Why it matters

Soundness: a live false `NOT_AFFECTED` (family B in the measured setup;
family A where no other instance of the name is discovered, not measured).
Defect class A: the wrapper's `arguments` recognised by its name.

### What to do

1. Reproduce, tests first: every route above as an oracle case against
   real Node, with BL-092's loud fixture and controls, failing on the base;
   a precision control (a function's own `arguments`, by its property and
   by name) that stays `NOT_AFFECTED`.
2. Fix in `loader-constructs.ts`: a frame-reaching name (`caller`,
   `getFunction`, `getThis`) spelled as a member, a literal key, any
   string or a destructuring key is a `loader_capability_escape`, by name,
   whatever object it is read from -- the export census's spellings.
3. Unit tests pinning each spelling, so a mutation of any one is caught by
   name.
4. Register the computed-key routes as RWF-144 (open, BL-080), held by
   open-soundness-defect records, never as expectations.
5. Measure the precision cost on real `node_modules` code and run the
   differentials.
6. Records: FINDINGS (RWF-137 fixed, its family corrected; RWF-144),
   OPEN-DEBTS, backlog, progress, scorecard.

## Boundaries

### Do not touch

- The export census (`module-model.ts`) and its RWF-109 records.
- Other worktrees and branches.
- Computed keys: RWF-109's decision (BL-080).

### STOP conditions

- The fix moves a corpus verdict other than to `UNKNOWN` where real Node
  may reach the target.
- The precision cost on real code is large enough to be a product decision.

## Acceptance criteria

- [x] Every RWF-137 reproduction and every measured spelled route answers
      `UNKNOWN` against real Node's ground truth; each fails on the base.
- [x] The precision control stays `NOT_AFFECTED`.
- [x] Each spelling of the rule is pinned by a named unit test.
- [x] The computed-key routes are registered (RWF-144) and held by
      open-soundness-defect records.
- [x] The graph, proof and verdict differentials are reported separately.
- [x] The full gate set passes; validation matches OPEN-DEBTS D-09.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: the corpus spells
none of the names outside comments, so a zero differential (which is not
evidence of soundness, D-12); validation's known failures unchanged.

## Report

In the format of `AGENTS.md` § J.

## Corrections

Appended after work started (README.md): what the task found that its
text above did not say.

- **The rule's spellings, widened by the independent audit.** Round 1
  (`BLOCKED`) measured three live false `NOT_AFFECTED`s on the base and on
  the first fix, all in the spelled class or at its edge: a bare `caller`
  / `getFunction` in a `with` body (F-1, in this module, in a second one,
  and on a call site), and the name as a regular expression's pattern,
  `g[/caller/.source]` (F-3). Both are fixed: a bare name in a `with` body
  (not its head; nested functions included) and a regular expression whose
  whole pattern is the name are spellings. The census's rule fails closed
  on any `with`; the narrower rule was kept, and round 2 judged it sound
  for the spelled class. Round 1's F-2 (a frame member by enumeration,
  `Object.values(Object.getOwnPropertyDescriptors(g))[3].value`, no key
  at all) is registered under RWF-144, whose wording and BL-080's now
  cover enumeration. Comments, the fix commit's subject and the test
  titles no longer say "by any spelling".
- **Round 2 (`CERTIFIED`)** for the scoped claim, with a records finding:
  `inspector`'s `Debugger.evaluateOnCallFrame` runs code in the wrapper's
  frame (a live false `NOT_AFFECTED`, pre-existing; verified against real
  Node). It is neither the fixed class nor RWF-144's; recorded as a status
  update to AUD-04 (whose text named `Runtime.evaluate` only) and in C-4's
  row, which owns the inspector surface. Its F-2 (``g[`${''}caller`]``) is
  inside RWF-144.
- **Deviation from the backlog row's fix direction.** The row said
  "computed keys included". Failing closed on a key computed at run time
  (or an enumeration) of a value that may be a function is RWF-109's open
  precision decision (BL-080), so this task registered those routes as
  RWF-144, held by open-soundness-defect records, and raised BL-080 to P0
  (RWF-144 is a live false `NOT_AFFECTED`).
- **The measured cost.** Corpus differentials: zero graph, proof and
  verdict changes over 139 cases (the corpora spell the names only in
  comments). On the JavaScript in `node_modules`, four files of 2,527
  (three packages: `typescript`, `vitest`, `@vitest/mocker`) spell a name.
- **Records gap fixed in passing.** BACKLOG § 2 had no rows for RWF-141,
  RWF-142 and RWF-143 (BL-095's); added beside RWF-144's.
