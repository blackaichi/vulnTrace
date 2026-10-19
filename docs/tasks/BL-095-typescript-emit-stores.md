# BL-095 — Stores TypeScript's emit makes that the source shows as declarations: a namespace merged with a class, a field named `__proto__` (RWF-131, RWF-132)

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-095
- **Branch**: `bl-095-ts-emit-stores`
- **Base SHA**: `09d9b614489eb119eafd5ae00578dd2ff50d8cd4` (BL-092's merge, PR #110)
- **Commits**:
  - `docs(tasks): BL-095 task file — stores TypeScript's emit makes that the source shows as declarations`
  - `test(BL-095): TypeScript's emit stores against real Node — RWF-131, RWF-132`
  - `fix(BL-095): the stores TypeScript's emit makes that the source shows as declarations are escape-row stores — RWF-131, RWF-132`
  - (this commit) `docs(BL-095): records — RWF-131, RWF-132 fixed, RWF-141..143, the independent audit's five rounds, ADR 0008 note, debts, backlog (BL-099..101), progress, scorecard`
- **Superseded by**: —

## Project context

Lane A, ADR 0008's escape row and its decision record "BL-081"
(`src/code-intelligence/escape-row.ts`): a store is an escape unless the
object it writes onto is proven to be the program's own
(`isProvenFreshObject`). The proof holds only over a closed list of store
forms. BL-091 added one form TypeScript's emit makes that the source does
not show as an assignment, a static field under the legacy class-field
emit (RWF-127). Its independent audit found two more, both live false
`NOT_AFFECTED`s (family C) also on BL-091's base
(`tests/validation/FINDINGS.md`):

- **RWF-131**: TypeScript compiles a namespace's exported member to a
  store onto the namespace's object (`namespace D { export const k = v }`
  → `D.k = v`). When `D` is a class derived from `util.inspect`, the
  store runs the setter `D` inherits (RWF-126's mechanism). FINDINGS' fix
  direction: every exported member of a namespace merged with a class whose
  static chain is not the program's own is a store of its value onto the
  class.
- **RWF-132**: below target ES2022 (`useDefineForClassFields: false`) a
  field named `__proto__` compiles to `this.__proto__ = v`, which changes
  the object's [[Prototype]]; the freshness proofs see a `__proto__` store
  only in an assignment. FINDINGS' fix direction: a field or parameter
  property whose key may be `__proto__` is a `__proto__` store.

BL-094 (a decision on the escape row's "unless proven" rule) may change
how this class is handled later; the backlog puts BL-095 first, and the
project owner chose to do it now (2026-10-19). Its reproductions stay
valid whichever way BL-094 goes.

### Premises (AGENTS.md § D) — measured before relying on them

Measured on the base `09d9b61` with the oracle harness against real Node
v22.11.0 (`tests/oracle/bl095-typescript-emit-stores.cases.ts`, each
case's `base`), on the source compiled by the repository's TypeScript:

- RWF-131's reproduction is live. **Confirmed**, in a module that is not
  the entrypoint. In the entrypoint a namespace's exports are masked
  (`UNKNOWN` through `entrypoint_root_incomplete`), as FINDINGS says.
- The emit (measured with `ts.transpileModule`): an exported variable's
  initializer, an exported function, class and `export import` alias are
  stores onto the namespace's object; a use of an exported variable in a
  body of the namespace is a member access on it (`k = v` → `D.k = v`,
  `k.m = v` → `D.k.m = v`), and from another block of the namespace a use
  of any exported member is; a nested exported namespace's object is read
  from its parent's (`N = D.N || (D.N = {})`). **Measured.** So the class
  is wider than "exported members": assignments in the body, member stores
  through an exported variable, nested namespaces, a decorated class's
  namespace (the object is the decorator's result) and a write from
  another block are live false `NOT_AFFECTED`s too (cases `rwf131.*`).
- A store written out onto a namespace's object (`N.h = v`) is already an
  escape: no freshness proof accepts a namespace's name. **Measured**
  (`masked.exported-variable-written-from-outside`).
- RWF-132's reproduction is live, and so are a string or computed key, a
  computed key held in a variable, a parameter property, a static field,
  and a later field of the same class (`class C { __proto__ = globalThis;
  Buffer = … }`, an instance field the escape row did not read for a base
  class). **Confirmed.** At target ES2022 the field is defined and nothing
  is called. **Confirmed.**

## Task

### Problem

The escape row's freshness proofs read the source, but a TypeScript
file runs as its emit, which makes stores the source shows as
declarations: a namespace's members are stores onto (and reads from) the
namespace's object, and a legacy-emit field is an assignment. Each is a
store the closed list of store forms does not contain, so a builtin's
setter runs, or an object's [[Prototype]] changes, unseen.

### Why it matters

Soundness: every `rwf131.*` and `rwf132.*` case is a live false
`NOT_AFFECTED` (family C), the critical failure. Defect class B (correct
binding, wrong runtime-value semantics: a declaration taken to store
nothing; a namespace's exported variable taken to hold its initializer
when it is a member of an object the program may not own).

### What to do

1. **Tests first**: the oracle cases, failing on the base, with E-1's loud
   fixture and both controls, or a declared reason why no negative control
   can be `NOT_AFFECTED` once the case is sound.
2. **The namespace's object** (`namespaceObjectIsOwn`): the class or
   function a namespace merges with, the `{}` a first block or a merged
   `enum` created, or, for a nested exported namespace, its parent's
   member. It is the program's own when the name is never stored to or
   declared as a variable or import, no `__proto__` store may change it,
   a merged class is undecorated with a static chain that is the
   program's own, and a nested namespace's parent is the program's own
   with no other member of that name.
3. **Its stores**, when the object is not the program's own: an exported
   variable's initializer (a declaration store), an exported function,
   class or `export import` alias (a new escape site at the namespace
   declaration), and an assignment to an exported variable in a body of
   the namespace. An assignment from another block of the namespace (a
   name with no declaration in scope) is an escape whatever the object,
   as `N.k = v` written out is.
4. **Its reads**: an exported variable used in a body of a namespace
   whose object is not the program's own is not a proven-fresh object.
5. **Legacy-emit fields**: in a TypeScript file, a field with an
   initializer or a parameter property whose key is `__proto__` or
   `prototype` (or a computed key that is not a literal) is filed as a
   store under that key, onto any object of the file; and any field or
   parameter property is a store onto its class or instance when that
   object is not proven the program's own.
6. **Mutations**, each caught by a named test.
7. **Records**: FINDINGS (RWF-131, RWF-132 fixed), OPEN-DEBTS, ADR 0008's
   BL-081 decision record (the note that named BL-095), backlog,
   progress, scorecard.
8. **Independent audit** (WORKFLOW § 1.5).

## Boundaries

### Do not touch

- Reading the project's TypeScript target or emit settings (BL-094's
  decision): every TypeScript file is taken as the legacy emit, as
  BL-091 did.
- A JavaScript source compiled with Babel's or swc's loose class fields
  (RWF-127's open part, BL-094).
- Call resolution through a namespace's exported variable
  (`named-bindings.ts`): only the escape row's stores and freshness
  proofs.
- The loader classifier (lane C), BL-097's frame rule.
- Other worktrees and branches.

### STOP conditions

- A precision cost on the validation or adversarial corpora (a verdict
  that moves away from its expected value), unless the moved case is
  itself wrong.
- A fix that needs the project's TypeScript configuration
  (`NEEDS_DECISION`, BL-094).
- An independent-audit finding outside the escape row.

## Acceptance criteria

- [ ] Every case in `tests/oracle/bl095-typescript-emit-stores.cases.ts`
      answers its `expected` verdict with real Node's ground truth, and
      every case whose `base` is `NOT_AFFECTED` failed on the base.
- [ ] The `control.*` cases (a namespace merged with a base class or a
      class derived from the program's own, a standalone namespace, a
      member not exported, a field named otherwise, a later field without
      a `__proto__` field) stay `NOT_AFFECTED`.
- [ ] Each new rule has a mutation caught by a named test.
- [ ] The graph, proof and verdict differentials are reported; no corpus
      case moves away from its expected verdict.
- [ ] RWF-131 and RWF-132 are recorded as fixed.
- [ ] The independent audit certifies the change, or its findings are
      handled per WORKFLOW § 1.5.

## Gates

The full set in `AGENTS.md` § I, unrelaxed, run once on the final HEAD
with `node scripts/gates.mjs`. `npm run test:validation`'s baseline is
OPEN-DEBTS D-09's six known failures; no change is expected.

## Report

In the format of `AGENTS.md` § J (`docs/WORKFLOW.md` § 5).

## Corrections

Appended at `READY_FOR_REVIEW`; the sections above are as written at the
start.

- **Scope, by the independent audit** (five fresh-context rounds, none
  certifying). Every round found further live false `NOT_AFFECTED`s of the
  class, every one also on the base; twenty-seven are cases
  (`audit*.*`), fixed in this task. What to do now reads, beyond items 2
  to 5:
  - item 2: a namespace nested in another (exported or dotted) is never
    the program's own (its object is read from the parent's, which may be
    any store's or an inherited member: round 1), nor is one merged with
    an enum (round 1), with a bodiless overload (round 2), or named like a
    CommonJS wrapper parameter (round 4); blocks are grouped by qualified
    name per file (round 2);
  - item 3: a write to a name an enclosing namespace exports is an escape
    whatever the object (round 2); a class or function merged with a
    namespace is never proven fresh, as a name or as `this` in its static
    code (rounds 3 and 4); an enum member is an escape when its enum's
    object is not proven the program's own, and an enum member named
    `__proto__` or `prototype` is filed as a store (round 2);
  - item 4: a use of an exported variable is never proven fresh, whatever
    the object (round 1), nor an alias of one (round 5); a namespace's or
    enum's member handed over by a name the resolver binds to an outer
    declaration is opaque (round 5); an `export declare let` is a member
    (round 1);
  - item 5: a decorated class's static field is a store onto an object not
    proven the program's own (round 1);
  - and the cost (rounds 1, 3, 4): one namespace index per file, with
    operation counters and two structural tests.
- **Round five's findings 1 to 3 were fixed after it without a sixth
  round.** Whether that is enough, or the class needs further rounds or
  BL-094's structural change, is the project owner's decision.
- **Registered, not fixed** (outside the escape row's stores and
  freshness proofs, or a new form): `RWF-141` (a call through a
  namespace's exported variable resolves to its initializer while an own
  accessor answers the read: call resolution, `BL-099`), `RWF-142`
  (TypeScript's decorator helpers' implicit calls: `BL-100`) and `RWF-143`
  (an ES5 class's methods are assignments: `BL-101`).
- **Premise corrected**: "a store written out onto a namespace's object
  (`N.h = v`) is already an escape" held for a namespace alone, not for
  one merged with a class or function, which the escape row proved fresh
  (round 3, finding 1; fixed).
- **Controls**: seventeen of the fifty-six cases declare their negative
  control inapplicable, each with its reason in the cases file: the store
  that makes an object a builtin one (a `__proto__` field or enum member,
  a store onto a class merged with a namespace) is itself an escape now,
  an array pattern's iterator, or a member handed over by a name the
  resolver binds elsewhere, each an unknown edge in the negative control
  too. Precision is measured by the six `control.*` cases.
- **Tooling**: `scripts/bl081-builtin-store-escape-corpus.mjs` gained
  `--typescript`, to measure the precision cost on TypeScript sources.

