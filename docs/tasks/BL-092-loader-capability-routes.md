# BL-092 — The loader capability seen only when spelled: `module.paths` through any route, `module.__proto__` (RWF-129, RWF-130)

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-092
- **Branch**: `bl-092-loader-capability-routes`
- **Base SHA**: `f3b1dcabf4b3f2c71fe3308e7be5407fb4030cb1` (BL-091's merge, PR #109)
- **Commits**:
  - `docs(tasks): BL-092 task file — the loader capability seen only when spelled`
  - `test(BL-092): the loader capability's unspelled routes against real Node — RWF-129, RWF-130, PRM-107, RWF-133, RWF-134, RWF-135`
  - `fix(BL-092): a Module instance's lookup list, prototype and inherited loaders are capabilities by what they are, and every write target is read — RWF-129, RWF-130, RWF-133, RWF-134, RWF-135`
  - (this commit) `docs(BL-092): records — RWF-129, RWF-130, PRM-107 in part, RWF-133..140, the independent audit's three rounds, ADR 0010 note, plan, debts, backlog (BL-096..098), progress, scorecard`
- **Superseded by**: —

## Project context

Lane C (ADR 0010, the capability-flow model; `src/code-intelligence/loader-constructs.ts`).
The module-load closure is family A's authority: a loaded file's whole-file
scan (`findClosureWideningConstructs`) must find every construct that can
change which file a later `require` loads, or the closure is called
complete and an instance it never contains is proven never loaded. The
same classifier gives the call graph its `unknown` edges
(`classifyClosureWideningCall`), which families B and C read.

BL-091's re-audit (round 3) found two live false `NOT_AFFECTED`s in the
classifier, both also `NOT_AFFECTED` on BL-091's base `5de4893`
(`tests/validation/FINDINGS.md`):

- **RWF-129**: `module.paths` is recognised only in its spelled forms
  (`module.paths = …`, `module.paths.<mutator>(…)`), through
  `isAmbientModulePathsArray`. An alias, a parameter,
  `Array.prototype.shift.call(module.paths)`, an element store, a
  destructuring store or an object holder changes the lookup unseen.
- **RWF-130**: `module.__proto__` is not a route to `Module.prototype`, so
  `module.__proto__.require = …` replaces every module's `require` unseen.

RWF-129 is the false-`NOT_AFFECTED` half of **PRM-107** (FINDINGS, lane C,
task C-4): `const p = module.paths; p.unshift(dir)` and
`Array.prototype.unshift.call(module.paths, dir)`. ADR 0010 § 3 and § 4
already decide the shape of the fix: any mutation of `module.paths` is
`loader_hook_mutation`; the read-only array methods (`slice`, `includes`,
`indexOf`) stay complete (the precision controls in
`module-load-closure.test.ts`); the `ARRAY_MUTATING_METHODS` split is kept
and extended to aliases. PRM-107's false-`AFFECTED` half (the `AFFECTED`
authority under a reachable loader mutation) is C-5's and stays open.

### Premises (AGENTS.md § D) — measured before relying on them

Measured on this task's base `f3b1dca` with the oracle harness against
real Node v22.11.0 (`tests/oracle/bl092-loader-capability-routes.cases.ts`,
every case's `base`):

- RWF-129's six reproductions are live false `NOT_AFFECTED`s. **Confirmed.**
- RWF-130's reproduction is live. **Confirmed**, and so are
  `module["__proto__"]` and `const P = module.__proto__`.
- The spelled forms answer `UNKNOWN`. **Confirmed** for `module.paths.splice`
  and `module.paths.length = 0; module.paths.push(…)`.
- PRM-107's two reproductions, rebuilt on this task's fixture, are live.
  **Confirmed.**
- Measured beside them, the same class, all live false `NOT_AFFECTED`s on
  the base, registered by this task:
  - `[module.paths[0]] = […]`, `({ paths: module.paths } = …)`,
    `for (module.paths[0] of …)`, `module.paths[0] += …`,
    `Object.assign(module.paths, …)`, `[module.paths]` and a returned
    `module.paths` (RWF-129's class, recorded under it);
  - `[Module._resolveFilename] = [hook]`: a destructuring assignment
    target is never checked against any capability receiver (RWF-133);
  - the CommonJS wrapper's own `arguments` (`arguments[2]` is `module`,
    `arguments[1]` is `require`), in a module with no `require` call of
    its own (RWF-134);
  - `const r = module.require; r(path)`: the instance's inherited
    `require`, held in an alias (RWF-135).
- A method call rooted in `module` (`module["paths"].shift()`,
  `module.paths.forEach(…)`, and the read-only `module.paths.slice()`) is
  already `UNKNOWN` on the base through the call graph's
  `moduleScopeCalleeReason` (`loader_capability_escape`), not through the
  closure. **Measured.**
- The repository's own `node_modules` (2,318 `.js` files) contains no
  `module.paths`, `require.main.paths` or `module.__proto__` use: the
  precision cost of failing closed on them is not measurable there.
  **Measured.**

## Task

### Problem

The loader classifier recognises the module system's lookup list and
`Module.prototype` by the spelling of the expression that reaches them,
not by the object they are. Every route it does not spell changes which
file a later `require` loads while the module-load closure stays complete,
so family A proves an instance never loaded that real Node loads and runs.

### Why it matters

Soundness: each reproduction is a live false `NOT_AFFECTED` (family A),
the critical failure, pre-existing on the base. Defect class A (a
capability recognised by its spelling rather than by the object it
names); the destructuring and compound-assignment targets are class B (a
store the classifier does not read is taken to store nothing).

### What to do

1. **Tests first**: the oracle cases above, each with E-1's loud fixture
   and both controls, failing on the base.
2. **`module.paths` as a capability**: `<a Module instance>.paths`
   (property or literal element access, through any alias) resolves to a
   capability kind of its own. It is a capability value (stored other than
   by a followable `const` alias, passed, returned, held in a composite:
   an escape) and a capability receiver (any write, delete or reflection
   mutation through it). A call of one of its methods is
   `loader_hook_mutation` for a mutating method, nothing for a reviewed
   read-only one, and `loader_capability_escape` for any other (a callback
   method hands the array to the callback). A member read through it is
   not a capability. Iterating it directly is a read.
3. **`module.__proto__`**: `<a Module instance>.__proto__` is
   `Module.prototype`.
4. **The instance's inherited loader members**: `<a Module instance>.require`,
   `.load` and `._compile` resolve to the inherited member, so an alias
   keeps its reason (`module_require`, `module_internal_load`,
   `vm_execution`, the reasons their spelled calls already get).
5. **Assignment targets**: every target an assignment writes — the left of
   any assignment operator, a destructuring pattern's targets at any depth,
   a `for…in` / `for…of` head, `++` / `--` — is checked as a write.
6. **The wrapper's `arguments`**: `arguments` with no enclosing non-arrow
   function is the CommonJS wrapper's, which holds `require` and `module`;
   it resolves to `ambiguous`, so any use fails closed.
7. **Mutations**, each caught by a named test.
8. **Records**: FINDINGS (RWF-129, RWF-130 fixed; PRM-107 fixed in part;
   RWF-133, RWF-134, RWF-135 registered and fixed), OPEN-DEBTS, ADR 0010
   (a note that C-4's `module.paths` item is done), backlog (C-4's row
   narrowed), progress, scorecard.
9. **Independent audit** (WORKFLOW § 1.5).

## Boundaries

### Do not touch

- The call graph's `moduleScopeCalleeReason` (a precision question: it
  already fails closed on every method call rooted in `module`).
