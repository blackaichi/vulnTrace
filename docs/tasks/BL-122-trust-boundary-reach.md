# BL-122 — Decide the trust boundary's reach beyond built-in prototypes, and beyond `NOT_AFFECTED` (RWF-161, RWF-162)

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-122
- **Branch**: `bl-122-trust-boundary-reach`
- **Base SHA**: `58a5f3263587c6dbc56fea7c12b87553f0f6f3b2` (BL-113's merge, PR #128)
- **Commits**: filled in by the last commit
- **Superseded by**: —

## Project context

Lanes C and A, after the trust boundary. The project owner decided
BL-111's option (C) on 2026-10-27 (ADR 0010, "Decision record — BL-111"):
a `NOT_AFFECTED` assumes no loaded file changes Node's builtin
prototypes. Task BL-113 amended SOUNDNESS-CONTRACT § 1 with it, worded
over the **ECMAScript intrinsic prototypes only**, and left everything
else inside the contract's claim: Node's own loader objects, Node's other
builtin prototypes, globals, builtin modules' exports objects and builtin
constructors' own properties. The record's "Not decided here" leaves that
reach to the owner. Two live false `NOT_AFFECTED`s sit in it, both
pre-existing and both family B in BL-092's decoy setup:

- RWF-161: `Object.defineProperty(Array, Symbol.species, …)`, a builtin
  constructor's own property;
- RWF-162: a `pathname` getter on `URL.prototype`, Node's own builtin
  prototype.

A third question rides with it: the boundary narrows only what a
`NOT_AFFECTED` claims. Whether it also conditions an `AFFECTED` path, a
call edge or an export attribution decides `BL-123` (RWF-102, RWF-110,
RWF-111, RWF-113, RWF-120) and touches `BL-082`, `BL-083` and `BL-090`
(RWF-121).

### Premises (AGENTS.md § D)

- **"The reach is about four kinds of object: a global, a builtin
  module's exports, a builtin constructor's own properties, and Node's
  other prototypes."** From the decision record and the backlog note. Which
  of them Node's loader actually touches after startup is measured here,
  not assumed: a member the loader never touches cannot redirect a load,
  and one it does is a route whatever the record called it.
- **"The other `Symbol.species` constructors (`Promise`, `RegExp`,
  `ArrayBuffer`, `%TypedArray%`, `Map`, `Set`) may be routes."** RWF-161's
  "Not measured". To measure.
- **"`Buffer.prototype` and `EventEmitter.prototype` are not measured."**
  To measure.
- **"A closure-wide rule over stores onto those objects is of option (B)'s
  class, which BL-111 measured as costly."** BL-111 measured stores onto
  objects not proven the program's own, on base `71c62e0`. Whether a rule
  restricted to the objects the reach is about can be narrower, and what
  it costs on this base, is measured here.
