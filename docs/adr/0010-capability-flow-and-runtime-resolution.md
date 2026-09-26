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