- `module.parent` / `module.children` (RWF-065, `BL-040`).
- The `AFFECTED` authority under a reachable loader mutation (PRM-107's
  other half, C-5).
- C-2's lexical provenance and C-3's value-flow table (the classifier's
  same-name `const` lookup stays as it is).
- The escape row (`escape-row.ts`, BL-094 / BL-095).
- Other worktrees and branches.

### STOP conditions

- A fix that needs C-2's scope-aware provenance to be sound
  (`NEEDS_DECISION`).
- A precision cost on the validation or adversarial corpora (a verdict
  that moves away from its expected value), unless the moved case is
  itself wrong.
- An independent-audit finding outside the loader classifier.

## Acceptance criteria

- [ ] Every case in `tests/oracle/bl092-loader-capability-routes.cases.ts`
      answers its `expected` verdict, with real Node's ground truth and
      both controls, and every case whose `base` is `NOT_AFFECTED` failed
      on the base.
- [ ] The precision controls of `module-load-closure.test.ts`
      (`module.paths.slice()` / `.includes()` / `.indexOf()`,
      `module.exports` writes) stay green.
- [ ] Each new rule has a mutation caught by a named test.
- [ ] The graph, proof and verdict differentials are reported; no corpus
      case moves away from its expected verdict.
- [ ] RWF-129, RWF-130, RWF-133, RWF-134 and RWF-135 are fixed and
      recorded; PRM-107 is recorded as fixed in part.
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

- **Scope, by the independent audit** (three rounds, `CERTIFIED` at the
  last). Round 1 found two more live routes of this class, both fixed in
  this task: a same-name `const arguments` anywhere in the file switched
  the wrapper rule off (its finding 3; RWF-134's record), and a `with`
  head (its finding 4; `RWF-138`). Round 2 found that the first fix of
  finding 3 resolved every non-wrapper `arguments` to nothing, a false
  `NOT_AFFECTED` at that intermediate commit only (`audit2.*` cases), and
  that a `with (process)` head was still unseen; both fixed. What to do,
  item 6, therefore reads: the wrapper's `arguments` is decided before the
  whole-file shadow lookup, and any other `arguments` is resolved as an
  ordinary name. The cases file holds thirty-one real-Node cases, not the
  count the premises list implies.
- **Registered, not fixed** (outside this task's boundaries or needing a
  decision): `RWF-136` (the read-only exemptions assume Node's own
  `Array.prototype`; decision `BL-096`), `RWF-137` (the wrapper's
  `arguments` through a function's `caller`; `BL-097`), `RWF-139` (a
  concise arrow called on the spot; C-3), `RWF-140` (`process` handed on
  or wrapped; decision `BL-098`). The audit's finding 7
  (`process.mainModule.children[i]`) is a note on `BL-040`'s row.
- **"Any route" is bounded.** The `module_paths` and
  `module_instance_member` kinds are reached through what the relation
  follows: a same-file `const` looked up by name until C-2 (PRM-21,
  PRM-22; the audit's finding 6). The comments say so.
- **A premise this task first stated too strongly.** The comments on
  `MODULE_PATHS_READ_METHODS` and `isIteratedLookupList` said the read-only
  uses hand the list to nothing; that holds only for Node's own
  `Array.prototype` (RWF-136). Corrected before review.
- **Reason refinement in existing tests.** Three cases of
  `src/analysis/module-load-closure.test.ts` that asserted the generic
  `loader_capability_escape` for `module['require'](x)`, `const m =
  module; m.require(x)` and `globalThis.process.mainModule.require(x)` now
  assert `module_require`, the reason the spelled `module.require(x)`
  has: still closure-widening, now precise.