- **Releases.** Only v22.11.0 runs the oracle locally; CI runs Node 20
  and 26. Twelve other releases are installed under
  `/data/tools/node-releases` (BL-114's), so the inventory is repeated on
  each.

### Measured before this commit (on the base)

The inventory (`scripts/bl122-trust-boundary-reach/probe-reach.cjs`,
repeated by `run-releases.mjs` on 13 releases from v20.19.0 to v26.12.1)
wraps every configurable member of those four kinds of object and runs a
load workload. The members Node's loader touches after startup, on every
release measured:

- **builtin constructors' own properties:** `Array[Symbol.species]` only.
  No other species is read, and no constructor method is called (the
  loader uses primordials);
- **Node's other builtin prototypes:** `URL.prototype`'s `pathname`,
  `href`, `protocol`, `hostname` and `toString`; `Buffer.isEncoding`
  (Buffer's own). Nothing on `EventEmitter.prototype` or
  `Buffer.prototype`;
- **builtin modules' exports objects:** `fs.readFileSync`,
  `fs.realpathSync`, and `path`'s `resolve`, `dirname`, `join`,
  `normalize`, `basename`, `isAbsolute`, `toNamespacedPath`, `posix` and
  `sep` (`sep` up to v24.12.0). Node's CommonJS loader calls them on the
  same exports objects a program's `require("fs")` / `require("path")`
  returns (`internal/modules/helpers.js`: "Import all of `fs` so that it
  can be monkey-patched");
- **globals:** none of `JSON`, `Math`, `Reflect` or `globalThis`'s own
  members; `process.mainModule` is read (no load depends on it).

**A new live false `NOT_AFFECTED`, outside the two findings the row
names.** Replacing `path.resolve`, `fs.realpathSync` or `fs.readFileSync`
before a load (by assignment, a define call, `Reflect.set`, through
`path/posix`, or from a sibling module) makes real Node v22.11.0 call the
target, and the analyzer answers `NOT_AFFECTED`, family B, on the base
(`tests/oracle/bl122-trust-boundary-reach.cases.ts`). The two identity-
wrapper controls keep their proof and real Node does not call the target.
It is registered as RWF-163 by this task.

## Task

### Problem

The trust boundary's reach beyond the intrinsic prototypes is undecided,
and three classes of live false `NOT_AFFECTED` sit in it: RWF-161 (a
constructor's own species), RWF-162 (`URL.prototype`) and RWF-163 (a
builtin module's exports object). Each is either the boundary's case, if
the owner widens it, or an open defect a closure-wide rule must close.

### Why it matters

Soundness: each is a live false `NOT_AFFECTED`, P0. Defect class B: the
analyzer takes Node's loader to run over Node's own builtins, and a
loaded file may have replaced them.

### What to do

This is a decision task. It measures and recommends, and changes no
analyzer behaviour in `src/`.

1. **Inventory**, against real Node on every installed release: which
   members of the four kinds of object the loader touches after startup
   (done above; `scripts/bl122-trust-boundary-reach/`).
2. **Reproduce** each touched kind end to end with an oracle case in
   BL-092's decoy setup, with a control; a live false `NOT_AFFECTED` is an
   open-soundness-defect record and a finding.
3. **Prototype** the closure-wide rules as patches against the base under
   `scripts/bl122-trust-boundary-reach/`, and **measure** them with
   `scripts/measure-options.mjs`: the oracle records closed and controls
   lost, the three differentials, the validation proofs lost, and a census
   over `node_modules`.
4. **Beyond `NOT_AFFECTED`:** for each open finding `BL-123` lists, and
   RWF-121, state which forms a boundary that also conditioned edges,
   attributions or `AFFECTED` paths would cover, so the owner decides
   with the consequence in view.
5. **Recommend.** Append a "PROPOSED — requires project-owner decision"
   section to ADR 0010.
6. **Independent audit** (WORKFLOW § 1.5).
7. **Records:** FINDINGS (RWF-161 and RWF-162 appends, RWF-163),
   OPEN-DEBTS, backlog, progress and the scorecard. Report
   `NEEDS_DECISION`.

## Boundaries

### Do not touch

- The analyzer's committed behaviour (`src/`) and the soundness contract's
  text: the prototypes are patches, applied only for measurement, and the
  contract changes only after the owner decides.
- BL-094's pending decision on the escape row, and the escape row itself.
- Other tasks' worktrees and branches.

### STOP conditions

- A prototype gives `NOT_AFFECTED` where real Node calls the target: do
  not recommend it without its fix.
- The inventory finds a live false `NOT_AFFECTED` outside the row's
  findings: register it and report it prominently (met: RWF-163).
- Every sound rule costs a large share of corpus proofs: report the
  trade-off as the owner's decision, with no recommendation forced.

## Acceptance criteria

- [ ] The inventory lists, for every installed release, the members of the
      four kinds of object Node's loader touches, and each touched kind
      that can redirect a load has a real-Node oracle case and a control.
- [ ] Each option is a patch applicable to the base, measured as above
      and reported separately.
- [ ] ADR 0010 carries an appended PROPOSED section that answers the
      reach, Node's other prototypes and the beyond-`NOT_AFFECTED`
      question.
- [ ] RWF-161 and RWF-162 are updated by appends, and RWF-163 is
      registered with an open-soundness-defect record per live case.
- [ ] `src/` (outside tests) and SOUNDNESS-CONTRACT are unchanged on the
      branch.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: no analyzer change,
so the branch differential is zero by construction; the validation
baseline is D-09's six.

## Report

In the format of `AGENTS.md` § J, verdict `NEEDS_DECISION`.

## Backlog note

Discovered in `BL-113`. RWF-161, a live false `NOT_AFFECTED`:
`Object.defineProperty(Array, Symbol.species, …)` changes the `Array`
constructor's own property, not a prototype, and Node's loader's
`ArrayPrototypeSlice` honours it, so RWF-156's mechanism reaches the
loader outside the boundary BL-113 stated. ADR 0010's decision record
left the boundary's reach beyond built-in prototypes undecided: a global
(`JSON`, `globalThis.setTimeout`), a builtin module's exports object, a
builtin constructor's own properties. The project owner decides:

- widen the boundary to some of those objects: SOUNDNESS-CONTRACT § 1, the
  disclosure (`BUILTIN_PROTOTYPE_TRUST_BOUNDARY`) and
  `src/domain/evidence.trust-boundary.test.ts` follow; RWF-161 moves to
  the documented limitation, and RWF-111's and RWF-121's builtin
  replacement forms are re-examined (`BL-082`, `BL-090`);
- or keep it, and close RWF-161 with a closure-wide rule over stores onto
  those objects, of option (B)'s class, which BL-111 measured as costly.

Two more questions for the same decision, from BL-113's independent
audit:

- **Node's other builtin prototypes.** The decision said "Node's builtin
  prototypes"; BL-113 worded the boundary over the ECMAScript intrinsic
  prototypes only, the narrower reading. Node's own `Module.prototype` is
  modeled (`tests/oracle/bl113-trust-boundary.cases.ts`). `URL.prototype`
  is not, and is live: RWF-162 (BL-113's audit, round 2, P0, spilled), a
  `pathname` getter redirecting a package resolved through `exports`; the
  broader reading would make it the boundary's case. `Buffer.prototype`
  and `EventEmitter.prototype` (which `process` inherits) are not
  measured.
- **Beyond `NOT_AFFECTED`.** The boundary narrows only what a
  `NOT_AFFECTED` claims. Whether it also conditions an `AFFECTED` path, a
  call edge or an export attribution (RWF-121, RWF-113, RWF-102: `BL-123`)
  is a further contract amendment.

Not measured: the other constructors with an own configurable
`Symbol.species` accessor (`Promise`, `RegExp`, `ArrayBuffer`,
`%TypedArray%`, `Map`, `Set`), and releases other than v22.11.0.
