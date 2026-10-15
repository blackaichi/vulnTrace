# BL-084 — Every route to a function's own object is a use of the export object it is the value of

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-084 (with `BL-086` folded in)
- **Branch**: `bl-084-function-own-object`
- **Base SHA**: `e7cb5767800ee757bfff3d9c035c074623f7ad85` (BL-075's merge, PR #105)
- **Commits**: (filled in by the last commit)
- **Superseded by**: —

## Project context

Lane E (ADR 0009 § 1; `docs/REMEDIATION-PLAN.md` § 5a). E-1's export
write set (`exportWriteSet` in `src/code-intelligence/module-model.ts`)
censuses every reference this file makes to its export objects. When the
final export object is a binding (`module.exports = Api`) or a named
function or class expression, its uses are censused by
`finalObjectAliasUses`, which visits only identifiers SPELLED like the
binding (E-1's audit, finding 5).

**RWF-114** (BL-075's audit, round 2) and **RWF-115** (round 3) in
`tests/validation/FINDINGS.md`: a function reaches its own object without
its name -- `arguments.callee` in a sloppy function, `new.target` in a
constructor, a `constructor` member of its `prototype` or of an instance,
`this` in a static member -- and writes a name onto it that the census
attributes to the file's own write. Live false `NOT_AFFECTED`s (family C),
pre-existing. Backlog `BL-084` and `BL-086`; the project owner's go of
2026-10-15 folds `BL-086` into this task (one census, one root).

BL-075's `isInertUse` narrowing (`isOwnBaseCallable`: a function or base
class on the right of `instanceof` inherits `Function.prototype`'s
`Symbol.hasInstance`) names RWF-114 and RWF-115 as an open debt it
inherits.

### Premises verified before this file was written (AGENTS.md § D)

Measured on the base `e7cb576` with the real-Node oracle harness (Node
v22.11.0) and E-1's loud fixture (`wrap/index.js` writes
`module.exports = Api; module.exports.run = safeOp;`, the entry calls
`require("wrap").run("x")`), and at the model (`mapExportsToFunctions`):

1. **RWF-114 and RWF-115 reproduce.** Real Node calls `parse`; the
   analyzer answers `NOT_AFFECTED` for `arguments.callee.run = …` (module
   time, entry-called, inline value) and `if (new.target) new.target.run =
   …` (the entry constructing first).
2. **The class is wider than recorded.** Also live false `NOT_AFFECTED`s
   on the base: `arguments` handed on (`set(arguments)`, the callee
   writing `a.callee.run`), an arrow inheriting `arguments`, an alias of
   `arguments.callee`, `arguments["callee"]`, `arguments[k]` with a
   run-time `k`, a destructured `{ callee }`; `helper.caller.run = …` in a
   function the export calls (**not recorded**: `Function.prototype.caller`
   returns a sloppy caller); a `new.target` alias; `Api.prototype[k].run =
   …` with a run-time `k`; and `super.run = …` in a method of an exported
   object literal (**not recorded**: a `super` property write sets the
   property on `this`).
3. **RWF-115's "at the model" note holds only without BL-064's taint.**
   With E-1's fixture prelude (`const lib = require("vuln-lib")`, a
   statement not proven to complete, first), every spelled-`constructor`
   shape is withdrawn by BL-064's `exportWritesMayFail` (any spelled
   `constructor` key is a hazard) or by `propertiesCarriedBy` answering
   `"all"` (a class, or a function reference that is not a callee or a
   member base, e.g. `new Api()`). With the load moved inside the
   functions (no unguarded statement first), the model attributes `run` to
   `safeOp` for `Api.prototype.constructor.run = …` (module time, or in a
   function the entry calls), `this.constructor.run = …` in `Api`'s body,
   and `p.constructor.run = …` with `Api.prototype` handed to a function.
   The same holds for `Reflect.get(Api.prototype, k)` and a stack
   callsite's `getFunction()`, which the call graph masks at the verdict.
4. **Strict code has no such routes, measured.** In a `"use strict"` file
   and in a class constructor, `arguments.callee` throws; a strict
   function is no `.caller`; a class member's frame gives no `getThis()`.

## Task

### Problem

The final object's alias census sees only identifiers spelled like the
binding. A function's own object is also the value of `arguments.callee`
in its sloppy frame, of `new.target` in its constructor (and in its base
classes' constructors), of `X.caller` for a sloppy function it calls, of a
stack callsite's `getFunction()`, and of the `constructor` property of its
`prototype` and every instance, read by any spelled or computed key. A
`super` property write in a method sets the property on `this`. None of
these is censused.

### Why it matters

Soundness: live false `NOT_AFFECTED`s (family C). Defect class A (wrong
binding identity: the exported function's own object reached without its
name).

### What to do

1. Failing first: oracle cases for every live shape of premises 1 and 2,
   with E-1's loud fixture and controls, failing on the base; the masked
   shapes of premise 3 and the strict-mode controls of premise 4 as oracle
   cases asserting their measured sound verdict; model-level unit tests
   for the routes premise 3 shows the model attributing.
2. Census every route to the final object's own function or class (the
   functions and classes `module.exports` may be: a function or class
   expression, a binding to a function or class declaration, or a variable
   initialized to one), each classified exactly like a reference to its
   binding: a read or a call keeps the names, a member write withdraws its
   name, anything else is un-enumerable. A `super` property write is a
   `this` property write.
3. Correct the comments whose premise the change makes false (the
   `instanceof` narrowing's "open debt").
4. Measure the precision cost over `node_modules` and the corpora (a
   per-task corpus script, as BL-075's), and the differentials.
5. Records: FINDINGS (RWF-114, RWF-115 status updates; premise 2's
   unrecorded routes), ADR 0009 note, REMEDIATION-PLAN § 5a "BL-084
   additions", OPEN-DEBTS, backlog, progress, scorecard.

## Boundaries

### Do not touch

- The call graph (`call-graph.ts`, `builtin-callables.ts`) and the proof
  families.
- BL-064's competing-write rule (`propertiesCarriedBy`,
  `exportWritesMayFail`): it can only withdraw more, and E-1's census
  withdrawal decides attribution whatever it answers.
- Other worktrees and branches.

### STOP conditions

- The precision cost is large enough that a narrower rule needs a
  decision (a holder analysis instead of every computed-key read): stop,
  report the numbers, `NEEDS_DECISION`.
- A fix requires changing the call graph or the proof families.
- The independent audit blocks on something outside the export model.

## Acceptance criteria

- [ ] Every live shape of premises 1 and 2 has an oracle case that fails
      on the base and answers `UNKNOWN` on the branch, with real Node
      calling `parse`.
- [ ] Every masked shape of premise 3 has an oracle case asserting
      `UNKNOWN` and a model-level test asserting the withdrawal.
- [ ] The strict-mode shapes of premise 4 are oracle cases grounding
      their exclusion (real Node does not call `parse`).
- [ ] No route of the Problem section reaches a written name the census
      does not withdraw.
- [ ] The precision cost is measured and recorded.
- [ ] Graph, proof and verdict differentials reported separately.
- [ ] Independent audit run; its verdict is in the pull request.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. The validation baseline
is OPEN-DEBTS D-09's six known failures (five, plus RWB-09a from BL-075).

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5).
