# ADR 0009 — An Export Is Attributed Only When Its Complete Write Set Determines One Effective Write

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
> file (including inside functions), each write tagged with **which export
> object it targets** (the original `exports`/`module.exports` object, or
> the object a later `module.exports = …` installed), plus a flag for any
> write the file cannot enumerate. An export `x` is attributed to a
> declaration **only if** the write set **determines one effective write**:
>
> 1. the set is complete for `x` (no un-enumerable writer can reach `x`);
> 2. every write of `x` to the *final* export object is at module scope,
>    so none can run after module evaluation completes (a write inside a
>    function body, or an ESM `let`/`var` export assigned anywhere, is a
>    competing write that may run later);
> 3. the existing straight-line and abrupt-completion machinery (RWF-013 …
>    RWF-028, `isDefinitelyReachedExportAssignment` and the cutoff
>    predicates) selects a unique last write that definitely runs;
> 4. no **observation point** lies between the first and the last
>    competing write: a `require`/`import` that can re-enter this module,
>    or a call that receives or closes over the export object;
> 5. the effective write denotes exactly one declaration by lexical
>    identity (never by name).
>
> Otherwise attribution is withdrawn for `x` (or for every name, when the
> un-enumerable writer can reach any name). Writes to a *stale* export
> object (after `module.exports` was replaced) are not writes of the final
> export and are ignored for attribution but never for forwarding hops
> that read them. The same determination gates the forwarding hop and the
> entrypoint root requirement.

This keeps what the RWF-013 … RWF-028 work established (a module that
writes an export several times in straight-line code, with the last write
definitely reached, is attributed to that last write) and closes the four
gaps the reproductions share: an **incomplete** write set (bracket, alias,
`Object.assign`, deferred and foreign writes), writes to a **stale** export
object, an **observation point** between writes, and attribution **by
name**.

The same rule covers writes *from other modules* for the two shapes the
analyzer can see: a member write on a require/import-bound module object
(RWF-047) and a property write on a re-export source (PRM-11) withdraw the
target module's attribution for that name, or the forwarding origin.

Mechanically: `exportWriteSet(file): Map<name, WriteSite[]> & { unenumerable: boolean }`,
each `WriteSite` carrying its target object and whether it is at module
scope, is total over a closed `ExportWriteKind` union, and `mapExportsToFunctions`,
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
| the repository's own suite (`npx vitest run`, 4,480 tests) | **303 failures**, in 27 files, almost all "keeps authority / keeps the later export attributable" controls of the RWF-013 … RWF-028 abrupt-completion suites and the P1-A2 / RWF-003 "binds the LAST write" tests |

**What the unit result means.** The prototype withdrew every name written
more than once. The repository's suites prove that rule wrong in the
precise direction: a straight-line module that writes an export several
times, with the last write definitely reached, is correctly attributed to
the last write, and 303 tests pin exactly that. The invariant in § 1 was
revised because of this measurement: it keeps that machinery (clause 3) and
withdraws only on the four gaps the reproductions share (incomplete write
set, stale object, observation point, attribution by name). The revised
rule withdraws **strictly fewer** names than the prototype did, so the
prototype's corpus results (1 / 122, 0 / 17, 0 / 85) are an **upper
bound** on the designed rule's cost, and the 303 controls become E-1's
precision acceptance: they must all stay green.

### 6. Reopened certified behaviour

