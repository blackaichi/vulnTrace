# E-1 — The `ExportWriteKind` write set; lexical identity; lexical computed-key constants

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: E-1
- **Branch**: e-1-export-write-set
- **Base SHA**: 07a61e86b916cc092d01257181cd64852640b280
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

First task of lane E (`docs/REMEDIATION-PLAN.md` § 5a, order 20;
ADR 0009 § 8's E-1 row). ADR 0009 § 1 states the invariant: an export is
attributed to a declaration only when the file's **complete write set** for
its name determines one effective write. E-1 builds that write set for
`module-model.ts` and gates `mapExportsToFunctions` on it; E-2 (forwarding
hops), E-3 (entrypoint roots), E-4 (writes by other modules) and E-5
(ESM→CommonJS default interop) consume it later.

What binds this task besides ADR 0009:

- ADR 0009's two decision records (BL-063's and BL-064's option (a),
  confirmed by the merges of PR #98 and PR #101): E-1's precision
  acceptance names the RWF-013 … RWF-028 controls **as BL-063 and BL-064
  left them**; a row either inverted stays inverted.
- `REMEDIATION-PLAN.md` § 5a, "What BL-064 binds": the write set must keep
  BL-064's window (an unproven evaluation between competing writes is an
  observation point, § 1 clause 4a).
- "What V-3 binds": the name-lookup census's `open` entries (PRM-26,
  `src/testing/name-lookup-census.ts`) are E-1's to remove, and the census
  fails until each removed lookup is deleted from it.
- ADR 0009 § 2: the closed `ExportWriteKind` union with an exhaustive
  `switch`, a form outside it un-enumerable by default; registration as
  `VT-INV-E-write-set` in `src/testing/foundation-invariants.ts`.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

The PRM records are from the September premise sweeps
(`docs/audits/2026-09-premise-sweep-round-{1,2}.md`), before A-5b, V-3,
BL-063 and BL-064. Each was re-measured end to end against real Node
(`tests/oracle/e1-export-write-set.cases.ts`; loud fixture, both controls
passing in every case):

- **Measured, still live (false `NOT_AFFECTED`, real Node calls the
  target): 25 shapes.** PRM-26 (a class method, a nested function, an
  `o.run = function` and, in an ES module, a class method named like the
  export before the real declaration: 4); PRM-27 (a later string key,
  getter, spread: 3); PRM-28 (a scope-blind computed-key constant: 2);
  PRM-29 (`this.run = …` in an exported or literal method called as a
  method: 2); PRM-30 (a later `module.exports.run =`, and `exports.run =`
  after `exports = module.exports = {…}`: 2); PRM-62 (an ES module `let`
  reassigned at module scope, in an exported function, and through an
  export list: 3); PRM-63 (`module["exports"].run =`, `const m = module;
  m.exports =`, `const e = exports; e.run =`, module-scope `this.run =`,
  `&&=`, a destructuring target, `exports` passed to a helper,
  `const api = module.exports; api.run =`, a self-`require` member write:
  9).
- **Measured, already `UNKNOWN` on the base** (closed by earlier tasks,
  kept as regression cases): PRM-29's deferred `exports.run =` writes (3),
  PRM-103's cyclic observer (BL-064's window), and PRM-63's
  `Object.assign`, `Object.defineProperty`, `Reflect.set` and
  `Object.freeze` shapes. A dynamic computed key after a plain one (PRM-27)
  is `UNKNOWN` too.
- **Measured, false `AFFECTED` (precision)**: `{ run: dangerousOp, "run":
  safeOp }` and `module.exports = { run: dangerousOp };
  module.exports.run = safeOp;` (real Node calls `safe`).
- **Measured**: `export const run = safeOp` in an ES module is not
  attributed at all (an identifier initializer); out of scope here.
- **Verified in the code**: V-3's lexical resolver (`declaredRootAt`,
  `lexicalDeclarationOf`) already resolves a name from an export's own
  site to one declaration and refuses a name the file assigns anywhere; the
  name `find` in `mapExportsToFunctions` is the only consumer still
  resolving by spelling.
