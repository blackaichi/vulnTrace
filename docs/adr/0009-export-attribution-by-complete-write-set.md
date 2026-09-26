# ADR 0009 — An Export Is Attributed Only When Its Complete Write Set Has One Effective Write

Lane E of [`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md). Status:
**proposed** (design only; nothing here is implemented).

## Context

`src/code-intelligence/module-model.ts` answers "which function does export
`x` of this file denote?", and `export-forwarding.ts` and
`commonjs-reexports.ts` answer "which other module's export does it
forward?". Those answers become call-graph edges (`exportNameToNodeId`) and
vulnerable-target nodes. A wrong answer is a **resolved** edge or target:
it displaces the honest `unresolved_target` and lets family C certify a
search of the wrong function. Reproduced:

| Finding | Shape the model got wrong |
| --- | --- |
| PRM-26 | `mapExportsToFunctions` takes the first indexed function with the export's local *name* (a class method, a nested function, an `obj.x = function(){}`) |
| PRM-27 | a later string-literal key or getter for the same name in the exported literal is ignored; the earlier value stays published |
| PRM-28 | a computed key's constant resolved by whole-file first match |
| PRM-29 | a write deferred into a function, or a configure-time call, ignored ("last write in source order") |
| PRM-30 | `module.exports = { run: a }` then `module.exports.run = b`: literal unpacking wins |
| PRM-31 | an entrypoint root requirement satisfied by any node with the export's *name* (a decoy) |
| PRM-32 | `this.run = …` and `const api = module.exports; api.run = …` at an entrypoint are invisible, so the root set is empty and "complete" |
| PRM-61 | the forwarding hop takes the *first* own binding while Node keeps the value on the final `module.exports` object (stale `exports`) |
| PRM-62 | an ESM `export let` reassigned later keeps its initializer's attribution |
| PRM-63 | `module["exports"].run = …`, `const m = module; m.exports = …`, `Object.assign(module.exports, …)`, `module.exports["run"] = …` (four of eight bracket/alias shapes) |
| PRM-103 | a cyclic importer observes an *intermediate* export value; "last write wins" is false for it |
| PRM-11 | a re-export origin ignores a property write on the required source object (RWF-047 on the re-export surface) |
| RWF-047 (D-16) | `mod.run = patched` on a require-bound module object keeps the static attribution |
| AUD-13 | ESM→CJS default interop (independent audit; the report is not in the repository, so the shape is taken from its one-line summary) |

Every one is an instance of one assumption: **the write the model looked at
is the only write that matters**. Which write it looked at varies (the
first, the last in source order, the one in the literal, the one on the
dotted spelling), but the assumption is the same.

## Decision

### 1. The invariant

> **E.** For each module file, the export model computes the **complete
> write set** of every export name: every syntactic form that can write a
> property of that module's export object, or replace it, anywhere in the
> file (including inside functions and after `require` calls that can
> re-enter this module), plus every write the file cannot enumerate. An
> export `x` is attributed to a declaration **only if** its write set has
> exactly one member, that member is unconditional at module scope, it
> denotes exactly one declaration by lexical identity, and the file has no
> un-enumerable export writer. Otherwise attribution is withdrawn for `x`
> (or for every name, when the un-enumerable writer can reach any name).
> The same write set gates the forwarding hop and the entrypoint root
> requirement.

The same rule covers writes *from other modules* for the two shapes the
analyzer can see: a member write on a require/import-bound module object
(RWF-047) and a property write on a re-export source (PRM-11) withdraw the
target module's attribution for that name, or the forwarding origin.

Mechanically: `exportWriteSet(file): Map<name, WriteSite[]> & { unenumerable: boolean }`
is total over a closed `ExportWriteKind` union, and `mapExportsToFunctions`,
`commonJsExportForwardingHop`, `esmExportForwardingHop`,
`commonjs-reexports` origins and `entrypointRootCandidates` all consult it.

### 2. Enforcement and the structural gate

Where: `module-model.ts` (`buildExportBindings`, `mapExportsToFunctions`,
`unpackObjectLiteralExports`, `resolveComputedPropertyNameLiteral`,
`entrypointRootCandidates`), `export-forwarding.ts`,
`commonjs-reexports.ts`.

Structural gates:

- **A closed `ExportWriteKind` union** with an exhaustive `switch`. The
  positive enumeration, each a row with a fixture and a real-Node oracle:
  `exports.x =`, `exports["x"] =`, `module.exports.x =`,
  `module.exports["x"] =`, `module["exports"]…`, `module.exports = <literal>`
  (each key form: identifier, string, numeric, computed-constant,
  computed-dynamic, shorthand, method, getter, setter, spread),
  `module.exports = <non-literal>`, `exports = …` rebinding,
  `Object.assign|defineProperty|defineProperties|setPrototypeOf(target, …)`
  and `Reflect.set|defineProperty` with `target` ∈ {`exports`,
  `module.exports`, `module`, module-scope `this`}, module-scope
  `this.x =`, aliases of `module`, `exports`, `module.exports`, writes
  inside any function body, ESM `export let|var` reassigned, ESM
  `export { local }` of a reassigned binding, and a write that follows a
  `require` of a file that can require this one back. A form outside the
  union is `unenumerable` by the type's default.
- **A write-set grammar sweep**, extending `tests/binding-grammar/` with the
  producing side: every row above crossed with the consuming forms the call
  graph resolves (`lib.x()`, destructured `x()`, forwarded re-export),
  asserting either attribution to the declaration Node actually calls or
  `UNKNOWN`. Any row whose attribution disagrees with Node fails.
- **The name-keyed-lookup census** from ADR 0011 covers
  `module-model.ts:6004` (the PRM-26 `find` by name); this lane removes it
  in favour of lexical identity.
- Registered in `src/testing/foundation-invariants.ts` as
  `VT-INV-E-write-set`.

### 3. Fail-closed default

Withdrawn attribution is the existing `exportAttributionWithdrawn` flag,
which already yields `unresolved_target` / `vulnerable_target_unresolved`
(category `identity_unresolved`). At an entrypoint, an un-enumerable
writer is root incompleteness with the existing reason
`unresolved_export_forwarding`, and a requirement that no identity
witnesses is `unresolved_entrypoint_root_candidate`. No new category, no new
reason token.

### 4. Modeled exceptions that keep precision

- **`exports = module.exports = X`** is not a stale rebinding: both names
  denote `X` afterwards. It is recognised as one whole-module write.
- **Duplicate keys inside one object literal** (`{ bail, bail: safeFn }`,
  or `{ run: a, "run": b }`) are one effective write when every definition
  of the name in that literal is a plain value property the model can read
  (identifier or string key, no spread, no computed-dynamic key, no
  accessor): the literal's text fixes evaluation order and the last one
  wins, which is the RWF-042 rule `findObjectLiteralPropertyValue` already
  applies. A getter or setter among them, or a spread anywhere in the
  literal, withdraws the name (PRM-27's getter shape).
- **A whole-module function with attached properties**
  (`module.exports = fn; module.exports.helper = h;`) has one write per
  name; nothing is withdrawn.
- **Computed keys with a lexically resolved constant** (`const NAME = "x";
  module.exports = { [NAME]: impl }`) are enumerable. The prototype
  withdrew them and regressed ADV2-028; resolving the constant by lexical
  binding (the fix for PRM-28) removes that regression.
- **A cyclic `require` that cannot reach back** (the required file has no
  static path back to this one in the module graph) does not split the
  write set; only a `require` that can re-enter counts.
- **Roots may still widen by name** (RWF-021's asymmetry is kept): a
  name-only fallback may *add* a root, but may never *witness* that a root
  requirement materialized.

### 5. Precision cost

**Measured** with a throwaway prototype in a scratch clone outside the
repository (never committed), at `62b52b9`. The prototype's rule is
deliberately cruder than the invariant: any export name with more than one
write site, or any file with an un-enumerable writer (including computed
keys it did not try to resolve), is withdrawn; the local function must be
the only one of its name in the file; the forwarding hop consults the same
count; an entrypoint root requirement is not satisfiable by name; an
un-enumerable writer at an entrypoint is root incompleteness.

| Measure | Result |
| --- | --- |
| adversarial scenarios | **1 / 122** changed: ADV2-028 `AFFECTED → UNKNOWN`, caused by the prototype not resolving `[NAME]` for a module-scope `const NAME`; § 4's lexical constant rule removes it |
| validation cases (live OSV) | **0 / 17** changed |
| validation findings (all 85, every advisory × instance, not only the case's selected one) | **0 / 85** changed |
| targeted reproductions | 19 of 20 flip to `UNKNOWN`; PRM-11 (RWF-047's re-export surface) does not, because the prototype did not touch `commonjs-reexports.ts` (task E-4) |
| costs visible in controls | the whole-module cyclic-observer *positive* control also becomes `UNKNOWN` (the write set is genuinely split); the entrypoint-decoy *negative* control becomes `UNKNOWN` |
| wall time | no material change (validation suite 138 s vs 115 s baseline, within run-to-run noise of the other prototypes) |

### 6. Reopened certified behaviour

| Certified decision | Where | Reopened because |
| --- | --- | --- |
| RWF-011/P1-A: "Dropping the fallback costs nothing that had provenance" (the remaining name `find`) | `module-model.ts:5992-6006` | PRM-26 |
| TASK-017/VT-217: literal unpacking skips spreads and computed keys "intentionally", and a computed key is resolved "via a same-file `const`" | `module-model.ts:4684-4736, 4885-4886` | PRM-27, PRM-28 |
| RWF-014/013: "Last-write-wins is Node's real semantics for straight-line module-scope code" | `module-model.ts:437-442, 536-541, 4638-4645` | PRM-29, PRM-30, PRM-103 |
| RWF-021 root selection: "an extra root can only make more code reachable" (the name fallback also *witnesses* materialization) | `module-model.ts:5767-5779` with `verdict.ts:1186-1201` | PRM-31 |
| RWF-003 whole-module collection: "Every `module.exports = X` … write in the file" | `module-model.ts:4506-4550` | PRM-32, PRM-63 |
| P1-A1 forwarding hop, first own binding | `export-forwarding.ts:92-113` | PRM-61 |
| RWF-004a/b: "Property mutation (`x.y = ...`) is excluded: it changes the object, not the binding" | `commonjs-reexports.ts:120-121, 427-430` | PRM-11, RWF-047 |

### 7. Interaction with the proof families and RWF-002

- **Family C** needs "a resolved, attributed target"; withdrawal makes the
  target `vulnerable_target_unresolved` when the vulnerable export itself is
  split, and turns the consumer's edge into `unresolved_target` when a
  *pass-through* export is split. Both block family C: that is the fix.
- **Family A** is unaffected: loading does not depend on attribution.
- **Family B** is unaffected in its premise; its graph-absence input
  becomes more honest when a mis-attributed edge no longer drags a
  different instance into the graph.
- **AFFECTED**: a withdrawn attribution can no longer produce the
  pass-through false `AFFECTED` that PRM-61's second shape showed.
- **RWF-002**: the new `unresolved_target` edges sit *on the path* to the
  target (they are the pass-through), so target-relevant completeness will
  correctly keep them relevant. They are the right kind of `UNKNOWN`.

### 8. Implementation tasks, in order

| Task | Scope | Reproductions that flip | Existing tests that change |
| --- | --- | --- | --- |
| **E-1** the `ExportWriteKind` write set; gate `mapExportsToFunctions` on it; lexical identity instead of the name `find`; lexical computed-key constants | `module-model.ts` | PRM-26, 27, 28, 29, 30, 62, 63, 103 (and ADV2-028 stays `AFFECTED`) | `module-model.*.test.ts` suites that assert attribution for a name written by two *different* statements; the `{ bail, bail: safeFn }` fixture in `fixtures/commonjs-invocation-provenance-soundness` must stay green (one literal, § 4) and becomes the exception's named test |
| **E-2** forwarding hops consult the write set | `export-forwarding.ts`, `call-graph.ts` consumer unchanged | PRM-61 (both shapes, and its false `AFFECTED`) | `call-graph.commonjs-reexport.test.ts`, `call-graph.cross-package-reexport.test.ts` cases with a stale `exports` write |
| **E-3** entrypoint roots: write set gates root requirements; name fallback may widen but not witness | `module-model.ts` `entrypointRootCandidates` (coordinate with V-3 in `verdict.ts`) | PRM-31, PRM-32 | `verdict.entrypoint-root-*.test.ts` cases whose requirement is witnessed only by name |
| **E-4** writes by other modules: member writes on module objects and on re-export sources | `commonjs-reexports.ts`, `symbol-binder.ts` consumer (after lane A's A-5) | RWF-047 (D-16), PRM-11 | the RWF-047 open-defect records in `src/analysis/require-member-write-widening.integration.test.ts` flip from recorded-disagreement to passing |
| **E-5** AUD-13 ESM→CJS default interop | `module-model.ts` ESM consumer of a CJS default | AUD-13 (reproduction to be taken from the audit report) | to be determined from the audit report |

## Rationale

Every export-model defect found so far picked *one* write and trusted it.
Enumerating *all* writes is a closed, syntax-level question (the
`ExportWriteKind` union), and "attribute only when there is one" is the
simplest rule that is obviously sound. The measured cost is one adversarial
case, and that one is a prototype shortcut the design removes.

## Consequence

Attribution becomes rarer on files that write an export more than once,
and exactly as precise as today on files that write each export once, which
is the measured corpus. The binding-grammar suite gains a producing side.