| Certified decision | Where | Reopened because |
| --- | --- | --- |
| RWF-011/P1-A: "Dropping the fallback costs nothing that had provenance" (the remaining name `find`) | `module-model.ts:5992-6006` | PRM-26 |
| TASK-017/VT-217: literal unpacking skips spreads and computed keys "intentionally", and a computed key is resolved "via a same-file `const`" | `module-model.ts:4684-4736, 4885-4886` | PRM-27, PRM-28 |
| RWF-014/013: "Last-write-wins is Node's real semantics for straight-line module-scope code" — reopened **narrowly**: last-write-wins is kept for a complete write set with no deferred writes and no observation point between writes; it is withdrawn otherwise | `module-model.ts:437-442, 536-541, 4638-4645` | PRM-29 (deferred write), PRM-30 (write the model did not enumerate), PRM-103 (re-entrant observer) |
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
| **E-1** the `ExportWriteKind` write set; gate `mapExportsToFunctions` on it; lexical identity instead of the name `find`; lexical computed-key constants | `module-model.ts` | PRM-26, 27, 28, 29, 30, 62, 63, 103 (and ADV2-028 stays `AFFECTED`) | **must stay green** (precision acceptance): every RWF-013 … RWF-028 "keeps authority / keeps the later export attributable" control (`module-model.definitely-abrupt-expression-evaluation.test.ts`, `…destructuring-assignment-target-reassignment…`, `…invalid-class-heritage-value…`, `…multipath-class-definition-completion…`, `…class-heritage-throwing-call…`, `…computed-object-literal-key…`, `…computed-class-key…`, `…static-field…`, `…conditional-whole-module-export…`, `…early-exit-whole-module-export…` and their `verdict.*.integration.test.ts` counterparts), the P1-A2 "binds the LAST write" tests, RWF-003's "takes the LAST module-scope assignment", and the `{ bail, bail: safeFn }` fixture in `fixtures/commonjs-invocation-provenance-soundness` (the prototype failed 303 of these; the revised § 1 keeps them). **Expected to change**: tests asserting attribution despite a deferred write, a stale-object write, or an intervening re-entrant `require` (none found by the unit run beyond the reproductions) |
| **E-2** forwarding hops consult the write set (final-object writes only) | `export-forwarding.ts`, `call-graph.ts` consumer unchanged | PRM-61 (both shapes, and its false `AFFECTED`) | `export-forwarding.test.ts` "forwards the LAST of duplicate export writes, never the stale first" and `verdict.target-side-reexport.integration.test.ts` "resolves a duplicated export to the LAST write" must stay green (the prototype failed both) |
| **E-3** entrypoint roots: write set gates root requirements; name fallback may widen but not witness | `module-model.ts` `entrypointRootCandidates` (coordinate with V-3 in `verdict.ts`) | PRM-31, PRM-32 | `verdict.entrypoint-root-*.test.ts` cases whose requirement is witnessed only by name |
| **E-4** writes by other modules: member writes on module objects and on re-export sources | `commonjs-reexports.ts`, `symbol-binder.ts` consumer (after lane A's A-5) | RWF-047 (D-16), PRM-11 | the RWF-047 open-defect records in `src/analysis/require-member-write-widening.integration.test.ts` flip from recorded-disagreement to passing |
| **E-5** AUD-13 ESM→CJS default interop | `module-model.ts` ESM consumer of a CJS default | AUD-13 (reproduction to be taken from the audit report) | to be determined from the audit report |

## Decision record — E-1's precision acceptance after BL-063 (taken by task BL-063, 2026-10-12; the project owner confirms it by merging, or drops it)

**What was found.** Task RWF-050-repro reproduced RWF-050 against real
Node: a definitely-abrupt call in a MAY-evaluated module-time position
(`FLAG && bail();`, a conditional arm, a logical assignment's right-hand
side, an optional-chain-guarded argument, a `do`/`while` condition, a
`for` incrementor) was not a module-evaluation cutoff, a live false
`NOT_AFFECTED`. § 8's E-1 row lists every RWF-013 … RWF-028 "keeps
authority / keeps the later export attributable" control as **must stay
green**. That list included the MAY rows, which assert the unsound
attribution (FINDINGS RWF-050, correction 3).

**The decision.** Option (a) of `docs/REMEDIATION-PLAN.md` § 5a,
"RWF-050-repro additions": `BL-063` is ordered before E-1 and fixes
RWF-050 under clause 3 (the cutoff is MAY for expressions as for
statements), and § 8's E-1 precision acceptance names those controls **as
they stand after `BL-063`**: a row BL-063 inverted (it now asserts that
authority is withdrawn) must stay as BL-063 left it, and is not a
precision regression for E-1 to restore. The project owner gave the go
for BL-063 without choosing between (a) and (b) (a separate amendment
task); BL-063 took the recommended option, said so in its pull request,
and the record can be dropped without touching the fix.

## Amendment — § 1 clause 4 extended to every evaluation between competing writes (task BL-064, 2026-10-13)

**What was found.** RWF-094 (found by BL-063, reproduced against real
Node): a module-time statement that MAY throw through anything no proof
reaches (`maybe(FLAG)`, `JSON.parse(...)`, a construction running a
throwing field, a getter read) between two writes of an export left the
earlier write published, and a module already holding the exports object
called it; the analyzer kept the later write and answered `NOT_AFFECTED`
(family C). Clause 3 decides only what the abrupt-completion machinery
PROVES; clause 4 named an observation point only BETWEEN the writes. BL-064
measured that the observation needs no cycle: a child module the file
required BEFORE both writes reads the earlier value through
`module.parent.exports` after the load throws.

**The amendment.** Clause 4 reads, in addition:

> 4a. when this file's `module` or exports object can be observed at all
> (the file references `require`, a dynamic `import()`, `eval`, the
> wrapper's `arguments`, module-scope `this`, or `module`/`exports` other
> than as the base of an export write target), every evaluation between
> the completion of the FIRST competing write of `x` and the completion of
> the LAST is proven to complete normally, by a closed grammar. A
> competing write is a write of `x` the file spells, or a whole-module
> write whose value can carry `x`; a write of a provable primitive is not
> one; a deferred one (inside a function body) opens the window at the
> start of the file.

When nothing can observe the objects, Node deletes a failed module from
`require.cache` and from its parent's `module.children`, and a re-require
evaluates it afresh (measured), so the last write stays authoritative
exactly as before. The grammar, the census and the competing-write rules
are `competingWritesCannotBeObservedApart` and its helpers in
`module-model.ts`; anything outside the grammar withdraws attribution
(`UNKNOWN`), never grants it. When code in the file may tamper with the
export objects or the prototypes and may have run before the last write,
every window withdraws; a refused whole-module write also withdraws every
property write whose name it can carry (RWF-100). Writers the file does not spell (aliases,
parameters, `Object.assign`/`defineProperty`, other modules, stale export
objects) stay clause 1's un-enumerable writers, E-1's.

## Decision record — option (a) for RWF-094 (taken by task BL-064, 2026-10-13; the project owner confirms it by merging, or drops it)

**The choice.** The project owner was offered (a) this amendment, (b)
narrow point fixes (a multi-path completion proof for a local callee, a
proof for an abrupt instance field) that leave builtins and dependency
calls between competing writes a live false `NOT_AFFECTED`, or (c) folding
the question into E-1; (a) was recommended, and the owner gave the go
without choosing. BL-064 took (a), as BL-063 did for its own record.

**The precision acceptance it binds.** Measured by
`scripts/bl064-competing-write-window-corpus.mjs` against the base: of
8,659 CommonJS export bindings in `node_modules`, 93 lose attribution
(ajv's TypeScript-emitted entries, debug, zod, fast-uri, find-up,
ignore); 9 of 441 in the validation corpus (RWB-08's `debug`, none on its
finding's path); 1 of 213 in adversarial v2; 10 of 568 in `fixtures/` (the
duplicate-write and heritage fixtures). The corpus
differential is zero on graph, proof and verdict. Eight hermetic tests and
four oracle controls that asserted attribution across an unproven
statement between competing writes now assert the withdrawal: as with
BL-063's record, E-1's precision acceptance names those controls as BL-064
left them, and restoring one is not a precision regression for E-1 to
repair. Dropping this record means reverting the amendment, which reopens
RWF-094.

## Decision record — E-1's precision acceptance (taken by task E-1, 2026-10-14; the project owner confirms it by merging, or drops it)

**What E-1 implements.** § 1 and § 2 as written: `mapExportsToFunctions`
resolves an export's local by the one declaration it binds to at the
export's site; every reference the file makes to its export objects is
classified by the closed `ExportWriteKind` union, and a reference outside
it withdraws every name of the file; § 4's literal rule as written,
including "a spread anywhere in the literal withdraws the name" (the
narrower "after the name's last definition" in E-1's task file is sound,
`{ ...defaults, run: safe }` publishes `safe`, but this ADR decides, and
E-1 implements the ADR). Its independent audit blocked three rounds; the
first on eight more live false `NOT_AFFECTED`s, every one pre-existing (a
self-load reaching the exports object other than as `require(…).x =`,
`module.parent.children`, `instanceof` and loose equality and template
coercion of an export object); the fixes widen the un-enumerable census:
a load that may load this file is an alias of its exports object, `module`
members are an allow-list, writes to builtin prototypes, `__proto__` writes
on an export object, `__defineGetter__`/`__defineSetter__`,
`process.mainModule` and the `module` builtin are un-enumerable. The
second round measured nine more (a member write through ANY load's result,
which a cycle can hand back; a builtin reader the file replaces;
`process` through an alias or the global object), fixed; the third found
RWF-103 and RWF-104, pre-existing classes this record does not decide.

**The precision acceptance it binds.** Measured by
`scripts/e1-export-write-set-corpus.mjs` against the base: of 5,391
attributed CommonJS and ES-module exports in `node_modules`, 211 lose
attribution (193 because the whole file withdraws: chiefly zod's
`v3/types.cjs`, `@eslint-community/eslint-utils`, rollup and vite-node,
where a class method hands its `this` on, or the file loads the `module`
builtin), 3 are gained, and 107 move to a different function (the name
`find` had landed on a same-named decoy); 3 of 198 in the validation
corpus (no validation verdict moves); 12 of 290 in adversarial v2; 1 of
420 in `fixtures/`; 0 of 75 in adversarial v1. The corpus differential:
verdict 10 changed, **0 into `NOT_AFFECTED`**, all ten the secondary
finding on `vt2-holder`'s own nested `vt2-vuln-lib` in the loader-capability
cases ADV2-054, 055, 057–062, 064 and 066, `AFFECTED` → `UNKNOWN`: each holder
evaluates code no census reads with its own `module` in scope
(`module._compile`), installs a resolve hook, hands Node's `Module` out, or
references `process.mainModule` (ADV2-064 through an alias of `process`),
any of which can replace `module.exports.useHolder` after the static
write. Nine of the ten cases
already expect `UNKNOWN` for their selected (top-level) finding.

**ADV2-055 under the export write set.** Its selected finding was the
nested instance, expected `AFFECTED` for ADV2-054's loader-detection
purpose; it now expects `UNKNOWN`, with the reason in
`tests/adversarial/v2/expected.json`: `vt2-holder`'s top-level
`module._compile(code, __filename)` evaluates code no census can read, as
`vt2-holder`, with its `module` in scope, so no write of `useHolder` is
established. ADV2-057's withdrawal (`process.mainModule.paths.unshift(…)`
reads only `paths`) is sound but coarser than necessary: narrowing it, and
the class-method `this` hand-off that causes most of the `node_modules`
cost, is backlog `BL-072`. Dropping this record means narrowing the census
before merging, which reopens the shapes it closes until a narrower rule is
audited.

