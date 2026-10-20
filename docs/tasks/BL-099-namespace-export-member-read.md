# BL-099 — A use of a namespace's exported member is a read of the namespace's object (RWF-141)

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-099
- **Branch**: `bl-099-namespace-export-member-read`
- **Base SHA**: `692b3651f850e51391bf4ba842bff1000c89a995` (BL-097's merge, PR #112)
- **Commits**:
  - `docs(tasks): BL-099 task file — a use of a namespace's exported member is a read of the namespace's object`
  - `test(BL-099): a namespace's exported member against real Node — RWF-141, RWF-145, RWF-147`
  - `fix(BL-099): no name is looked up past a TypeScript namespace; an exported variable used in its own block is a member read — RWF-141, RWF-145, RWF-147`
  - (this commit) `docs(BL-099): records — RWF-141 fixed, RWF-145 in part, RWF-147 fixed, RWF-146 and RWF-148 registered, the independent audit's five rounds, debts, backlog (BL-102..104), progress, scorecard`
- **Superseded by**: —

## Project context

Lane A, call resolution (`src/code-intelligence/named-bindings.ts`, the
scope-aware resolver every named callee, receiver and alias goes through:
P1-B3's soundness rule). Task BL-095 made the escape row read the stores
TypeScript's emit makes for a namespace (RWF-131); its independent audit,
round 3, found that call resolution still reads a namespace's exported
variable as its initializer (`tests/validation/FINDINGS.md`, RWF-141, a
live false `NOT_AFFECTED`, family C, pre-existing):

```ts
class N { static get h(): any { return lib.parse; } static set h(_v: any) {} }
namespace N { export let h: any = function (x: any) { return x; }; h(1); }
```

TypeScript emits `N.h = function …; N.h(1)`: the call reads `N.h`
through the class's own getter, which returns `lib.parse`. The record's fix
direction: a use of a namespace's exported variable in a body of the
namespace is a member read, resolved only when the namespace's object
provably holds the initializer there, an unknown callee otherwise.

### Premises (AGENTS.md § D) — measured before relying on them

Measured with the repository's own TypeScript (`ts.transpileModule`, targets
ES5, ES2020, ES2022) and real Node v22.11.0, and with the oracle harness on
the base `692b365` (`tests/oracle/bl099-namespace-export-member-read.cases.ts`,
each case's `base`):

- RWF-141's reproduction is a live false `NOT_AFFECTED`. **Confirmed.**
- TypeScript's rewrite of a use. **Measured**, and wider than the record
  says: in the block that declares it, every use of an exported variable
  (`let` / `var` / `const`, a destructured one included) and of an
  `export import` alias is a member read (`h(1)` → `N.h(1)`, `const a = h`
  → `const a = N.h`, `` h`t` ``, `new h()`, `h.call(…)`, an argument); an
  exported function or class keeps its local binding (`f()` stays `f()`).
  From **another block** of the merged namespace, and from a namespace
  nested in it (`namespace N.P { … }`, `namespace N { namespace P { … } }`),
  every use of **any** exported member is a member read, the function and
  class included.
- Two defect classes, not one. The record names B and C (the initializer
  collapsed with what the object answers). From another block the resolver
  also binds the name to an **outer declaration spelled the same**, which
  TypeScript's namespace member shadows: defect class A. Measured live:
  `const h = f; namespace N { export let h = g; } namespace N { h(1); }`
  calls `g`, the analyzer resolves `f`.
- **Found while measuring** (RWF-145, registered by this task): a
  namespace's own `import g = I.h` (not exported) is a local binding
  (`var g = I.h`), but the resolver records an import declaration only at
  file scope, so `g` in the namespace binds to an outer `g`. A live false
  `NOT_AFFECTED`, pre-existing; the same scope walk, so it is folded in.
- Already `UNKNOWN` on the base through other accounts (masked): `h.call`
  (`unsupported_receiver_binding`), a destructured export and an
  `export import` alias (`unsupported_callee_binding`), a value stored from
  another block (BL-095's escape).

## Task

### Problem

The resolver treats a namespace's body as an ordinary block: an exported
variable resolves to its initializer, and from another block of the
namespace an exported member's name resolves to whatever outer declaration
shares its spelling. At run time both are reads of the namespace's object,
which may answer through an accessor the program owns or inherits, or hold
a value another block stored.

### Why it matters

Soundness: live false `NOT_AFFECTED`s (family C), the critical failure.
Defect classes A (a name bound to the wrong declaration), B (a member read
taken for a binding's value) and C (the member's values collapsed to the
initializer).

### What to do

1. **Tests first**: the oracle cases, failing on the base, with the loud
   fixture `vuln-lib` and both controls (or a declared reason no negative
   control can be `NOT_AFFECTED`); controls that stay `NOT_AFFECTED`.
2. **Fix in the scope walk** (`findBindingDeclaration`, and the separate
   walk of `lexicalDeclarationOf`), so every consumer gets it: a declaration
   found in a namespace's body that is an exported variable or an
   `export import` alias, and a name that walking out of a namespace finds
   exported by any block of the namespace (BL-095's grouping by qualified
   name), is refused with a new cause, `namespace_member`: an unknown
   callee. A namespace's `import X = …` is recorded as a declaration of its
   block.
3. Proving the object holds the initializer (the record's "resolved only
   when …") is **not** attempted: the object may answer through a merged
   class's or function's own or inherited accessor, a store from another
   block or from outside, or an `Object.prototype` accessor (RWF-113's open
   decision). The precision this costs is measured (`cost.*`, the corpora,
   real TypeScript sources).
4. Unit tests pinning each rule, and mutations each caught by a named test.
5. Differentials (graph, proof, verdict) and validation against
   OPEN-DEBTS D-09.
6. Records: FINDINGS (RWF-141 fixed; RWF-145 registered and fixed),
   OPEN-DEBTS, backlog, progress, scorecard.
7. Independent audit (WORKFLOW § 1.5).

## Boundaries

### Do not touch

- The escape row's stores and freshness proofs (BL-095's, `escape-row.ts`),
  except where a consumer of the resolver needs no change.
- TypeScript's decorator helpers (RWF-142, BL-100) and an ES5 class's
  methods (RWF-143, BL-101).
- Reading the project's TypeScript configuration (BL-094's decision).
- Other worktrees and branches.

### STOP conditions

- A corpus verdict moves away from its expected value, unless the moved
  case is itself wrong.
- The precision cost on real code is large enough to be a product decision
  (`NEEDS_DECISION`).
- An independent-audit finding outside call resolution through a
  namespace's scope.

## Acceptance criteria

- [x] Every case in `tests/oracle/bl099-namespace-export-member-read.cases.ts`
      answers its `expected` verdict with real Node's ground truth, and every
      case whose `base` is `NOT_AFFECTED` while `called` is true failed on
      the base.
- [x] The `control.*` cases stay `NOT_AFFECTED`.
- [x] Each rule is pinned by a named unit test, and each mutation of it is
      caught by one.
- [x] The graph, proof and verdict differentials are reported separately; no
      corpus case moves away from its expected verdict.
- [x] RWF-141 and RWF-145 are recorded as fixed (RWF-145 in part: its
      `import X =` form; its nested namespace and enum, masked, are BL-102).
- [ ] The independent audit certifies the change, or its findings are
      handled per WORKFLOW § 1.5. **Not certified**: five rounds, each
      `BLOCKED` on further live shapes (all pre-existing, all fixed); round
      five's were fixed without a sixth round (see Corrections).

## Gates

The full set in `AGENTS.md` § I, unrelaxed, run once on the final HEAD with
`node scripts/gates.mjs`. `npm run test:validation`'s baseline is OPEN-DEBTS
D-09's six known failures; no change is expected.

## Report

In the format of `AGENTS.md` § J (`docs/WORKFLOW.md` § 5).

## Corrections

Appended at `READY_FOR_REVIEW`; the sections above are as written at the
start.

- **The rule became structural (rounds 1 to 3).** What to do, item 2,
  enumerated which names a namespace's object answers (its blocks' exports).
  Each audit round found more the file's syntax does not show: an ambient
  block's implicit exports (round 1), a module augmentation of an exported
  namespace (round 2), one reached through an alias (`export = N.P`,
  `export import X = N.P`) and an `export { h }` TypeScript reports and still
  emits (round 3). So no name is looked up past a namespace
  (`leavesNamespace`): every name a use walks out of one for is refused. The
  own-block rule (an exported variable or `export import`) stays, and also
  covers an `export var` in a nested block (round 5).
- **`lexicalDeclarationOf` is not changed** (deviation from item 2). Its
  consumers in `module-model.ts` read `undefined` as "an undeclared global"
  or "holds no load", so refusing there was not fail-closed (round 1,
  finding 2). The export model's reading of a namespace's scope is
  registered as RWF-146 (backlog `BL-103`).
- **A regression of the first fix, caught before merge** (round 2): an
  `import x = require("m")` in a namespace, which TypeScript emits as
  nothing, was recorded as a binding and taken for a load -- a false
  `NOT_AFFECTED`. Only the entity-name form is recorded now
  (`audit2.import-require-in-a-namespace`).
- **Scope widened to the resolver's block-function model** (rounds 4 and
  5, RWF-147): a function declared in a nested block is refused for a use
  outside the block (strict code scopes it to the block; sloppy code's
  Annex B is not told apart, a cost), is found first for a use inside it,
  and a class static block is a var scope. Required: each was a route to
  the namespace member read `N.h` the task closes, and the same resolver
  rule; the plain-function form is fixed with it.
