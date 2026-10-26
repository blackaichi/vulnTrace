# ADR 0010 — Loader Capabilities Are Tracked Through Every Expression Form; Runtime Resolution Is Node's

Lane C of [`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md). Status:
**proposed** (design only; nothing here is implemented).

## Context

Family A (`docs/SOUNDNESS-CONTRACT.md` § 3) rests on one premise: the
`ModuleLoadClosure` is **complete**. Completeness is decided by
`findClosureWideningConstructs` in `src/code-intelligence/loader-constructs.ts`,
and by which file `src/code-intelligence/module-resolver.ts` says a
specifier loads. Reproduced false family-A (and B/C) proofs show the
classifier losing a capability, or the resolver naming the wrong file:

| Finding | Mechanism |
| --- | --- |
| PRM-21/22 | aliases and ambient-name shadowing resolved by a whole-file, first-match `const` lookup (`local-aliases.ts`); an unrelated nested `const require` hides a real alias |
| PRM-60 = PRM-105 = PRM-109 | `valueFlowOperandsOf` treats member access and call results as value-opaque ("never the receiver itself", "never one of the operands by construction"): `[require][0](n)`, `[require].at(0)(n)`, `[Function][0](src)()`, `Function` fetched by a computed key or `Reflect.get` |
| PRM-106 | `require` is excluded as a capability *receiver*, so `require.bind(null)` launders it |
| PRM-107 | `module.paths` is recognised only as a literal `module.paths.<mutator>(…)`; an alias or `Array.prototype.unshift.call(module.paths, dir)` redirects a plain `require` to a different installed instance (family B false `NOT_AFFECTED` plus a false `AFFECTED`) |
| PRM-108 (consumer) | a builtin destructured with a string or computed key (`const { "fork": f } = require("child_process")`) is classified by the local name `f` |
| PRM-24 | `cluster.fork` / `cluster.setupPrimary` start a worker that loads code; `cluster` is not a modeled loader builtin (decided: widens exactly like `child_process.fork`) |
| AUD-03 | `process.getBuiltinModule` hands out loader builtins while the closure stays complete |
| AUD-04 | `inspector` `Runtime.evaluate` executes code |
| PRM-33 | a tsconfig with `module: commonjs` (or no `moduleResolution`) makes `ts.resolveModuleName` use node10 resolution, which ignores package `exports`; the closure follows `main` and never sees the file Node actually loads |

The shared cause: the classifier is an **enumeration of dangerous
spellings** with value-opaque defaults. Each fix so far (VT-307c-fix-3 …
value-flow-closure) inverted one enumeration and left another.

## Decision

### 1. The invariants

> **C1 (capability flow).** Let *capability* be every value kind
> `resolveLoaderCapability` models (the `Module` constructor, instances,
> prototype and members; ambient `require`, `eval`, `Function`; a
> `createRequire` result; the loader/execution builtins and their members;
> the loader registries, including `module.paths`) plus
> `process.getBuiltinModule` and the `cluster` and `inspector` builtins.
> For every expression `e` in a loaded file, the classifier computes
> `mayHold(e) ⊇ { capabilities that e's runtime value can be or contain }`
> by a relation that is **total over expression syntax kinds**: each kind is
> declared *transparent* (recurse into the operands whose values can flow
> into the result, including the receiver of a member access and the
> callee/receiver of a call), *selecting* (recurse into the selectable
> operands), or *opaque with a named proof* (the result provably cannot
> hold a capability). Every name is resolved by lexical binding, never by
> text, and every refusal of the lexical authority (`alias_cycle`,
> `alias_chain_too_long`, `reassigned`, `ambiguous_declarations`) on a name
> whose declaration can hold a capability maps to `ambiguous` (fail closed),
> never to "no capability". A capability that reaches a position the classifier does not model
> (a call it does not recognise, a store, a return, an iteration, an
> export) widens the closure.

> **C2 (runtime resolution).** Every resolution that decides which file
> Node loads uses Node's algorithm, whatever the project's tsconfig says:
> `moduleResolution: NodeNext`, package `exports`/`imports` honoured, the
> conditions Node would use (`node`, `require`/`import`, `default`). The
> tsconfig contributes only what Node also honours at runtime. When a
> tsconfig mapping (`paths`/`baseUrl`) would resolve a specifier to a
> different file than Node does, the closure is incomplete for that
> specifier rather than following either answer silently.

Mechanically checkable:

- C1: for every `ts.SyntaxKind` that can appear as an `Expression`, the
  value-flow table has exactly one entry, and every *opaque* entry names a
  proof from a closed `OpaqueProof` union.
- C2: the compiler options handed to `ts.resolveModuleName` on the runtime
  path satisfy `moduleResolution ∈ {Node16, NodeNext}` for every tsconfig in
  a table covering `module ∈ {commonjs, es2015, es2020, es2022, esnext,
  node16, nodenext, preserve}` × `moduleResolution ∈ {unset, node10,
  node16, nodenext, bundler}`.

### 2. Enforcement and the structural gate

Where: `loader-constructs.ts` (`valueFlowOperandsOf`,
`resolveLoaderCapability`, `memberAccessOf`, `isAuthoritativeCapabilityReceiver`,
`BUILTIN_MEMBER_REASONS`, `NODE_BUILTIN_SPECIFIERS`); `local-aliases.ts`
(retired as a provenance authority); `source-index.ts`
(`extractRequireBindings` import names, shared with lane A);
`module-resolver.ts` `createModuleResolver`; `ts-project.ts`.

Structural gates:

- **A total value-flow table.** `valueFlowOperandsOf` becomes a table keyed
  by `ValueFlowKind` (every expression syntax kind), typed
  `satisfies Record<ValueFlowKind, ValueFlowRule>`. Adding a syntax kind
  without a rule, or an opaque rule without a proof, is a compile error.
  The member-access and call rules are *transparent for the receiver and
  callee*, and keep today's precision only through named proofs
  (`PrimitiveResult`, `KnownPureMember` such as `require.resolve`,
  `ModuleExportsWrite`).
- **A capability-grammar sweep**, the loader counterpart of
  `tests/binding-grammar/`: generated fixtures crossing every capability
  source (the list in C1) with every container and route (bare, array
  literal, object literal, nested composite, `Map`/`Set` construction,
  class static and instance field, closure return, generator `yield`,
  promise resolution, `bind`/`call`/`apply`, destructuring default, string
  and computed destructuring key, numeric index, `Reflect.get`,
  `Array.prototype.*.call`) and every consumption (call, member call,
  argument, assignment target). Each cell carries a real-Node oracle (does
  the program load the fixture package?) and asserts: if Node loads it, the
  closure is incomplete or contains it. This extends
  `module-load-closure.differential-oracle.test.ts` from hand-picked shapes
  to a grammar. All 22 PRM-60 shapes, the PRM-106/107/108 shapes and the
  AUD-03/04 shapes are rows.
- **Resolution-mode table test** for C2 (the table in § 1), plus one
  real-Node fixture per row where the answer differs.
- **An operation-count gate** (ARCHITECTURE § 10, § 10.2): lexical
  provenance lookups go through `named-bindings.ts`'s per-scope indexes, and
  `namedBindingScopeIndexBuilds()` must stay a function of *scopes*, not of
  *queries*, for a loaded file. This is required, not optional: see § 5.
- Registered in `src/testing/foundation-invariants.ts` as
  `VT-INV-C-capability-flow` and `VT-INV-C-runtime-resolution`.

### 3. Fail-closed default

- A capability that reaches an unmodeled position widens the closure with the
  existing reason `loader_capability_escape` (category `capability_escape`).
  A named loader keeps its specific reason (`child_process_execution` for
  `cluster.fork`/`setupPrimary`, `vm_execution` for an `inspector.Session`,
  `loader_hook_mutation` for any mutation of `module.paths`).
- A `ValueFlowKind` the table does not name falls to the
  `unclassifiedValueFlowFailsClosed` floor (transparent), mirroring
  `isClosureWideningReason`'s `never` floor.
- A C2 disagreement between tsconfig and Node is `unresolved_module`
  (category `identity_unresolved`), which already blocks families B and C.

No seventh category and no new reason token are needed.

### 4. Modeled exceptions that keep precision

Each is an `OpaqueProof`, each with a named test:

- **Primitive-result operators** (`+`, comparisons, `typeof`, template
  literals, …): the result cannot be an object. Today's
  `PRIMITIVE_RESULT_BINARY_OPERATORS` is already correct.
- **`module.exports = …`** stays a safe write *for loading* (it cannot
  change what a later `require` resolves to). Its effect on the export
  model belongs to lane E.
- **`require.resolve(x)`** returns a string and loads nothing.
- **Reading `module.exports` / `exports`** as a receiver is not a
  capability read (Exclusion 1's original motivation). The rule is narrowed
  from "every member access" to "a member access whose receiver's own
  `mayHold` is empty".
- **Global-object detection preambles** (`typeof global == 'object' && global`)
  stay resolution-only, as today (lodash, url-parse).
- **Read-only uses of loader state** that today's precision controls
  pin and that must stay complete: non-mutating array methods on
  `module.paths` (`slice`, `includes`, `indexOf`), and
  `Module.builtinModules.includes(…)`. The prototype, which treated every
  method call on a registry as a mutation, failed both controls
  (`module-load-closure.test.ts`); the design keeps today's
  `ARRAY_MUTATING_METHODS` split and extends it to aliases.
- **`eval` stored in a lookup table** (`get-intrinsic`'s
  `INTRINSICS['%eval%'] = eval`) is not an escape unless the composite is
  *called through*; the prototype held both such shapes.

### 5. Precision cost

**Measured** with a throwaway prototype in a scratch clone outside the
repository (never committed), at `62b52b9`: scope-aware provenance via
`resolveNamedBinding`; member access transparent for composite receivers;
`require.bind/call/apply` stay `require`; `Reflect.get(x, "constructor")`
and constant computed keys resolved; `module.paths` a loader registry;
`require` a capability receiver except `.resolve`; string and computed
destructuring keys; `cluster`, `inspector` and `process.getBuiltinModule` as
loaders; NodeNext runtime resolution.

| Measure | Result |
| --- | --- |
| adversarial scenarios (`npm run test:adversarial`) | **0 / 122** verdicts changed |
| validation cases (`npm run test:validation`, live OSV) | **0 / 17** verdicts changed |
| validation findings (all 85, every advisory × instance, not only the case's selected one) | **0 / 85** changed |
| targeted reproductions | all flip: 10 cases to `UNKNOWN`, and the PRM-33 tsconfig case to a correct `AFFECTED` |
| **wall time**, validation suite run alone | **337 s vs 115 s baseline (≈ 2.9×)**; RWB-09a 31 s vs 14 s, which exceeded the runner's 30 s timeout |

The repository's own suite (`npx vitest run`, 4,480 tests) under the
prototype: 5 failures, all assigned in § 8 (two precision controls the
prototype over-flagged, one fail-closed cyclic-alias control it broke, two
RWB-09 scan tests that timed out).

The verdict cost is zero on both corpora. The wall-time cost is real and
comes from the prototype calling `resolveNamedBinding` per identifier and
re-walking composite receivers per member access, without a per-file memo.
That is why § 2's operation-count gate is part of the invariant: the first
implementation task must build the capability relation as a per-file index
(one walk, hash lookups, like `named-bindings.ts`'s scope indexes) and
show, with the existing `test:performance` suite and a new operation-count
assertion, that the validation wall time stays within today's thresholds.
Thresholds are never raised to make this green (ARCHITECTURE § 10.2).

### 6. Reopened certified behaviour

| Certified decision | Where | Reopened because |
| --- | --- | --- |
| VT-307c-value-flow-closure, Exclusions 1 and 2 | `loader-constructs.ts:2165-2196` | PRM-60/105/109 (six family-A reproductions) |
| VT-307c-builtin-closure: `require` excluded as a receiver ("no unknown-member surface on `require`") | `loader-constructs.ts:1867-1872` | PRM-106 (`require.bind`) |
| VT-307c-fix-3: `resolveSingleAssignmentValue` as "acceptable imprecision" for loader provenance | `local-aliases.ts:80-89`; `loader-constructs.ts:162, 806-812, 1046` | PRM-21/22, including the round-2 two-hop `vm` alias |
| VT-307c-fix-9: `.paths` matched as a literal chain only | `loader-constructs.ts:2720-2763` | PRM-107 |
| VT-305: a builtin "is not an uncertainty" | `module-load-closure.ts:196-198`, `call-graph.ts:2219-2220` | PRM-24 (`cluster`), AUD-03, AUD-04 |
| TASK-013 / VT-304: `ts.resolveModuleName` with the project's own options "correctly handles … `exports`" | `module-resolver.ts:443-451`; `ts-project.ts:149-152` | PRM-33 |
| `symbol-binder.ts:269-271`: `loader-constructs.ts` reads the import table "refusal-only by construction" | `symbol-binder.ts` | PRM-108: it classifies by the *local* name, a non-refusal |

### 7. Interaction with the proof families and RWF-002

- **Family A** is the direct beneficiary: C1 and C2 are its completeness
  premise. Every flip in § 5 turns a family-A false `NOT_AFFECTED` into an
  incomplete closure.
- **Families B and C** consume closure incompleteness through
  `callGraphNegativeProofBlockers`, so each C1 widening also blocks them.
  That is correct: a loader the graph did not model can hide a call path
  (VT-307e).
- **AFFECTED** is affected in one residual: PRM-107 also produces a false
  `AFFECTED` for the instance Node *no longer* loads, because the `require`
  it traverses was redirected. This ADR proposes (task C-5) that a
  reachable `loader_hook_mutation` makes a static `require` resolution
  non-authoritative for `AFFECTED`. See
  [`REMEDIATION-PLAN.md` § 6](../REMEDIATION-PLAN.md), decision 6.
- **RWF-002** does not help this lane: closure-widening reasons are, by
  definition, not "irrelevant to the target" (a widening construct can load
  the target). RWF-002 must continue to treat every closure-widening reason
  as relevant.

### 8. Implementation tasks, in order

| Task | Scope | Reproductions that flip | Existing tests that change |
| --- | --- | --- | --- |
| **C-1** runtime resolution mode independent of tsconfig (C2) | `module-resolver.ts`, `ts-project.ts` | PRM-33 | `module-resolver.test.ts` cases that assert node10 behaviour under a tsconfig; `ts-project.test.ts` default-options assertions |
| **C-2** lexical provenance in the loader classifier, as a per-file index, with the operation-count gate | `loader-constructs.ts`; retire `local-aliases.ts` as a provenance authority | PRM-21/22 (incl. two-hop `vm`) | `module-load-closure.test.ts` "a cyclic alias used as a call TARGET fails closed" must stay green: the prototype, which mapped the lexical authority's `alias_cycle` refusal to "no capability", **failed it** (the closure reported complete), which is why § 1 requires refusals to map to `ambiguous`; `scan.module-load-closure.test.ts` RWB-09 cases timed out under the unindexed prototype and are the performance acceptance for the operation-count gate |
| **C-3** total value-flow table and the capability-grammar sweep | `loader-constructs.ts`; new `tests/capability-grammar/` suite | PRM-60/105/109, PRM-106 | `module-load-closure.test.ts` precision controls must stay green: `module.exports` reads, `module.paths.slice()/includes()` (VT-307c-fix-9), `Module.builtinModules.includes('fs')` (VT-307c-capability-floor); the prototype failed the last two, so they are the named tests for § 4's read-only exceptions |
| **C-4** loader builtin table: `cluster`, `inspector`, `process.getBuiltinModule`; `module.paths` as a registry kind; destructured string/computed keys | `loader-constructs.ts`; consumes lane A's A-5 import-name fix | PRM-24, PRM-107, PRM-108 (consumer), AUD-03, AUD-04 | none known to pin the old behaviour |
| **C-5** `AFFECTED` authority under a reachable loader mutation (decision 6) | `verdict.ts` path check | PRM-107's false `AFFECTED` | none |

## Rationale

The closure is the one proof premise that must be total over the program's
loading behaviour, and the classifier has been made sound by enumeration
six times and failed the same way each time. Stating the invariant over
*syntax kinds* (a finite set the compiler can check) instead of over
*dangerous spellings* (an open set) is what breaks the loop. The measured
verdict cost is zero; the performance cost is an implementation
requirement, not a reason to weaken the invariant.

## Consequence

`local-aliases.ts` stops being a provenance authority. The capability-grammar
sweep becomes the regression net for every future loader idiom. The runtime
resolver no longer changes meaning with the project's tsconfig.

## Decision record — C2 under `paths` / `baseUrl` (project owner, 2026-10-09)

Recorded by task [`C-1`](../tasks/C-1-runtime-resolution-mode.md), on the
project owner's answer to the question that task asked before
implementing. This ADR's body above is unchanged; this section is
appended, not a revision.

**What was measured.** § 5 reports "adversarial scenarios 0 / 122
verdicts changed" for a prototype whose runtime resolution was "NodeNext".
TypeScript applies a tsconfig's `paths` and `baseUrl` under NodeNext too
(measured, TypeScript 5.9.3), so that prototype implemented C2's first
sentence (the mode) and not its last (a `paths` / `baseUrl` mapping that
disagrees with Node). With C2 implemented as written, over all 139 corpus
cases (`node scripts/differential.mjs`): **3 verdicts change**, ADV-023,
ADV2-015 and ADV2-016, all `AFFECTED` → `UNKNOWN` (`unresolved_module`);
0 into `NOT_AFFECTED`; 0 findings removed; the validation baseline
unchanged. The fixture suite's `typescript-paths` case moves the same way.
In all four, real `node` running the source compiled with the fixture's
own tsconfig throws (`ERR_MODULE_NOT_FOUND` / `MODULE_NOT_FOUND`) on the
aliased import, because `tsc` emits the specifier unchanged and Node
never reads tsconfig. Recorded as RWF-084 (`tests/validation/FINDINGS.md`).

**Decision: strict C2, as written.** Runtime resolution never reads the
tsconfig. A `paths` / `baseUrl` mapping is consulted only as a
cross-check; when it gives a different outcome than Node's resolution —
including when Node cannot resolve the specifier at all — the specifier is
`unresolved_module` (§ 3), and neither answer is followed. The three
adversarial cases' expected verdicts are corrected to `UNKNOWN`: an
`AFFECTED` path through such an alias needs a resolution real Node never
performs, the same reasoning `REMEDIATION-PLAN.md` § 6.1 decision 6 (task
C-5) applies to a redirected `require`. It is consistent with decision 7
there, which this record does not change.

**Also in C-1, under C2's first sentence** (no decision needed, recorded
for the reader): a tsconfig `paths` / `baseUrl` entry that shadows an
installed package — under any `moduleResolution` — was a live family-A
false `NOT_AFFECTED` that PRM-33 did not cover, recorded as RWF-083 and
fixed by the same cross-check. C-1's independent audit found two more,
both fixed by the task: TypeScript's NodeNext resolution matches the
`types` export condition, which Node never does (RWF-087; the resolver now
runs the noDts resolution, which drops it, first), and the declaration-only
fallback (VT-304 Part 4) returned `main` or a stale sibling for a
specifier governed by an `exports` or `imports` map whenever TypeScript
reported no `packageId`, or read the manifests above the declaration
rather than the named package's (RWF-088; now decided from the package
the specifier names, located as Node locates it).

**How far C2 holds after C-1.** NodeNext is Node's resolution *mode*, not
Node's algorithm in every detail. Still open: TypeScript substitutes and
prefers TypeScript extensions inside `node_modules` and for a JavaScript
importer (RWF-086), and which file a `module-sync` export loads depends on
the Node version (RWF-085).

## Note — task BL-092: `module.paths` as a capability kind, ahead of C-4 (2026-10-19)

Recorded for the reader; no decision of this ADR changes. Task BL-092
(`docs/tasks/BL-092-loader-capability-routes.md`) did C-4's "`module.paths`
as a registry kind" item early, because RWF-129 (found by BL-091's
re-audit) is PRM-107's false `NOT_AFFECTED` and was live. A `Module`
instance's `.paths` is a capability kind of its own (`module_paths`): any
mutation through it is `loader_hook_mutation` (§ 3), its escape is
`loader_capability_escape`, and § 4's read-only methods stay complete,
extended to a reviewed list (`MODULE_PATHS_READ_METHODS`); a method on
neither list fails closed, which § 4's "keeps today's
`ARRAY_MUTATING_METHODS` split" did not say. The same task resolved
`module.__proto__` to `Module.prototype` (RWF-130), an instance's
inherited `require` / `load` / `_compile` (RWF-135) and the CommonJS
wrapper's `arguments` (RWF-134), and read every write target and `with`
head (RWF-133, RWF-138). C-2's lexical provenance is not part of it: an
alias is still a same-file `const` looked up by name.

§ 4's read-only exception rests on `Array.prototype` being Node's own. A
module that replaces `includes`, the array iterator or `join` runs with
the list as `this` (RWF-136, live, pre-existing). Whether the exception
survives that is a decision for the project owner (backlog `BL-096`).


## Proposed decision — BL-096: the read-only uses of `module.paths` (PROPOSED — requires project-owner decision)

Recorded by task
[`BL-096`](../tasks/BL-096-module-paths-read-only-exemptions.md). This
section is appended. It changes no earlier section, and nothing in it is
implemented. The measurements are in
`scripts/bl096-module-paths-options/results.md`. The prototypes are the
patches next to it, against the base `904d032`, measured with real Node
v22.11.0.

### The question

§ 4 keeps the "read-only uses of loader state" complete. BL-092 extended
that to a reviewed list of `Array.prototype` methods
(`MODULE_PATHS_READ_METHODS`) and to iteration. The classifier also lets
every member read of the lookup list pass (`resolveLoaderCapability`
answers nothing for a member of `module_paths`). It also lets pass every
position that is neither a consumed position nor a call argument: an
operand of an operator with a primitive result, a template, a spread, an
array element, a shorthand property, `await`. Each of these assumes that
Node's own builtins handle the list. RWF-136 shows that a module can
replace them. The backlog named two options: **(a)** keep each exemption
only while no loaded file writes a member of a builtin prototype; **(b)**
fail closed on every use except an element read or `length`.

### What was measured

- **Which uses hand the list to user code.** The 16 read methods, `for…of`
  and spread, every conversion (a template, arithmetic, `++` / `--`,
  comparison, `==` with a primitive, a property key, the left of `in`, an
  outer array converted or used as a key), a member read the list does not
  own (a named member, an index past its end, a method read as a value),
  `await`, and both operands of `instanceof`. A replaced method, an
  accessor, `Symbol.toPrimitive`, a `then` getter, a species getter, or a
  Proxy set as `Array.prototype`'s [[Prototype]] each receives the list.
  Two uses need no builtin replaced at all:
  - **the left of `instanceof`** (RWF-154): a class of the program's own
    with `static [Symbol.hasInstance]` receives the list;
  - **the list held in an array literal or a shorthand property** and used
    on the spot (`[module.paths][0].shift()`, PRM-105's family;
    `({ p }).p.shift()`, RWF-155).

  Never, under any tamper the probe and the oracle cases tried: `length`,
  an own index, `for…in`, `===`, `!==`, `typeof`, `void`, `!`, the right
  of `in`, `==` / `!=` with `null`, a test, a `switch`, a value only
  selected by `||` / `??` / a conditional into one of these.
- **The base.** Of 49 oracle cases in which real Node calls the target, 47
  are a false `NOT_AFFECTED` (family B). The other two are the spelled
  method call, which the call graph already catches, and a property
  assignment's value, a consumed position (`({ l: module.paths })`).
  RWF-136's record named three of the 47. A `const` that may hold either
  `require` or the list is resolved to the first (RWF-157, no builtin
  replaced). The list is also reached through routes the resolver answers
  `ambiguous` for: `require.cache[__filename].paths`, a computed key, and
  an alias chain past its depth budget. Six of the 47 involve no use of the
  list at all (RWF-156, below).
- **Real code.** No file of 3,838 (this repository's `node_modules` and
  npm's) spells one of the five instance forms (`module.paths`,
  `require.main.paths`, `process.mainModule.paths`, `module.parent.paths`,
  `module.children[i].paths`). A raw text search for `.paths` on those
  receivers finds none either. The census does not count other routes: a
  `new Module`'s `m.paths = …` exists (`require-from-string`), and it is a
  write, which fails closed under every option. The precision of (b2)'s
  `ambiguous` rule on real code is covered only by the zero corpus
  differential.
  Neither option's precision cost is measurable on real code: it is the
  synthetic controls only. Option (a)'s precondition fails in 314 of 450
  packages, which have at least one store the escape row counts as an
  escape.

| | base | (a) | (b0): (b) as worded | (b1): a fail-closed list | (b2): an allow-list |
| --- | ---: | ---: | ---: | ---: | ---: |
| false `NOT_AFFECTED`, uses of the list (of 43 Node calls) | 41 | 24 | 24 | 22 | **0** |
| false `NOT_AFFECTED`, no use of the list (RWF-156, of 6) | 6 | 6 | 6 | 6 | 6 |
| controls keeping their proof (of 12 Node does not call) | 12 | 9 | 7 | 5 | 5 |
| `npm test` failures (of 6,708) | — | 0 | — | 4 | 4 (the same precision controls) |
| `test:oracle` failures outside BL-096 (of 1,356) | — | 0 | — | 1 | 1 (the same precision control) |
| corpus differential, graph / proof / verdict (139 cases) | — | 0 / 0 / 0 | — | 0 / 0 / 0 | 0 / 0 / 0 |

**Option (a) is not sound as built.** Its precondition must see every write
of a builtin anywhere in the closure. The prototype read the escape row's
stores and a list of storing builtins by name, and it missed `const d =
Object.defineProperty; d(Array.prototype, …)` and `Reflect.apply(Object.
defineProperty, …)`. A better detector would see the first through the
call graph's builtin identity. Seeing every route by which a builtin is
handed on and called is the escape row's whole relation (ADR 0008,
BL-081's decision record), which is not certified: BL-094 counted 195
historical misses, and its proposed decision is pending. (a) would make
lane C's soundness depend on lane A's uncertified class. It still needs
the uses (b2) closes for the no-tamper routes, and in practice it buys
nothing, since its precondition fails for most real packages.

**Option (b) as worded is not sound.** An element read is an inherited
lookup when the index is not the list's own, and an own index is not known
statically.

**(b1), a list of the uses that fail closed, is not sound.** This task's
independent audit (round 1) found eight live cases it lets through:
spread, `++` / `--` on a `const` alias, an outer array converted or used as
a key, and the list held in an array literal or a shorthand property. The
cause is structural. A list of the uses that fail closed leaves every use
it does not name exempt.

**Node's own loader is a route no per-use rule sees (RWF-156).** The
audit's rounds 2 and 3 found that a module receives the lookup state from
Node's own writes (`Module._resolveLookupPaths`'s `unshift`,
`Module.prototype.load`'s `this.paths = …`) when it does any of the
following:
- defines index setters or a `paths` setter on `Object.prototype`;
- sets a Proxy as `Array.prototype`'s [[Prototype]];
- stores `Array.prototype.constructor` (its species);
- defines an `extensions` or `cache` setter on `Object.prototype`, which
  `makeRequireFunction`'s plain stores hand the loader's registries to
  (round 4).

The program never uses the list, and every option above misses it. Closing
it needs a closure-wide fact about such builtin-prototype stores, which is
a design across lanes A and C (backlog `BL-111`), not a rule over the
list's uses. It is not part of the decision proposed here.

### Recommendation: (b2)

The rule is an allow-list over the use. It applies to every expression
that may be the lookup list along a route `resolveLoaderCapability`
follows. That is any route it resolves to the list (`module.paths`, a `const` alias, `require.main.paths`, …),
and any member named `paths`, or under a computed key into a `Module`
instance, that it resolves to `ambiguous` (`require.cache[k].paths`, an
alias chain past the depth budget; round 3). For each such expression, its
syntactic parent decides:

1. **Exempt:** a read of `length`; `for…in` over the list; the list as an
   operand of `===`, `!==`, `typeof`, `void`, `!`, the right of `in`, or
   `==` / `!=` against `null`; a test (`if`, `while`, `do`, `for`, a
   conditional's condition, the left of `&&`); a `switch` or `case` value
   (strict equality); a discarded value (an expression statement, the left
   of a comma); and the initializer of a plain, unexported `const` (not
   `using`) whose declared name itself resolves to the list. The alias's own
   uses are then classified the same way. An alias that may hold another
   capability (RWF-157), or a name another declaration shares (PRM-22), is
   not exempt.
2. **Passed up:** a parent that only selects the value (parentheses, a
   type assertion, a conditional's branches, either side of `||` / `??`,
   the right of `&&` or of a comma) is classified by its own parent.
3. **Everything else** is a `loader_capability_escape`: every method call
   (the mutating ones keep `loader_hook_mutation`), every other member
   read, element reads included, `for…of`, spread, a template, every other
   operator, a property key, an array element, an object property, an
   argument, `await`, a `return`, a store.

The exempt side is the closed list. A use the rule does not name fails
closed by construction, as § 2's value-flow walk already does for value
containers. The first form of the prototype exempted any `const`
initializer, and round 2 found RWF-157 through it. It also read only a
`module_paths` resolution, and round 3 found the `ambiguous` routes. The
rule as stated here is the revised one. It is per file and depends on no
other module and no other lane. Measured: it gives `UNKNOWN` in all 43
cases that use the list,
and closes RWF-136, RWF-154, RWF-155 and RWF-157 for the lookup list in the
shapes measured (the shorthand, array and alias gaps for other
capabilities are C-2's and C-3's, with PRM-22 and PRM-105). Its round-2
form also catches RWF-139's `(() => module.paths)().shift()` (measured by
the audit). The
method calls that `classifyLoaderConstruct` shares with the call graph
become the same `loader_capability_escape` unknown edge that the spelled
`module.paths.slice()` already has (BL-092).

**What (b2) does not cover.** RWF-156: Node's own loader writes reach a
replaced builtin with no use of the list (backlog `BL-111`). The binding
lookup is still by name. PRM-21's shadowed `module` (`function g() { const
module = 1; } [module.paths][0].shift()`) is missed under every option.
So is the route through another `Module` instance, `module.parent` /
`module.children[i]` (BL-040's family). So is a route the resolver does
not follow: an object spread of `module` read back on the spot,
`({ ...module }).paths.shift()` (PRM-105's family, round 4). In
TypeScript, a deep `import a = p.x.y` chain on an alias of the list is
also missed. tsc rejects the shallow form, so this is theoretical, and
`BL-110` covers it. (b2) does catch PRM-22's name collision for a
`const` alias of the list. "Never
hands the list on" is measured over the tampers tried (`results.md` § 1),
not proven over the specification.

**What (b2) costs**, all in synthetic controls, since no real-code use was
found: ADR 0010 § 4's precision control 11 (`module.paths.slice()` /
`includes()`); BL-092's read-only-method, element-read and iteration
controls (four unit tests, one oracle case); and seven of the twelve
BL-096 controls. The cost includes an own index (`module.paths[0]`): an
index read is exempt only as `length`. A member of a module-cache entry
other than `paths` keeps its proof (`require.cache[k].exports`). § 4's "non-mutating array methods on
`module.paths`" bullet is withdrawn. `Module.builtinModules.includes(…)` is
unaffected: that array is frozen (measured), and Node's loader does not
depend on it.

If (b2) is accepted, backlog `BL-110` implements it, then a fresh-context
certification audit runs. It deletes
`MODULE_PATHS_READ_METHODS` and `isIteratedLookupList`'s `for…of` half,
adds the allow-list to the whole-file walk, flips the BL-096 oracle
records, and records each lost control as the decision's cost (none
pinned as a wrong verdict). If (a) is preferred instead, it first needs a
"may write a builtin" relation that the escape row's certification would
have to cover, and (b2)'s no-tamper routes besides. Either way RWF-156
stays open until `BL-111` decides it.

## Decision record — BL-096: the read-only uses of `module.paths` (project owner, 2026-10-26)

Decided by the project owner on 2026-10-26, on task
[`BL-096`](../tasks/BL-096-module-paths-read-only-exemptions.md)'s pull
request (#118), from the measurements in "Proposed decision — BL-096"
above; recorded by that task. This ADR's body and every earlier section are
unchanged; this section is appended. It amends § 4's "read-only uses of
loader state" bullet.

**Decision: option (b2), as stated in the proposed decision's
recommendation, is accepted.** The uses of a `Module` instance's lookup
list follow an allow-list over the use. For every expression that may be the
list along a route `resolveLoaderCapability` follows, its syntactic parent
decides:

- the closed list of exempt parents keeps the proof;
- a parent that only selects the value passes the question to its own
  parent;
- every other parent is a `loader_capability_escape`.

The exempt parents are `length`, `for…in`, `===`, `!==`, `typeof`, `void`,
`!`, the right of `in`, `==` / `!=` against `null`, a test, a `switch` or
`case` value, a discarded value, and a plain unexported `const` whose
declared name resolves to the list.

**§ 4 amended.** The "non-mutating array methods on `module.paths`
(`slice`, `includes`, `indexOf`)" half of the read-only bullet is withdrawn.
`Module.builtinModules.includes(…)` stays, because that array is frozen and
Node's loader does not depend on it.

**Costs accepted**, each recorded as this decision's cost and none pinned
as a wrong verdict:

- ADR 0010 § 4's precision control 11 (`module.paths.slice()` /
  `includes()`, `module-load-closure.test.ts`);
- BL-092's three unit controls (`loader-constructs.bl092.test.ts`: the
  read-only methods; an element read and `length`; iteration) and its
  oracle control `precision.read-only-uses`;
- seven of the twelve BL-096 controls.

**Not decided here.** RWF-156, the route through which Node's own loader
writes reach a replaced builtin with no use of the list, stays open under
this decision. It goes to backlog `BL-111`, a design across lanes A and C.
The shapes (b2) does not cover (PRM-21, PRM-105 for other capabilities,
BL-040's routes) stay with their own rows.

**Implementation.** Backlog `BL-110` does three things:
- implements the rule in `loader-constructs.ts`, measured against the
  prototype `scripts/bl096-module-paths-options/b2-allow-list.patch`
  (the prototype is not the implementation);
- flips the 41 open-soundness-defect records of
  `tests/oracle/bl096-module-paths-read-only.*` that use the list;
- runs a fresh-context certification audit of the allow-list against
  real Node.

## Note — task BL-110: the decision on the uses of `module.paths`, implemented (2026-10-26)

Recorded for the reader; no decision of this ADR changes. Task
[`BL-110`](../tasks/BL-110-module-paths-allow-list.md) implemented
"Decision record — BL-096" in `loader-constructs.ts`:

- `isListExpression` finds every expression that may be the lookup list;
- `listUseReason` is the allow-list over its syntactic parent;
- `isListAlias` is the alias rule;
- `modulePathsMethodReason` no longer exempts a method.

`MODULE_PATHS_READ_METHODS` and `isIteratedLookupList`'s `for…of` half are
deleted. The identifier test is call-graph.ts's `isValueReferenceName`,
moved unchanged to `local-aliases.ts`. It also makes the head of a
TypeScript `import a = p.x.y` chain a read. In TypeScript, a type query
(`typeof p`) is the one type position that is no use of an alias of the
list: every emit erases it. A type reference stays a use. Under
`experimentalDecorators` and `emitDecoratorMetadata`, a decorated member's
type is emitted as a runtime expression:
- a qualified `p.T` is a read of `p.T`;
- a bare `p` whose name an interface shares is the list itself, handed to
  `__metadata`.

The analyzer does not read the compiler options. Both forms were measured
against real Node by the task's re-audits.

§ 4's read-only bullet is amended by the decision record above, and its
text is left as written (this ADR's sections are append-only). It now
reads, for `module.paths`: `length` and `for…in` only.

Measured:
- 61 oracle cases against real Node: every case that uses the list is
  `UNKNOWN`, and RWF-156's six stay open (`BL-111`);
- the decided cost and no other;
- no corpus graph, proof or verdict change over 139 cases;
- resolution steps ×1.19 over 3,838 `node_modules` files, at most 31 per AST
  node on the corpus (`scripts/bl110-resolution-steps-corpus.mjs`); the bound
  per node is the alias depth budget, reached by a member chain
  `module.paths.a.a…`;
- each selection a use passes up through is classified once per file, since
  its answer is remembered (the certification audit measured a quadratic
  first form: a 4,000-term `||` chain took 6.5 s, and it now takes 188 ms);
- `test:performance` unrelaxed.


## Proposed decision — BL-111: Node's own loader through a replaceable builtin (PROPOSED — requires project-owner decision)

Recorded by task
[`BL-111`](../tasks/BL-111-loader-writes-builtins.md). This section is
appended. It changes no earlier section, and nothing in it is implemented.
The inventory and the measurements are in
`scripts/bl111-loader-writes-options/` (`inventory.md`, `results.md`, the
patches). The base is `71c62e0`, measured with real Node v22.11.0.

### The question

RWF-156 is the case where Node's loader runs its own JavaScript over
objects and arrays that a loaded file has changed: a setter, a Proxy or a
species on a builtin prototype. A later `require` then loads what that file
chose, and the program makes no use of any loader state. "Decision record —
BL-096" closes the uses of the lookup list. It cannot close this, because
there is no use to classify. Only a closure-wide fact can: a loaded file
that may make such a store leaves the closure incomplete. The question is
which stores count, and what that costs.

### What was measured

- **The inventory.** From Node v22.11.0's own loader source
  (`process.binding("natives")`): 1,002 candidate names, 3,023 recording
  accessors on `Object.prototype`, `Array.prototype` and
  `Function.prototype`, a workload of eight load forms, and attacks against
  real Node. The loader does the following by inheritance:
  - it **writes** onto every `Module` it creates (`id`, `path`,
    `filename`, `loaded`, `children`, `paths`) and every `require`
    function (`resolve`, `paths`, `extensions`, `cache`);
  - it **writes** into the arrays it builds (`unshift` in
    `_resolveLookupPaths`);
  - it builds arrays through the receiver's **species** (`ArrayPrototypeSlice`
    of the lookup paths, `ArrayPrototypeFilter` of the extension lists);
  - it **reads** data properties: an ES module load context's `source`,
    `Symbol.toPrimitive` on URLs, fs `encoding` / `signal`, `then`.

  Live end to end: every write and species route (RWF-156's six oracle
  records). In real Node, `Object.prototype.source = <text>` replaces an
  ES module's source, and a plain *primitive* store does it. With the
  analyzer it is `UNKNOWN`, because on v22.11.0 an ES module loads after a
  store only through `import()`, which already widens the closure. The
  other reads only make the load throw.
- **The stores that reach it.** The stores that reach it are a define call
  (data or accessor, any name), a [[Prototype]] change, a store of
  `constructor` (species), and a store under a computed key, which may be
  either. An accessor-only rule misses species, which is a plain data store.

| | (A) every escaping store | (B) the stores that reach the loader | (B′) (B), names spelled only | (C) trust boundary |
| --- | ---: | ---: | ---: | ---: |
| RWF-156's 6 live cases | `UNKNOWN` | `UNKNOWN` | `UNKNOWN` | open |
| sound | **not as prototyped**: storing calls are recognised by name | **not as prototyped**: storing calls are recognised by name (see the independent audit) | **no**: `o[k] = C` with `k` `"constructor"`, `Object.assign(Array.prototype, { constructor: C })` | by declaration |
| `node_modules` files flagged (of 3,838) | 61.8 % | 34.2 % | 12.9 % | 0 |
| packages flagged (of 450) | 76.0 % | 65.3 % | 26.4 % | 0 |
| corpus verdicts moved (of 139), into `NOT_AFFECTED` | 5, 0 | 4, 0 | 0 | 0 |
| real-world validation `NOT_AFFECTED` proofs lost (of 4) | 2 (`RWB-07`, `RWB-11b`) | 2 (the same) | 0 | 0 |
| BL-096 `sound.*` controls lost (of 4) | 4 | 4 | 0 | 0 |

### The trade-off, for the owner

The two rules meant to be sound, (A) and (B), cost half of the real-world
`NOT_AFFECTED` proofs the validation corpus has. `ini` and `url-parse` each
store under computed keys onto objects they did not create, which is what a
parser that can write `__proto__` or `constructor` does. By the task's STOP
condition, no option is forced. Each option's position:

- **(B)** is the narrowest class of stores the inventory shows can reach
  the loader. As prototyped it is **not sound**: it recognises a storing
  builtin by the name it is called under. A storing builtin reached any
  other way (through a local alias, an indirect call such as `call` /
  `apply` / `Reflect.apply`) is not seen, and neither is a store that is
  not an assignment expression. A sound (B) must identify storing builtins
  by identity, through the escape row's account of builtin calls (ADR 0008,
  BL-081's decision record), and must read every store form the escape row
  reads. Its completeness then rests on three uncertified things:
  - that account;
  - the escape row's freshness proofs (BL-094's pending decision);
  - the inventory, which is a property of one Node release (Node rewrites
    its loader between releases).
- **(A)** costs more than (B) and closes nothing (B) leaves open.
- **(B′)** is cheap and keeps every proof, but is unsound by construction.
  It is not offered as a fix.
- **(C)** states in the soundness contract that a `NOT_AFFECTED` assumes
  no loaded file changes Node's builtin prototypes (no prototype pollution
  of the runtime). It records RWF-156 as the contract's stated limitation
  rather than an open defect. It costs nothing and changes no verdict. It
  also narrows what a proof claims, so it is a contract amendment
  (SOUNDNESS-CONTRACT § 1).

**Lean, if one is wanted: (B), implemented as above (by identity, not by
spelling).** AGENTS.md § E puts soundness ahead of precision, and (B) is the
narrowest class measured. Its measured cost is a lower bound, because a
sound detector fires at least as often as the prototype. If the owner takes
(C), the contract text and a disclosure in the result (lane D) carry it,
and BL-111's records move RWF-156 to a documented limitation.

### The independent audit

One fresh-context round returned `BLOCKED`, on a partial review: its run
was cut short before it ran any reproductions.
- **Finding 1:** (B)'s detector recognises storing builtins by spelling. A
  follow-up measurement confirmed it: for three such indirect forms, real
  Node calls the target and the analyzer answers `NOT_AFFECTED`, both on the
  base and under `B.patch`. They are RWF-156's class.
- **Finding 2:** this section overclaimed (B)'s soundness; corrected above.
- **Finding 3:** the freshness proofs (B) relies on should be attacked when
  it is implemented.

`src/` was confirmed unchanged. The census, the corpus moves and the
control counts were not re-checked by the audit.

### What any option leaves open

- **Other Node releases.** The inventory is v22.11.0's. `require()` of an
  ES module (unflagged from v22.12, and in CI's Node 26) may load an ES
  module after a store without `import()`, and that would make the `source`
  read live. Backlog `BL-114` repeats the inventory on Node 20 and 26.
- **Loads the workload did not reach:** ESM hooks (`module.register`),
  workers, `--import` preloads, `import.meta.resolve`.

If (B) is accepted, backlog `BL-113` implements it by identity, not by
spelling (`B.patch` is a measured prototype of the class, not a sound
detector). An oracle sweep over every store form and every route to a
storing builtin, and a certification audit, follow.