## Implementation note — E-2 (task E-2, 2026-10-14)

No decision changes; this records where § 8's E-2 row was closed.

**PRM-61 was closed by E-1, through the model the hop reads.** Measured
against real Node on E-2's base (E-1's merge): both reproduced shapes and
the false-`AFFECTED` order answer `UNKNOWN` or a correct `AFFECTED`, because
E-1's write set leaves one named binding per name on its decided path and
drops writes to a stale export object. The § 8 row's "PRM-61 (both shapes,
and its false `AFFECTED`)" therefore flipped with E-1, not E-2.

**What E-2 gates.** § 1's "the same determination gates the forwarding
hop" was still unimplemented: a whole-module re-export
(`module.exports = require("./lib")`) forwarded every name with no own
binding, including a name the file writes onto that very object in a form
the census can only withdraw (RWF-105, a live false `NOT_AFFECTED` and a
false `AFFECTED`). `applyExportWriteSet` now records, on the whole-module
re-export it keeps, every name the write set withdraws and every `=` write
not provably on a stale object (`ExportBinding.forwardingShadowedNames`);
`commonJsExportForwardingHop` forwards none of those names, forwards
nothing from a re-export without the record, and forwards an own name only
when every own binding of it carries one origin. The `call-graph.ts` and
`verdict.ts` consumers are unchanged, as § 8 requires.