- **The escape row reads the new causes as "maybe the global"** in its two
  over-approximating questions (`mayBeUndeclaredGlobal`; rounds 2 and 5),
  and counts an ambient block's declarations as members.
- **Precision cost, measured**: seven `AFFECTED`s given up among the
  oracle cases (`cost.*`: a namespace with no accessor; an outer name, an
  import or a global used in a namespace's body; a script's namespace; a
  type-only import alias; two unexported nested namespaces grouped by name;
  an Annex B block function); twenty-eight of BL-095's cases declare their
  negative control inapplicable (their verdicts unchanged, BL-095's
  `control.*` still `NOT_AFFECTED`); four of 1,184 clean graph nodes on the
  TypeScript sources in `node_modules` (zod; few namespaces there). The
  JavaScript cost of the block-function rule is in the report.
- **The audit was not certified.** Five fresh-context rounds, each
  `BLOCKED` on live false `NOT_AFFECTED`s, every one pre-existing on the
  base except round 2's regression; all fixed. Round five's findings 1 to 4
  were fixed after it without a sixth round, as BL-095's round five was.
  Whether that is enough is the project owner's decision.
- **Registered, not fixed**: RWF-145's nested namespace and enum (masked;
  BL-102, with the enum member initializer note of round 4), RWF-146
  (BL-103), RWF-148 (a bodiless function declaration taken as a binding,
  live, BL-104).