- **Assumed, to be measured**: the precision cost of the un-enumerable
  writer census on real `node_modules` (TypeScript's `__exportStar(…,
  exports)` hands the exports object to a helper).

## Task

### Problem

`module-model.ts` attributes an export to the write it happened to look at
(the first function of the local's name, the literal's identifier key, the
first `const` of a computed key's name, the literal over a later member
write, the dotted spellings only), so a write it did not enumerate, or did
not order, leaves a stale attribution and family C certifies a search of
the wrong function.

### Why it matters

Soundness: 25 live false `NOT_AFFECTED`s (family C). Defect classes A
(PRM-26, PRM-28: a name matched by spelling, not by binding) and C (every
other shape: an export that can hold several values collapsed to one).

### What to do

1. Commit the real-Node reproductions first
   (`tests/oracle/e1-export-write-set.{cases,test}.ts`), asserting the
   sound verdict, and show them failing on the base.
2. **Lexical identity (PRM-26, PRM-62).** `mapExportsToFunctions` resolves
   an export's `localName` through `declaredRootAt` from the export's own
   site, never by `index.functions.find(fn.name === …)`; remove the census
   entries that lookup carried.
3. **The literal rule (PRM-27; ADR 0009 § 4).** Unpack identifier, string
   and numeric keys and lexically resolved computed keys; per name the last
   plain definition wins; a getter or setter of the name, or a spread or
   un-resolvable computed key after its last definition, withdraws it; a
   `__proto__:` property is no export.
4. **Lexical computed-key constants (PRM-28).** A computed key's identifier
   resolves through `lexicalDeclarationOf` to one `const` initialized to a
   string or numeric literal, declared before the key.
5. **The write set (PRM-29, PRM-30, PRM-63).** A per-file census of every
   reference to the ambient `exports`, `module` and `require`, module-scope
   `this`, and `this` in any non-arrow function, each classified by a
   closed `ExportWriteKind` union with an exhaustive `switch`; anything
   outside it is `unenumerable`. Then, per CommonJS name: a write of the
   name that is not a plain module-scope `=` (compound, logical,
   destructuring, `delete`, `Object.defineProperty`, a method's `this`
   write, a `require(…)` result's member write, a deferred write) withdraws
   it; the effective write is the last module-scope write to the FINAL
   export object (the object installed by the authoritative
   `module.exports = X`, with `exports` tracked through top-level
   rebindings); a write to a stale object is ignored for attribution; an
   un-enumerable reference withdraws every name of the file.
6. **ES modules (PRM-62).** An exported local binding the file assigns
   anywhere is withdrawn (`exportAttributionWithdrawn`).
7. Keep BL-064's window, BL-063's cutoff and every RWF-013 … RWF-028
   control as they stand.
8. Register `VT-INV-E-write-set`; measure the precision cost on the corpora
   and on real `node_modules`; update the records.

## Boundaries

### Do not touch

- `export-forwarding.ts` (E-2), `entrypointRootCandidates`'s requirement
  logic (E-3), `commonjs-reexports.ts`'s origins and `symbol-binder.ts`
  (E-4), ESM→CommonJS default interop (E-5); a write to ANOTHER module's
  object is E-4's.
- The cutoff (`mayEndModuleEvaluation`) and the completion grammar.
- Other tasks' worktrees.

### STOP conditions

- A precision acceptance control (ADR 0009 § 8, as BL-063 and BL-064 left
  it) can only stay green by keeping one of the 25 shapes unsound.
- The un-enumerable census's measured precision cost on the corpora moves a
  validation verdict, or is large enough on real `node_modules` that a
  narrower rule needs an owner decision.
- A premise above proves false in a way that changes scope.

## Acceptance criteria

- [ ] Every one of the 25 live shapes asserts `UNKNOWN` or the correct
      `AFFECTED`, with real Node's ground truth, failing on the base.
- [ ] The already-sound shapes and the precision controls keep their
      sound verdicts.
- [ ] `mapExportsToFunctions` resolves no export by name; the census has no
      `open` PRM-26 entry left.
- [ ] `ExportWriteKind` is a closed union consumed by an exhaustive
      `switch`; a reference outside it is un-enumerable.
- [ ] `VT-INV-E-write-set` is registered with its owning tests.
- [ ] Every RWF-013 … RWF-028 control, the P1-A2 and RWF-003 "LAST write"
      tests and the `{ bail, bail: safeFn }` fixture stay green (as BL-063
      and BL-064 left them).
- [ ] Graph, proof and verdict differentials reported separately; the
      validation suite matches the D-09 baseline case by case.
- [ ] The independent audit certifies the change.

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Expected: the oracle
suite gains the E-1 cases; `test:validation` keeps exactly the five known
failures (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`).

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5).
Task-specific: the per-shape base and head verdicts, and the measured
precision cost (corpora and `node_modules`).