**Not closed: the census bound (RWF-106).** The forwarded object is the
far module's exports object, so every load of that module returns it. A
write through a load result's dataflow the census does not follow
(`patch(require("./lib"))` writing `o.foo`, an array or object holder,
`for…of`) is not recorded, and the hop still forwards the name: E-2's
independent audit measured eight such shapes as live false `NOT_AFFECTED`s,
pre-existing. Its sound fix is RWF-103's open choice (a per-file rule, or a
module-graph-aware one), which this note does not decide.

**Precision.** A destructuring, `for-of`, compound or `Object.assign`
write is withdrawn without its object being placed, so one aimed at the
STALE `exports` also stops the forward (`[exports.run] = [x]` after
`module.exports = require("./lib")`): sound, coarser than Node. Measured
on the corpora by `scripts/e2-forwarding-write-set-corpus.mjs` (task E-2's
record in FINDINGS RWF-105).

## Decision record — option (b) for RWF-103 and RWF-106 (taken by task BL-074, 2026-10-14; the project owner confirms it by merging, or drops it)

**The choice.** E-1's and E-2's reports offered the project owner two
sound rules for a load's result that reaches a write through dataflow the
per-file census does not follow (RWF-103: this file's own exports object,
handed back; RWF-106: the object a whole-module re-export forwards):
(a) a per-file rule, any load result that leaves the census's routes
withdraws the file; (b) a module-graph-aware rule, only a load that can
return such an object counts. The owner gave the go without choosing;
BL-074 took the recommended (b), which is § 4's "a cyclic `require` that
cannot reach back … does not split the write set" applied to the census.

