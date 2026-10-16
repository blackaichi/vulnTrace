# BL-081 — A store that may land on a builtin object is an escape, whatever route reached the object

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-081 (with `BL-039` folded in)
- **Branch**: `bl-081-builtin-replaced-without-name`
- **Base SHA**: `5db3c81d9f3848aff559247ccb7190f94c088c4f` (BL-089's merge, PR #107)
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Lane A (ADR 0008 § 2's escape row, § 4's builtin table;
`docs/REMEDIATION-PLAN.md` § 5a). A call of a builtin Node supplies
(`Object.keys({})`, `path.join("a", "b")`, `setTimeout(cb, 0)`) is
accounted by the builtin table (`builtin-callables.ts`): a no-edge proof
(`primitive_only_arguments`, `non_invoking_builtin`) or a resolved edge to
a documented invoking position's callback. That trust is sound only while
the builtin is Node's own. A-3a's escape row (`escape-row.ts`,
`escapingAssignmentOf`) keeps it sound against a store that SPELLS the
builtin -- `Object.keys = f`, `M.max = f` through a `const` alias, a write
through a `require("<builtin>")` binding -- by making the store a site
whose stored value gets an edge from the writing owner.

**RWF-110** (found by BL-075; `tests/validation/FINDINGS.md`): a builtin
replaced without its name (`({}).constructor.keys = f`, or `function
install(O) { O.keys = f; } install(Object)` in another module) runs `f`
with no edge. A live false `NOT_AFFECTED`, family C, pre-existing. Backlog
`BL-081`, P0. Its record names two options, both precision trade-offs to
measure first: (a) a write of a function value through a base that may be
a builtin object is an escape; (b) every builtin call is unresolved
whenever a module that may run can replace a builtin.

**RWF-063** (found by A-3a; backlog `BL-039`, P1): the parameter and
container forms of the same question -- `patch(Math)`, a builtin object
stored in a container or returned -- were left open by A-3a, which follows
`const` aliases only. RWF-110's third reproduction, `install(Object)`, IS
RWF-063's parameter form: no fix of RWF-110 leaves RWF-063 open, so
`BL-039` is folded into this task (`docs/WORKFLOW.md` § 2: required, same
root, same rule).

The project owner's go (2026-10-16) was given on the announced plan:
measure both options, take the one the measurements support with a
decision record in ADR 0008 for the owner to confirm by merging, or stop
with `NEEDS_DECISION` if neither is clear-cut.

### Premises verified before this file was written (AGENTS.md § D)

Measured on the base `5db3c81` with the real-Node oracle harness (Node
v22.11.0) and E-1's loud fixture (`wrap/index.js` writes `exports.run =
safeOp`, the entry calls `require("wrap").run("x")`; the replacement calls
`dangerousOp`, which calls the target `parse`):

1. **RWF-110 reproduces** for all three recorded spellings: real Node
   calls `parse`, the analyzer answers `NOT_AFFECTED`.
2. **The class is wider than recorded.** Also live false `NOT_AFFECTED`s
   on the base: the same `install(Object)` in the same file; a builtin
   object in a container (`[Object][0].keys = f`), returned from a
   function, the value of a load (`module.exports = Object` in a sibling,
   `require("./o").keys = f`), destructured (`const { constructor: C } =
   {}`), reached through `exports.constructor`; the entry replacing
   `Object.keys` through `({}).constructor` before it loads `wrap`; a
   builtin module object through a parameter (`install(path)` then
   `path.join("a", "b")`, `install(fs)` then `fs.readFileSync("x")`); the
   global object through a parameter or a sloppy plain call's `this`
   (`patch(globalThis)` / `function patch() { this.setTimeout = f; }`, then
   `setTimeout(function () {}, 0)`); an opaque value stored through a
   parameter (`install(Object, f)`, `function install(O, g) { O.keys = g;
   }`).
3. **Two store forms the escape row never saw, even by name** (not
   recorded): an assignment in a `with` body (`with (Object) { keys = f;
   }`) and a `for…of` head (`for (Object.keys of [f]) {}`, and the same
   through a parameter). Real Node calls `parse`; the analyzer answers
   `NOT_AFFECTED`. A-3a's escape row reads only `BinaryExpression` stores.
4. **Masked neighbours** (already `UNKNOWN` on the base, through another
   account): `Object.defineProperty`, `Object.assign` and `Reflect.set`
   through a parameter (a builtin call handing the program's function or
   an opaque value over); a computed key through a parameter (ADR 0008's
   decision record of 2026-10-04, decision 2: `protocol_value`); `[].__proto__.map = f`,
   `Object.getPrototypeOf([]).forEach = f`, `Promise.resolve().constructor
   .prototype.then = f` (an unknown edge elsewhere in the shape); `this` of
   `o.install.call(Object)`.
5. **Protocol-keyed stores are already accounted whatever the base**
   (`protocol-members.ts`, the `store` form: `x.toString = f`,
   `x[Symbol.iterator] = f`), so RWF-110 is about the non-protocol members
   the builtin table and the receiver-bound builtins trust.

## Task

### Problem

The call graph trusts a call of a builtin on the strength of the
builtin's identity at the call site, and sees a replacement of the
builtin only when the store spells the builtin's name. Builtins are shared
by every module of the process, and a builtin object reaches a user
binding through many routes the escape row does not follow: a parameter,
a container, a returned value, a load, `constructor` / `__proto__` /
`Object.getPrototypeOf`, the global object's `this`. A store through any
of them replaces what the trusted call runs.

### Why it matters

Soundness: a live false `NOT_AFFECTED` (family C). Defect class B (the
binding `Object` is right; the value assumed for `Object.keys` is not what
real Node holds), and C for RWF-063 (a builtin object that flows into a
user binding is assumed to still hold only Node's own members).

### What to do

1. Failing first: oracle cases for every live shape of premises 1-3 and
   the masked neighbours of premise 4 (`tests/oracle/`), with E-1's loud
   fixture and controls, failing on the base.
2. Measure both options' precision cost, at the graph (every
   `node_modules` package: functions whose forward closure has no unknown
   edge, base against each option) and at the verdict (the differential
   over the corpora). (b) needs (a)'s detection to know that a module
   "can replace a builtin", so (a) is the floor of (b)'s soundness work;
   take (a) unless (b) wins on measured precision by a clear margin.
3. Option (a): a store whose target is a member of a base not PROVEN to be
   an object the program created (a fresh object the analyzer can name)
   is an escape, whatever key it writes. The proofs of freshness are
   enumerated, each grounded under real Node; every other base -- a
   parameter, a call result, a load, a member chain, `this` outside a
   base class's constructor -- may be a builtin object. Include the
   `with`-body and `for…of`-head stores of premise 3.
4. Update the unit tests that pinned the old account; each one inverted is
   grounded under real Node or labelled a precision cost.
5. Records: FINDINGS (RWF-110, RWF-063 status updates; premise 3 as a new
   RWF), ADR 0008 decision record, REMEDIATION-PLAN § 5a "BL-081
   additions", OPEN-DEBTS, backlog (`BL-039` folded), progress, scorecard.

## Boundaries

### Do not touch

- The export model (`module-model.ts`): RWF-111 and RWF-113 are lane E's
  (`BL-082`, `BL-083`).
- The loader capabilities (`require`, `module`, `vm`, ...): lane C.
- Other worktrees and branches.

### STOP conditions

- Option (a)'s measured cost is large enough that (b) could plausibly win
  by a clear margin: stop, report the numbers, `NEEDS_DECISION`.
- A sound fix requires a whole-program value-flow analysis (lane C's C-3)
  rather than a local rule.
- The independent audit blocks on something outside the escape row and
  the builtin table.

## Acceptance criteria

- [ ] Every live shape of premises 1-3 has an oracle case that fails on
      the base and answers `UNKNOWN` on the branch, with real Node calling
      `parse`.
- [ ] Each masked neighbour of premise 4 has an oracle case asserting
      `UNKNOWN`.
- [ ] The control (a store onto an object the program created, `const o =
      {}; o.keys = f`) keeps `NOT_AFFECTED`.
- [ ] Every store whose base is not proven fresh is an escape site, in the
      assignment, destructuring-assignment, `with`-body and `for…of`-head
      forms; each freshness proof has a named test.
- [ ] Both options' precision costs are measured and recorded, with the
      reason the other was not built.
- [ ] Graph, proof and verdict differentials reported separately.
- [ ] Independent audit run; its verdict is in the pull request.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. The validation baseline
is the six known failures of OPEN-DEBTS D-09 (`RWB-03`, `RWB-05`,
`RWB-09a`, `RWB-09b`, `VAL-002`, `VAL-003`).

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5).
