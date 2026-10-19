# BL-099 — A use of a namespace's exported member is a read of the namespace's object (RWF-141)

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-099
- **Branch**: `bl-099-namespace-export-member-read`
- **Base SHA**: `692b3651f850e51391bf4ba842bff1000c89a995` (BL-097's merge, PR #112)
- **Commits**: <!-- filled in by the last commit -->
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

- [ ] Every case in `tests/oracle/bl099-namespace-export-member-read.cases.ts`
      answers its `expected` verdict with real Node's ground truth, and every
      case whose `base` is `NOT_AFFECTED` while `called` is true failed on
      the base.
- [ ] The `control.*` cases stay `NOT_AFFECTED`.
- [ ] Each rule is pinned by a named unit test, and each mutation of it is
      caught by one.
- [ ] The graph, proof and verdict differentials are reported separately; no
      corpus case moves away from its expected verdict.
- [ ] RWF-141 and RWF-145 are recorded as fixed.
- [ ] The independent audit certifies the change, or its findings are
      handled per WORKFLOW § 1.5.

## Gates

The full set in `AGENTS.md` § I, unrelaxed, run once on the final HEAD with
`node scripts/gates.mjs`. `npm run test:validation`'s baseline is OPEN-DEBTS
D-09's six known failures; no change is expected.

## Report

In the format of `AGENTS.md` § J (`docs/WORKFLOW.md` § 5).