**The rule.** A load *may yield an export object* of file F when it may
load F itself (E-1's `mayLoadThisFile`, unchanged), when it has no literal
specifier resolved from F, or when the module graph cannot rule it out
(`src/code-intelligence/load-reach.ts`): the specifier is unresolved,
declaration-only or a registry builtin (`module`, `process`, `vm`,
`inspector`, `repl`, `worker_threads`), or resolves to a module whose
static load closure (every literal `require` anywhere, every import and
re-export source) contains F or a module F's whole-module write installs,
or is tainted (a member unreadable or unparsable, a closure-widening
construct, a load the closure does not follow as an edge, a loader-registry
or global-object reference that may reach another module, an unresolved
load, a registry builtin, the 4,096-file bound). F's whole-module write of
any value no load names (a call's result, a reassigned binding) makes
every load count. Such a load's value, and every value read from it through
members, must be **confined** -- a member chain's base (a write there
withdraws its name, as E-1 already did), a member call's receiver, a
callee, an inert use, a binding every reference of which is confined, the
whole-module write itself, or an own-property write in a file that never
reads its export objects back -- or the file is un-enumerable: every
CommonJS name withdrawn, the forward refused. A consumer with no graph
context applies (a).

**Two narrowings, each with its argument.** The closure-widening reason
`loader_capability_escape` is not taint: every capability it follows comes
from the ambient `module` or `require`, `require("module")`,
`module.constructor` or `process.mainModule`, which the registry scan
taints wherever they are used other than inertly. And `function_constructor`
at a `Function("return this")()` whose value only initializes a binding is
not taint: the literal body evaluates nothing but the global object, and
the registry scan taints every use of a binding it recognises as the global
object -- an ambient global name, the idiom, a `this` whose binding
function (the nearest non-arrow function, past arrows, class headers,
decorators and computed names) is not a class member and is not strict
code, or a binding of one -- that reads a code-evaluating, registry or self-named member, a
computed member, or hands the object on; and any closure member that
spells a registry- or frame-reaching member name (`mainModule`,
`getBuiltinModule`, `dlopen`, `eval`, `Function`, `caller`,
`prepareStackTrace`, `getThis`, `getFunction`) as a member, a key or a
string, whatever it reads it from. A caller's frame read through a key
computed at run time spells no name (RWF-109, masked). Without the second, VAL-001's `lodash.template` moved
`AFFECTED` → `UNKNOWN` (through `lodash.templatesettings`).

**The precision acceptance it binds.** Measured by
`scripts/bl074-load-result-dataflow-corpus.mjs` against E-2's merge: of
5,061 attributed exports in `node_modules`, (b) loses 1,251 (24.7%) and
(a) would lose 1,640 (32.4%); of 967 in the corpora, (b) loses 3 (all in
the validation fixtures, no verdict moves) and (a) 36. In `node_modules`
(b)'s cost is therefore three quarters of (a)'s -- the decision's premise
that (b) is much cheaper holds on the corpora, not on this tree's
dependencies: the owner's call to confirm. (b)'s cost is concentrated:
`@babel/types` and `eslint` (349 and 160: a sloppy function's `this`
handed on or read by a computed member, which may be the global object),
zod's `v4` core and schemas (TypeScript's
`__importStar(require("./x"))` handing a cyclic sibling to a helper),
`ts-api-utils` and `@typescript-eslint` (`require("typescript")` handed on,
and TypeScript's own closure is tainted by its dynamic loads). The corpus
differential: verdict 0 changed, graph 1 case (RWB-05, four edges into
`call-bind-apply-helpers` and `qs` withdrawn to `unresolved_target`, its
`UNKNOWN` unchanged), validation equal to the D-09 baseline. The narrowing
is backlog `BL-077`. Dropping this record means reverting to (a) -- every
escaping load result withdraws the file -- or reopening the thirty-four
live shapes it closes.

**What it does not decide.** The census does not follow what a call
through a load returns (RWF-107, masked: following it costs 35 of 967
corpus attributions instead of 3, the owner's call, backlog `BL-078`), and
a module made by another module to hold this file's exports object is not
in the graph (RWF-108, live, at E-4's boundary, backlog `BL-079`), and a
caller's frame read through a key computed at run time does not taint the
graph (RWF-109, masked, backlog `BL-080`). Its independent audit (four
blocked rounds) found all three, and found the assignment-value,
sloppy-`this`, destructuring-key and statically spelled stack-frame routes
this record closes.

**RWF-103's premise corrected.** RWF-103 recorded that the per-file rule
"withdraws nearly every TypeScript-emitted file". Measured, (a) loses
32.4% of `node_modules` attributions: a large cost, not nearly all.

## Decision record — option (a) for RWF-104 (taken by task BL-075, 2026-10-15; the project owner confirms it by merging, or drops it)

**The choice.** E-1's report offered the project owner two sound rules for
a builtin "reader" handed an export object (`Object.keys(exports)`, the
other `Object` / `Reflect` readers, a builtin prototype's
`hasOwnProperty.call(exports, k)`, `exports instanceof Object`), which E-1
trusted unless THIS file replaced the builtin by name (RWF-104): (a) drop
the reader allow-lists -- an export object handed to a builtin is handed
to code; (b) decide builtin replacement over the module closure. The owner
gave the go with the recommendation "(a) unless (b) wins on measured
precision by a clear margin". BL-075 took (a).

**Why not (b).** (b) can keep at most what (a) loses, and none of what
(a) loses measured comes from a builtin reader (below), so (b) would keep
none of it. And its premise was wrong: builtins are shared
by every module of the process, not of one file's closure -- the entry,
which no file's closure contains, replaced `Object.keys` before loading
`wrap` and real Node called `parse` (`rwf104.entry-replaces-before-loading`).
A sound (b) would range over every module that may run, with a census that
sees a replacement through a parameter or a `constructor` member, which the
call graph does not have either (RWF-110).

**The rule.** No builtin is trusted to only read an export object, the
final object's alias, or an object later exported: `classifyHelperCall`
returns no `read`, `isInertUse` takes no `instanceof` for inert -- on the
left the object is handed to the right's `Symbol.hasInstance`, a builtin's
included; on the right it runs its own, inherited from an
`Object.prototype` any module may write (RWF-112, found by BL-075's
independent audit) -- and the final-object alias census lost the reader
exemption. What stays inert holds whatever any module did: `typeof`, `!`,
`void`, a strict comparison, a loose one against `null` / `undefined`, a
condition, `k in E`, and the operators of § 1's census. The define arm
(`Object.defineProperty(E, …)`, `Object.assign(E, …)`, `Reflect.set(E,
…)`) keeps its per-file trust (RWF-111, below). One narrowing, with its
argument: an identifier on the right of `instanceof` bound to a function
declaration (not async, not a generator) or a class declaration with no
heritage and no computed member, never assigned, is inert
(`isOwnBaseCallable`): its `[[Prototype]]` is `Function.prototype`, whose
`Symbol.hasInstance` is non-writable and non-configurable (measured), and
the binding's census accounts the writes made through that binding. A
write reaching the function without its name (`arguments.callee`,
`new.target`, a `constructor` chain) is not accounted: the narrowing
inherits that open debt (RWF-114, RWF-115).

**The precision acceptance it binds.** Measured by
`scripts/bl075-builtin-reader-trust-corpus.mjs` against BL-074's merge
`0113347`: 9 of 4,774 attributed export bindings lost (7 of 3,810 in
`node_modules`, 2 of 192 in the validation fixtures -- RWB-09's two
semver `classes/range.js` -- none of 419 in `fixtures/` or of 75 and 278
in adversarial v1 and v2), none gained or moved. Each is a load that may
load this file back, on the right of `instanceof` (semver's `range.js` ↔
`comparator.js`, js-yaml, ajv, postcss): its value may be this file's own
exports object, so RWF-112 applies. Without the narrowing above the cost
was 19. Three oracle controls with nothing replacing anything move
`NOT_AFFECTED → UNKNOWN`
(`cost.object-keys-unreplaced`, `cost.instanceof-unreplaced`,
`cost.instanceof-right-unreplaced`), and nine census unit tests that
pinned a reader as a read now assert the withdrawal. The corpus differential: `node scripts/differential.mjs` against `0113347`, 139 corpus cases:
graph 2 (RWB-09a and RWB-09b, 56 call edges into semver's `Range` withdrawn
to `unresolved_target`), proof 2, verdict 2 (the `semver-vulnerable`
finding of RWB-09a and of RWB-09b, `AFFECTED → UNKNOWN`; none into
`NOT_AFFECTED`, none removed, none unmeasured). RWB-09a's selected verdict
moves, so validation has six failures instead of D-09's five -- a sound
precision cost, pending the owner's decision (OPEN-DEBTS D-09, backlog
`BL-085`). Dropping this record means
restoring the per-file reader trust, which reopens RWF-104's six live
shapes and RWF-112's five.

**What it does not decide.** The define arm trusts the builtin for every
name it does not spell; another module's replacement writes any name
(RWF-111, masked by the call graph's escape row). Making it un-enumerable
costs 1,115 of 3,810 `node_modules` attributions (29%), a separate
precision decision (backlog `BL-082`). A call of a builtin replaced
without its name has no edge whether or not an export object is involved
(RWF-110, live, ADR 0008's lane, backlog `BL-081`). A member read or a
method call of a name the file never writes, and a plain write, still
trust that no other module put an accessor, method or non-writable
property on `Object.prototype` (RWF-113, masked, backlog `BL-083`). Its
audit also found a live neighbour outside builtins: an exported function
writing onto itself through `arguments.callee` (RWF-114, backlog
`BL-084`).

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
