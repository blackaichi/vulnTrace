# BL-105 — A TypeScript ES module's own export overwritten through its exports object (RWF-150)

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-105
- **Branch**: `bl-105-ts-esm-export-cast-alias-write`
- **Base SHA**: `05996e199996c3e4ad5223577b6d6dd132f983ec` (BL-100's merge, PR #114)
- **Commits**:
  - `docs(tasks): BL-105 task file — a TypeScript ES module's own export overwritten through its exports object`
  - `test(BL-105): a TypeScript ES module's own export overwritten through its exports object, against real Node — RWF-150`
  - `fix(BL-105): the export write set gates an ES module's own exports; casts and imports reach the census — RWF-150`
  - (this commit) `docs(BL-105): records — RWF-150 fixed, the independent audit's two rounds, debts, backlog (BL-106), progress, scorecard`
- **Superseded by**: —

## Project context

Lane E, the export write set (ADR 0009 § 1, § 2; task E-1). E-1's census
(`exportWriteSet`, `src/code-intelligence/module-model.ts`) decides which
CommonJS export bindings keep their attribution. A TypeScript ES module
compiled to CommonJS (`module: commonjs`) publishes its `export`
declarations as properties of the wrapper's `exports` object, and an
importer reads the property at each use (`(0, decs_1.dec)()`). A write the
module makes onto that object replaces what the importer reads
(`tests/validation/FINDINGS.md`, RWF-150, a live false `NOT_AFFECTED` and a
fabricated `AFFECTED` edge, pre-existing; found by task BL-100's
independent audit).

### Premises (AGENTS.md § D) — measured before relying on them

Measured with the repository's TypeScript 5.9.3 (`ts.transpileModule`,
target ES2020) and real Node v22.11.0, and with the oracle harness on the
base `05996e1` (`tests/oracle/bl105-ts-esm-export-overwrite.cases.ts`, each
case's `base`):

- RWF-150's decorator reproduction (`(exports as any).dec = …`) and its
  alias form (`const e: any = exports; e.dec = …`) are live false
  `NOT_AFFECTED`s. **Confirmed.**
- RWF-150's call form with the declared function calling the target and
  the overwrite not (`export function dec() { lib.parse(1); }
  (exports as any).dec = function () { lib.safe(1); }`) is a fabricated
  `AFFECTED`. **Confirmed.**
- **Narrower than the record**: the call forms whose OVERWRITE calls the
  target are `UNKNOWN` on the base, not `NOT_AFFECTED` — the stored
  function expression gets the escape row's possible edge
  (`possible_invocation`). The resolved edge from the importer to the
  declared function is in their graphs all the same (a fabricated edge).
  Recorded as `masked.*`.
- RWF-150's "plain `exports.dec = …` (no cast) is `UNKNOWN`": on the base
  it is `AFFECTED`, sound for that case (Node calls the overwrite). The
  plain write makes a CommonJS binding beside the ES one, and
  `mapExportsToFunctions` keeps the last binding of a name in model order:
  which value wins is the model's order, not the program's.
- **The cause, measured**: `applyExportWriteSet` returns at once unless
  the file has a CommonJS-syntax export binding, so the census never gates
  an ES-syntax binding; and the census classifies `exports` behind a cast
  as an un-enumerable reference, which only CommonJS bindings honour.
- **Found while measuring** (same mechanism, folded in): a module that
  imports itself (`import * as self from "./decs"`, `import self =
  require("./decs")`) holds its own exports object in the emit; a member
  write through it, through an alias of it, or the binding handed to a
  function, overwrites the export. Live false `NOT_AFFECTED`s on the base:
  the census accounts loads only as `require(…)` calls, and does not read
  a load's member write behind a cast.

## Task

### Problem

An ES module's own exports are never checked against the writes the file
makes onto its export objects, so an import binds to the declared value
whatever the file stores over it.

### Why it matters

Soundness: live false `NOT_AFFECTED`s (family C), the critical failure,
and a fabricated resolved edge with a false `AFFECTED`. Defect class A (an
import bound to a declaration whose export the module replaces) and class
C (the export's values collapsed to the declaration).

### What to do

1. **Tests first**: oracle cases against real Node, failing on the base,
   with the loud fixture `vuln-lib`; controls that keep their verdicts.
2. **The census gates ES exports** (`module-model.ts`): every ES export is
   withdrawn when the census meets an un-enumerable reference, a route
   handed on, a rebinding of `exports`, any `module.exports` write or an
   escaping load; otherwise each ES export whose name a write may set, and
   a CommonJS binding of a name an ES export also publishes. A withdrawn
   ES re-export keeps its specifier and forwards nothing
   (`export-forwarding.ts`).
3. **The census reads through TypeScript's value-preserving wrappers**
   (`as`, `<T>`, `!`, `satisfies`) on the export objects and on a load's
   member chain; a cast `module.exports` replacement no whole-module
   relation orders stays un-enumerable.
4. **Imports are loads**: a value import holds a load's result or a member
   of one (a member write through it is a write of its name), and an
   import that may reach back is confined or escapes, as a `require` is.
5. Unit tests pinning each rule, and mutations each caught by a named test.
6. Differentials (graph, proof, verdict) and validation against
   OPEN-DEBTS D-09.
7. Records: FINDINGS (RWF-150 fixed), OPEN-DEBTS, backlog, progress,
   scorecard.
8. Independent audit (WORKFLOW § 1.5).

## Boundaries

### Do not touch

- Writes by OTHER modules onto this module's exports (task E-4, RWF-108).
- Deciding whether a file runs as a real ES module or compiled to
  CommonJS: the withdrawal applies to both (a precision cost for a real ES
  module, never an invented binding).
- A namespace's declarations (BL-102, BL-103), a bodiless function
  declaration (BL-104), an ES5 class's methods (BL-101).
- Other worktrees and branches.

### STOP conditions

- A corpus verdict moves away from its expected value, unless the moved
  case is itself wrong.
- The precision cost on the corpora is large enough to be a product
  decision (`NEEDS_DECISION`).
- An independent-audit finding outside the export write set.

## Acceptance criteria

- [x] Every case in `tests/oracle/bl105-ts-esm-export-overwrite.cases.ts`
      answers its `expected` verdict with real Node's ground truth, and every
      case whose `base` differs from its `expected` failed on the base.
- [x] The `control.*` cases keep their verdicts.
- [x] Each rule is pinned by a named unit test, and each mutation of it is
      caught by one.
- [x] The graph, proof and verdict differentials are reported separately; no
      corpus case moves away from its expected verdict.
- [x] RWF-150 is recorded as fixed.
- [x] The independent audit certifies the change, or its findings are
      handled per WORKFLOW § 1.5.

## Gates

The full set in `AGENTS.md` § I, unrelaxed, run once on the final HEAD with
`node scripts/gates.mjs`. `npm run test:validation`'s baseline is OPEN-DEBTS
D-09's six known failures; no change is expected (to be measured: the
corpora are compiled JavaScript, where ES-syntax files run as real ES
modules).

## Report

In the format of `AGENTS.md` § J (`docs/WORKFLOW.md` § 5).

## Corrections

Appended at `READY_FOR_REVIEW`; the sections above are as written at the
start, except the commit list and the acceptance boxes.

- **The entrypoint root gap was introduced by this change and fixed in
  it.** The first corpus differential moved eight adversarial cases into
  `NOT_AFFECTED` (ADV-014, ADV-019, ADV-030, ADV2-017, ADV2-025, ADV2-037,
  ADV2-040, ADV2-042): a withdrawn ES export of an entrypoint lost its root
  and the derivation stayed complete. Two causes, both fixed: a withdrawn
  ES export is now a reported root gap (`entrypointRootCandidates`), and
  the module-graph query asks about import specifiers (`loadReachQuery`;
  without it every import "may reach back"). The final differentials are
  zero.
- **The independent audit, round 1: `BLOCKED`** on a write to a
  self-import's named binding (`import { dec as d2 } from "./decs"; d2 =
  …`, emitted `decs_1.dec = …`), pre-existing and inside the mechanism this
  task folded in: fixed (`importedNameOf`), with two oracle cases
  (`audit.*`) and unit tests. Its non-blocking findings: the precision cost
  of imports as loads, measured (four probes `AFFECTED` → `UNKNOWN`),
  registered as backlog `BL-106`; the oracle test's header copied from
  BL-099, fixed. **Round 2: `CERTIFIED`.**
- **Folded in, and why**: the self-import routes (`import * as self`,
  `import self = require`, a named binding written) are the same defect --
  the module's own export overwritten through an alias of its exports
  object -- and stayed live false `NOT_AFFECTED`s after the cast and alias
  fix.
- **Removed as unreachable**: `propertiesUnenumerable` in the ES gate
  (BL-084's routes need a whole-module value, which already withdraws every
  name), and the redundant cast unwrapping in `baseMayBeLoaded`
  (`valueMayBeLoaded` unwraps), each found as a mutation no test could
  catch.
