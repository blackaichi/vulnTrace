# ADR 0008 — Every Invocation Is Accounted For; Every Resolved Edge Has an Authority

Lane A of [`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md). Status:
**proposed** (design only; nothing here is implemented).

## Context

Family C (`docs/SOUNDNESS-CONTRACT.md` § 3) holds only when the reachable
subgraph contains **no unresolved edge**. Two things break that premise
without leaving a trace:

1. **No edge at all** for code that runs. `walkFile` in
   `src/code-intelligence/call-graph.ts` classifies only `CallExpression`
   and `NewExpression`, and `classifyCall` / `classifyNew` return
   `undefined` for ambient globals and Node builtins.
2. **A resolved edge to the wrong place**, which *displaces* the honest
   `unknown` edge (the RWF-043 displacement mechanism).

Reproduced false `NOT_AFFECTED`, all family C:

| Finding | Class | Mechanism |
| --- | --- | --- |
| AUD-01 | 1 | callbacks passed to ambient builtins (`setTimeout`, a `Promise` executor) get no edge |
| AUD-02 | 1 | a module calling its own `exports.x()` gets no edge (`exports` is in the ambient-global list) |
| PRM-12 | 1 | a builtin-bound callee (`fs.readFile(f, lib.parse)`) emits no edge |
| round-1, no ID | 1 | tagged templates are never visited as calls |
| round-1, no ID | 1 | implicit protocol calls: coercion (`toString`), thenables (`await`), `Symbol.iterator` (`for…of`) |
| PRM-19 | 1 | a derived class with no constructor: the synthesized constructor node has no edge to `super` |
| PRM-112 / 113 | 1 | `instanceof` → `[Symbol.hasInstance]`; `for await` → `[Symbol.asyncIterator]` |
| PRM-114 | 1 | `Error.prepareStackTrace = fn`, then `.stack` is read |
| PRM-115 / 116 | 1 | TypeScript decorators (legacy and standard); JSX elements |
| round-2 KNOWN | 1 | `Reflect.apply`/`construct`, `Function.prototype.apply.call`, `defineProperty` get/set, Proxy traps, `toJSON`, iterator spread/destructuring/`yield*`/`Array.from`, `new Readable({ read })` |
| PRM-14 | 1 | `==`/`!=` folded as `===`/`!==`, so a live `if` branch is pruned |
| PRM-15 | 2 | a static `require("x")` is matched by text before the lexical authority; a local `function require` is never seen |
| PRM-13 | 2 | VT-213: an unattributable callee plus one inline callback yields a resolved edge to the callback that displaces the callee's `unknown` |
| PRM-16 / 17 | 2 | VT-210: an exported higher-order function's parameter resolved from same-file call sites only; parameter reassignment (including through `arguments[0]`) ignored |
| PRM-18 | 2 | VT-208: the TypeScript checker's static type used as the runtime receiver |
| PRM-20 | 2 | `bindCallee` truncates a trailing property chain (`api.parse()` → `api`; `lib.a.b()` → `a`; `lib.safe.call.call(lib.parse)` → `safe`) |
| PRM-104 | 2 | a reassigned `function` declaration still resolves to its stale body |
| PRM-108 (origin) | 2 | `extractRequireBindings` records the *local* name as the imported name for a string or computed destructuring key |

## Decision

### 1. The invariants

> **A1 (invocation accounting).** Every *invocation-capable site* in a
> walked file yields an **invocation account**: one or more resolved edges,
> one or more *possible* edges, an unknown edge, or a **no-edge proof**
> from a closed set. There is no fourth outcome. The invocation-capable
> sites are exactly the positive enumeration in § 2.

> **A2 (resolution authority).** A **resolved** edge exists only when an
> authority from a closed set has proved that the callee denotes exactly one
> function at that site on every execution: a stable lexical declaration,
> an exact export with the whole member chain consumed, a forwarding hop
> gated by lane E's write set, a higher-order parameter whose every call
> site is accounted for, a receiver bound once to a `new` expression of a
> class with no member writes, or a documented invoking builtin. Anything
> else is `possible` or `unknown`.

A **possible** edge is a new edge resolution kind (`kind: "possible"`,
carrying its target). Reachability traverses it, so the code behind it is
searched and its own unknown edges count. But a path that uses one can
never be an `AFFECTED` path, and a target reached only through possible
edges is `UNKNOWN`. This is what lets A1 over-approximate implicit and
escaped invocations without manufacturing `AFFECTED` from a path the
program might not take (SOUNDNESS-CONTRACT § 1 requires a *concrete* path),
and without blocking family C when the over-approximated region provably
does not reach the target.

### 2. Enforcement and the structural gate

Where: `call-graph.ts` (`walkFile`, `classifyCall`, `classifyNew`,
`resolveInlineCallbackArgument`, `resolveHigherOrderCallTarget`,
`resolveInstanceMethod`, `evaluateConstantBoolean`); `symbol-binder.ts`
(`bindCallee`); `named-bindings.ts` (`resolveFrom`, function case);
`source-index.ts` (`extractRequireBindings`, the implicit-constructor
entry); `src/analysis/reachability.ts` (the `possible` edge semantics);
`src/domain/graph.ts` (the edge type).

**The positive enumeration of invocation-capable sites** (A1):

| Site | Account |
| --- | --- |
| `CallExpression` | as today, minus the removed no-edge branches |
| `NewExpression` | as today, minus the removed no-edge branches |
| `TaggedTemplateExpression` | the tag, resolved like a callee |
| `Decorator` | the decorator (or the result of a decorator-factory call) is invoked at class definition: resolved or unknown |
| `JsxOpeningElement`, `JsxSelfClosingElement` with a non-intrinsic tag | the component: *possible* (rendering is not guaranteed) |
| class declaration or expression with `extends` and no constructor | synthesized constructor → base constructor: resolved or unknown |
| a function value *escaping* into code the graph does not model: an argument (or spread, or object/array member of an argument) of a call or `new` whose callee is ambient, builtin, unresolved or unknown; the right-hand side of an assignment to a member rooted in an ambient or builtin value; a property descriptor | resolved for a documented invoking builtin, otherwise *possible* when the value is attributable and unknown when it is not |
| a *protocol member*: a method or function-valued property named `toString`, `valueOf`, `toJSON`, `then`, or computed `Symbol.iterator`, `Symbol.asyncIterator`, `Symbol.hasInstance`, `Symbol.toPrimitive`, `Symbol.dispose`, `Symbol.asyncDispose` | *possible*, from the owner that evaluates the definition |
| a call to the module's own `exports.x` / `module.exports.x` | the own export's node, or unknown |
| an `if` whose condition folds | pruned only when folding is a proof: strict (in)equality on literals of the same type |

**The closed no-edge proofs:** `AmbientStaticRequire` (the callee is the
*ambient* `require`, proved lexically, and the specifier's `module_load`
edge accounts for the load); `PrimitiveOnlyArguments` (an ambient or
builtin call whose every argument is provably primitive); `NonInvokingBuiltin`
(an allowlisted member, each entry with a real-Node test showing it does not
invoke a function argument; coercion and inspection are covered by the
protocol-member rule instead); `ProvablyDeadBranch`.

Structural gates:

- **`classifyCall`, `classifyNew` and a new `classifyInvocationSite` return
  `InvocationAccount`**, a closed union, not `CallEdge | undefined`.
  `return undefined` becomes a type error. Every `NoEdgeProof` variant has
  a named owner test.
- **An invocation-site handler table** typed
  `satisfies Record<InvocationSiteKind, Handler>`, and a **syntax-kind
  census** test that classifies every member of `ts.SyntaxKind` as
  invocation-capable or not, so a TypeScript upgrade that adds syntax fails
  the gate until someone classifies it.
- **Resolved edges are constructed only through
  `resolvedEdge(authority, target)`**, where `ResolutionAuthority` is a
  branded type produced only by the authority functions A2 names. Each
  authority gets a mutation test that removes one of its refusals and shows
  a named reproduction become a false `NOT_AFFECTED`.
- **`tests/binding-grammar/` gains the A2 rows**: reassigned `function`
  declaration, `arguments` aliasing, exported higher-order function called
  from another file, trailing chains (`x.y()`, `a.b.c()`, `.call.call`),
  static-type receiver, inline callback with an unattributable callee,
  `==` folding, a shadowed `require`.
- Registered in `src/testing/foundation-invariants.ts` as
  `VT-INV-A1-invocation-accounting` and `VT-INV-A2-resolution-authority`.

### 3. Fail-closed default

An unknown edge, with the existing categories:

- an escaped function value that cannot be attributed, and any
  invocation-capable site not otherwise handled:
  `unmodeled_construct` (existing subtypes such as `unsupported_callee_binding`,
  or a new *subtype* token such as `escaped_callable`, which P1-B1's subtype
  mechanism allows; not a category);
- a target reached only through possible edges: `value_uncertainty` (the
  construct is modeled; whether it runs is not statically established),
  with a new subtype token such as `possible_invocation`.

No seventh category.

### 4. Modeled exceptions that keep precision

- **Documented invoking builtins** (`setTimeout`, `setInterval`,
  `setImmediate`, `queueMicrotask`, `process.nextTick`, the `Promise`
  executor and `then`/`catch`/`finally` callbacks, `Reflect.apply` /
  `construct`, `Function.prototype.call`/`apply`, `Array.from`'s mapper,
  and the array iteration methods): a *resolved* edge to an attributable
  callback. Node's semantics guarantee the call.
- **Non-invoking allowlist** (`console.*`, `Math.*`, `JSON.parse` without a
  reviver, `Object.keys`/`values`/`entries`/`freeze`/…, `Array.isArray`,
  `Number.*`, `Buffer.*`, `path`, `os`, …): no edge. Measured: without it,
  RWB-07 loses a correct `NOT_AFFECTED` (§ 5). Each entry needs a real-Node
  test, and the protocol-member rule covers the coercion these builtins do.
- **Decorators and implicit `super`**: resolved, because the language
  guarantees the call.
- **Static members through a stable class binding** (`Lib.staticMethod()`,
  VT-216) keep the checker's resolution when the class binding is stable
  and nothing in scope writes the member. Measured: refusing them regressed
  ADV2-021.
- **Primitive-only arguments** to ambient calls: no edge (`console.log("x")`
  and `new Date(0)` stay free).

### 5. Precision cost

**Measured** with a throwaway prototype in a scratch clone outside the
repository (never committed), at `62b52b9`. It implements A1's enumeration
(escaped values, tagged templates, decorators, JSX, implicit `super`,
protocol members, own-export calls, global hook assignments, strict-only
folding, lexical `require`) and A2's refusals (VT-213 no longer displaces,
VT-210 refuses escaping functions and parameter writes, VT-208 restricted to
a `const` bound to `new`, trailing chains refused, `function` declaration
stability, string and computed destructuring keys). Three variants:

| Variant | Adversarial (122) | Validation cases (17) | Validation findings (85) |
| --- | --- | --- | --- |
| modeled: allowlists on, over-approximated edges resolved | 1 changed: ADV2-021 `AFFECTED → UNKNOWN` | 0 | 0 |
| **possible → unknown** (the upper bound of the § 1 design: every *possible* edge treated as a blocker) | 1 (ADV2-021) | 0 | 0 |
| strict: no non-invoking allowlist | 1 (ADV2-021) | 1: RWB-07 `NOT_AFFECTED → UNKNOWN` | 1 (the same) |

ADV2-021 is `Lib.staticDangerous()`; the prototype's VT-208 restriction
also refused static members through a stable class binding, which § 4
keeps. The designed configuration therefore has a measured cost of
**0 / 122 adversarial, 0 / 17 cases, 0 / 85 findings**, with ADV2-021 the
named regression test for § 4's static-member exception. Wall time did not
change materially (validation suite 103 s vs 115 s baseline).

All 36 lane-A reproductions flip (15 from round 1, 21 from round 2): to a
correct `AFFECTED` where the escaped or implicit callee is attributable (in
the modeled variant), otherwise to `UNKNOWN`. In the designed configuration,
over-approximated edges are *possible*, so those become `UNKNOWN`, never
`AFFECTED`.

**The repository's own suite** (`npx vitest run`, 4,480 tests) on the
modeled prototype: 5 failures, each assigned to a task in § 8 (the pinned
trailing-chain test, the VT-208 static-member test that § 4 keeps, an
RWF-047 widening row, an RWF-025 control and a P1-B1 subtype label).

**Limits of the measurement.** The validation corpus has 15 definitive
findings (10 `AFFECTED`, 5 `NOT_AFFECTED`); 70 of 85 are already `UNKNOWN`,
mostly for want of a rule, and cannot move further. The corpus therefore
bounds the cost on *definitive* results only. The first implementation task
must re-run exactly this measurement (adversarial and validation tables,
plus the finding-level dump by (case, advisory, instance)) and report any
movement case by case.

### 6. Reopened certified behaviour

| Certified decision | Where | Reopened because |
| --- | --- | --- |
| VT-201: ambient globals "can never be a vulnerable-rule target" → no edge | `call-graph.ts:61-77, 1879-1892, 2158-2161` | AUD-01, AUD-02, round-2 AUD-01 variants |
| VT-305 (RWF-007): a builtin "is a known external runtime module, not uncertainty" | `call-graph.ts:1963-1977, 2163-2168` | PRM-12, `new Readable({ read })` |
| VT-213: an inline callback is "unambiguously the only function value" | `call-graph.ts:1403-1429, 1949-1961` | PRM-13 |
| VT-210 and its RWF-043 hotfixes: same-file call sites, "EVERY authoritative call site is accounted for" | `call-graph.ts:583-599, 691-711` | PRM-16, PRM-17, `arguments` aliasing |
| VT-208 / VT-216: the checker's "apparent type" as the receiver | `call-graph.ts:1530-1546` | PRM-18 (static members kept, § 4) |
| VT-211: "literal-vs-literal equality" folding | `call-graph.ts:1466-1510` | PRM-14 |
| VT-215: an implicit constructor "provably does nothing" | `source-index.ts:280-285` | PRM-19 |
| P1-B3b ladder: static `require` handled before the lexical authority | `call-graph.ts:1744-1748, 1855-1868` | PRM-15 |
| RWF-046 / symbol-binder: "the chain is intentionally not consulted" | `symbol-binder.ts:364-378` | PRM-20 |
| P1-B3: a `function` declaration binding needs no stability check | `named-bindings.ts:82-91, 1243-1244` | PRM-104 |
| TASK-017 structural index: import names for destructured requires | `source-index.ts:396-437` | PRM-108 |

### 7. Interaction with the proof families and RWF-002

- **Family C** is the direct beneficiary. A1 puts back the edges whose
  absence let the search finish, and A2 removes the displacing edges.
- **Family B** reads "absent from the call graph"; more edges make that
  absence more trustworthy, and it keeps its closure corroboration
  (ADR 0011).
- **Family A** is unaffected (loading is lane C).
- **AFFECTED**: resolved edges from documented invoking builtins, decorators
  and implicit `super` can create new, *correct* `AFFECTED` findings. Over-
  approximated edges are *possible* and cannot.
- **RWF-002** is where the cost of A1 is recovered if the corpus ever shows
  one. The new unknown and possible edges are exactly what target-relevant
  completeness must classify. Two constraints for RWF-002's design: an
  escaped function value whose attribution is unknown is irrelevant only if
  the target's package cannot be reached from it (for example, family A's
  closure excludes it); and a possible edge must be treated like a resolved
  one for relevance, never discarded.

### 8. Implementation tasks, in order

| Task | Scope | Reproductions that flip | Existing tests that change |
| --- | --- | --- | --- |
| **A-1** `InvocationAccount` type, syntax-kind census, handler table; tagged templates, decorators, implicit `super` | `call-graph.ts`, `source-index.ts`, `domain/graph.ts` | round-1 tagged template, PRM-19, PRM-115 | tests that assert an edge count for a file containing a derived class with no constructor or a tagged template |
| **A-2** the `possible` edge kind: domain type, reachability semantics, `value_uncertainty` subtype | `domain/graph.ts`, `analysis/reachability.ts`, `domain/uncertainty.ts`, `schemas/` if the edge kind is serialized | none alone (enables A-3, A-4) | `reachability.test.ts` gains the possible-edge cases |
| **A-3** escaped function values and own-export calls; invoking and non-invoking allowlists with real-Node tests; JSX; global hook assignments | `call-graph.ts` | AUD-01, AUD-02, PRM-12, PRM-114, PRM-116, round-2 AUD-01 variants, `new Readable({ read })` | `call-graph.test.ts` VT-201/VT-305 cases asserting "no edge" for calls that pass a function value; the VT-305 no-callback cases (`fs.readFileSync("x")`, `path.basename("x")`) must stay edge-free (`PrimitiveOnlyArguments`); `require-member-write-widening.integration.test.ts` row "W2 Object.defineProperty" (an open-defect record) changed outcome under the prototype and must be re-recorded against lane E's E-4 |
| **A-4** protocol members | `call-graph.ts` | round-1 coercion/thenable/iterator, PRM-112, PRM-113, iterator spread/destructuring/`yield*`/`Array.from`, `toJSON` | none known |
| **A-5** resolution authority, call-graph side: VT-213 no longer displaces; VT-210 refusals; VT-208 restriction with the static-member exception; strict folding; lexical `require`; `function` declaration stability | `call-graph.ts`, `named-bindings.ts` | PRM-13, 14, 15, 16, 17, 18, 104, `arguments` aliasing | **the VT-213 "someUtterlyArbitraryMethodName" test in `call-graph.test.ts`**: it pins the false premise by *omission* (it asserts the callback edge and never the callee's unknown edge, so it still passed under the prototype); A-5 adds the missing assertion that `obj.someUtterlyArbitraryMethodName` carries an unknown edge. Also: VT-210 tests in `call-graph.higher-order-provenance.test.ts` that pass an exported function; VT-211 tests that fold `==`; `call-graph.test.ts` "resolves ClassName.staticMember() to the real static method" and ADV2-021 must stay green (§ 4 static-member exception; both failed under the cruder prototype); `unsupported-construct.test.ts` "does not label a call whose receiver is locally bound and resolvable"; `verdict.destructuring-computed-key-reassignment-cache-poisoning.integration.test.ts` false-AFFECTED control (re-check against the `function`-declaration stability rule) |
| **A-6** resolution authority, binder side: trailing chains; import names for string/computed keys | `symbol-binder.ts`, `source-index.ts` | PRM-20 (all three spellings), PRM-108 origin | **`symbol-binder.test.ts` "ignores a trailing method chain on an already-bound named import"** (pins the false premise: must now expect `not_an_import`, except a single trailing `.call`/`.apply`) |

A-1 and A-2 come first because A-3 and A-4 emit possible edges. A-5 and
A-6 are independent of A-2 and can go in either order after A-1.

## Rationale

Every lane-A defect is either a site the walker never classified or an edge
whose authority was assumed. Both are finite, syntax-level questions: the
set of invocation-capable syntax is a closed enumeration the compiler can
check, and the set of resolution authorities is a closed union the type
system can enforce. The measured cost of the designed configuration on both
corpora is zero; the over-approximation lives in *possible* edges, which
cost precision only where the over-approximated code can actually reach a
target.

## Consequence

The call graph gains one edge kind and loses every silent `return
undefined`. Proof families keep their definitions. Some findings that were
confidently `NOT_AFFECTED` because an invocation was invisible become
`UNKNOWN` or `AFFECTED`, which is the point.

## Decision record — project owner, 2026-09-26

Recorded by task
[`remediation-reconciliation`](../tasks/remediation-reconciliation.md)
(`docs/REMEDIATION-PLAN.md` § 6.1). This ADR's body above is unchanged;
this section is appended, not a revision.

**Decision 1 (non-invoking builtin allowlist, `REMEDIATION-PLAN.md` § 6
item 1).** Accepted, with a stricter entry rule than § 4's text states on
its own. An allowlist entry is admitted only if it runs no user code
through **any** path on its arguments: it does not call, coerce
(`valueOf` / `toString` / `Symbol.toPrimitive`), read properties or
getters of, serialize (`toJSON`), inspect (`util.inspect.custom`), or
trigger Proxy traps on the argument — OR § 2's protocol-member rule
provably covers the path in question. Every entry's real-Node test (§ 2,
"Non-invoking allowlist") must pass function, getter, `valueOf`,
`toString`, `Symbol.toPrimitive`, `toJSON`, `util.inspect.custom` and
Proxy arguments, and confirm none of them runs user code.

**§ 2's protocol-member rule, checked path by path against the seven
required test paths.** § 2's protocol-member row names a closed set:
`toString`, `valueOf`, `toJSON`, `then`, and the computed
`Symbol.iterator`, `Symbol.asyncIterator`, `Symbol.hasInstance`,
`Symbol.toPrimitive`, `Symbol.dispose`, `Symbol.asyncDispose`. § 4 states
this rule "covers the coercion these builtins do."

| Path | Covered by § 2's enumeration? |
| --- | --- |
| function (the builtin calls the argument directly) | Not applicable — a builtin that calls its argument fails the base non-invoking requirement (§ 4) before the protocol-member rule is even relevant; this path is not a coercion/inspection path the rule needs to cover |
| getter (a plain, non-protocol-named accessor property read on the argument) | **Not covered.** § 2's enumeration is a closed list of *named* members and symbols; a generic getter under an arbitrary property name is outside it. A separate real-Node test is required per allowlist entry that reads any such property |
| `valueOf` | **Covered.** Named explicitly |
| `toString` | **Covered.** Named explicitly |
| `Symbol.toPrimitive` | **Covered.** Named explicitly |
| `toJSON` | **Covered.** Named explicitly |
| `util.inspect.custom` | **Not covered.** It appears in neither § 2's enumeration nor § 4's exception list. A separate real-Node test is required per allowlist entry that could inspect its argument |
| Proxy traps | **Partially covered.** A Proxy `get` trap firing because the builtin accesses one of the six named protocol members is covered transitively (accessing that member is itself enumerated). A trap firing on an arbitrary, non-protocol-named property, or `has`/`ownKeys`/`getOwnPropertyDescriptor` firing during enumeration (for example a builtin that spreads or `Object.keys`-enumerates its argument), is **not** covered by name |

This ADR's § 2 protocol-member rule and § 4 non-invoking-allowlist text
are unchanged by this decision; the rule above is not rewritten, per the
project owner's instruction. The stricter entry rule is an additional
admission test for the non-invoking allowlist, layered on top of what § 2
and § 4 already state.

**Decision 2 ("possible" edge kind, `REMEDIATION-PLAN.md` § 6 item 2).**
Accepted as designed (§ 1's option (a)). Task **A-1** (§ 8, above) gains
an acceptance criterion: it must also amend `docs/SOUNDNESS-CONTRACT.md`
and the invariant map to state that an `AFFECTED` path consists of
resolved edges only; a `possible` edge counts as reachable for family-C
completeness (the code behind it is searched, and its own unknown edges
count) but can never be part of an `AFFECTED` path; a target reached only
through `possible` edges is `UNKNOWN`. `docs/SOUNDNESS-CONTRACT.md` itself
is not amended by the `remediation-reconciliation` task — that is A-1's
work, once implemented, per `REMEDIATION-PLAN.md` § 6.1 item 2. This
ADR's § 8 table is not rewritten.

## Amendment A-0 (PROPOSED — requires project-owner decision)

Recorded by task
[`A-0`](../tasks/A-0-adr0008-coverage-reproduction.md). This ADR's body
and its Decision record above are unchanged; this section is appended,
and nothing in it is implemented.

### What was checked

Task A-0 reproduced, on `main` at `276a208`, the implicit invocations
the Decision record's table lists as not covered by § 2's protocol-member
rule. It used the H-0 oracle harness (loud fixture, both controls,
real-Node ground truth, Node v22.11.0) and confirmed each builtin's
behaviour with the H-0 builtin probe. The cases are in
`tests/oracle/adr0008-coverage.test.ts`. For each, the question was
whether a rule of this ADR, as written, makes it `UNKNOWN`. The rules
considered:

- **Escape row** (§ 2): "a function value *escaping* into code the graph
  does not model: an argument (or spread, or object/array member of an
  argument) of a call or `new` whose callee is ambient, builtin,
  unresolved or unknown; […] a property descriptor" → "resolved for a
  documented invoking builtin, otherwise *possible* when the value is
  attributable and unknown when it is not".
- **Protocol row** (§ 2): "a method or function-valued property named
  `toString`, `valueOf`, `toJSON`, `then`, or computed `Symbol.iterator`,
  […]" → "*possible*, from the owner that evaluates the definition".
- **Fail-closed default**: A1, "There is no fourth outcome"; § 2's closed
  no-edge proofs, of which only `PrimitiveOnlyArguments` ("an ambient or
  builtin call whose every argument is provably primitive") and
  `NonInvokingBuiltin` can apply to a builtin call; § 3, "any
  invocation-capable site not otherwise handled"; and Decision 1, "An
  allowlist entry is admitted only if it runs no user code through
  **any** path on its arguments". A builtin call with a non-primitive
  argument whose builtin fails Decision 1's test therefore gets an
  unknown edge.
- **Accessor-body attribution**: not a rule of this ADR. It is the
  existing call-graph behaviour: a getter's or setter's body is
  attributed to the enclosing owner (`tests/validation/FINDINGS.md`
  PRM-118).

| Cases | `main` | real Node | Protocol row | Escape row | Fail-closed default | Closed by this ADR as written? |
| --- | --- | --- | --- | --- | --- | --- |
| S1: `[util.inspect.custom]()` on an object passed by name to `console.log`, `util.inspect`, `util.format("%o")` (PRM-117) | `NOT_AFFECTED` (C) | calls the target | none: not a listed name | none: the argument `obj` is not a function value, and its method is not written as "an object/array member of an argument" | **yes**: all three builtins fail Decision 1 (the probe fires `util.inspect.custom`), and `obj` is not primitive → unknown edge at the call | **yes, by the fail-closed default only** |
| S2: object-literal getter read by `JSON.stringify` / `Object.assign` / `{...o}` / `Object.entries` | `AFFECTED` | calls the target | none | none | at the three calls (each fails Decision 1: the probe fires the getter); `{...o}` is not an invocation-capable site | nothing to close: `AFFECTED` stands, but only because of accessor-body attribution |
| S2: class instance or static getter, the same four readers (PRM-118) | **false `AFFECTED`** | never calls it (own enumerable properties only) | — | — | — | **no.** A2 constrains which function a callee denotes, and `lib.parse` does denote one. The fault is the owner the call is attributed to, which no rule addresses |
| S2: `Object.defineProperty` getter, default (non-enumerable) | `NOT_AFFECTED` (correct) | never calls it | — | "a property descriptor" → possible | — | becomes `UNKNOWN` (a sound precision cost) |
| S2: `Object.defineProperty` getter, `enumerable: true` (AUD-01) | `NOT_AFFECTED` (C) | calls the target | none | **yes**: "a property descriptor" → possible | also: `Object.defineProperty` fails Decision 1 (the probe fires `has` on a Proxy descriptor) | **yes, by the escape row** |
| S3: Proxy with an inline handler, traps `ownKeys` / `has` / `get`, triggered by `Object.keys`, `Object.getOwnPropertyNames`, `in`, `JSON.stringify` (AUD-01) | `NOT_AFFECTED` (C) | calls the target | none: `ownKeys`, `has` and `get` are not listed names | **yes**: each trap is a function-valued "object … member of an argument" of `new Proxy`, whose callee is ambient → possible | at the trigger for the three builtins (each fails Decision 1); none for `in`, which is not an invocation-capable site | **yes, by the escape row**, provided no `NonInvokingBuiltin` entry for `Proxy` pre-empts it. `new Proxy` passes Decision 1's test, and this ADR orders no precedence between the escape row and a no-edge proof |
| S3: Proxy with a handler bound to a `const`, `Object.keys(p)` (AUD-01) | `NOT_AFFECTED` (C) | calls the target | none | none as written: the handler is passed by name | **yes**, at `Object.keys` (fails Decision 1) | **yes, by the fail-closed default only** |
| S3: Proxy with a handler bound to a `const`, `"k" in p` (AUD-01) | `NOT_AFFECTED` (C) | calls the target | none | none as written | **none**: `in` is not in § 2's enumeration, and `new Proxy(target, handler)` passes Decision 1's test, so a `NonInvokingBuiltin` entry for it is admissible and gives "no edge" | **no** |
| S4: an object with a method passed to `Array.isArray` / `Object.is` (precision controls) | `NOT_AFFECTED` | never calls it | — | — | both pass Decision 1 (the probe: no argument kind runs user code) | stays `NOT_AFFECTED`, as required |

Probe results used above, measured by task A-0:

- `new Proxy({}, h)` and `Proxy.revocable({}, h)` run no user code for
  any of the probe's nine argument kinds (function, getter, `valueOf`,
  `toString`, `Symbol.toPrimitive`, `toJSON`, `util.inspect.custom`, a
  fully instrumented callable Proxy, a fully instrumented plain-object
  Proxy). The handler's traps run later, on the operations applied to
  the Proxy.
- `console.log`, `util.inspect`, `util.format("%o")`: `util.inspect.custom`.
  `JSON.stringify`: getter, `toJSON`, Proxy `get` / `ownKeys`.
  `Object.assign`, `Object.entries`, `{...o}`: getter, Proxy `ownKeys` /
  `getOwnPropertyDescriptor`. `Object.keys`: Proxy `ownKeys` /
  `getOwnPropertyDescriptor`. `Object.getOwnPropertyNames`: Proxy
  `ownKeys`. `in`: Proxy `has`.

### Two statements in this ADR that the reproduction shows are inaccurate

1. § 2, `NonInvokingBuiltin`: "coercion and inspection are covered by the
   protocol-member rule instead". Inspection is not
   (`util.inspect.custom` is not a listed name). The Decision record's
   table already says so; PRM-117 reproduces it.
2. The Decision record: "A Proxy `get` trap firing because the builtin
   accesses one of the six named protocol members is covered
   transitively (accessing that member is itself enumerated)." The
   protocol row gives an account to a *definition* named `toJSON`
   (and so on). A Proxy's `get` trap is a definition named `get`, so the
   row gives it nothing. The `get`-trap case (`S3.JSON.stringify.get`,
   whose trap fires on the `toJSON` read) is closed by the escape row
   instead, and only for an inline handler. The list also has ten
   entries, not six.

### Proposed rule change

**Part A: retaining builtins.** This closes the named-handler `in` case
and makes the inline-handler closure unconditional.

> A builtin that **retains** an argument is never a `NonInvokingBuiltin`,
> whatever its admission test shows. To retain an argument is to return,
> or store, an object through which a later operation (a property read
> or write, `in`, enumeration, a call, a construction or a coercion) can
> invoke a function reachable from that argument. Decision 1's
> real-Node test observes only the call itself, so it cannot see a
> deferred invocation. An entry must therefore also be shown
> non-retaining: its real-Node test also applies those operations to the
> call's result, and to the argument afterward, and none may run user
> code. `new Proxy` and `Proxy.revocable` retain their handler and are
> excluded by name. Where § 2's escape row applies, no `NonInvokingBuiltin`
> entry removes its edge.

- *Effect.* `new Proxy(target, handler)` with a handler passed by name
  has a non-primitive argument and no no-edge proof, so it gets an unknown
  edge (§ 3), and the case becomes `UNKNOWN`. With an inline handler, the
  escape row's possible edges stand.
- *Why it is sound.* It only withdraws a no-edge proof. Every site it
  touches falls back to an outcome this ADR already defines (possible or
  unknown), and it adds no resolved edge, so it can create no `AFFECTED`
  path.
- *Precision cost.* The S4 controls are unchanged: `Array.isArray` and
  `Object.is` return a boolean and store nothing, and the probe shows no
  argument kind runs user code, so both stay `NOT_AFFECTED`. Every
  reachable `new Proxy` / `Proxy.revocable` whose handler is not an
  inline literal gets an unknown edge, and blocks family C for its
  entrypoint until RWF-002. In the corpora, `new Proxy` occurs in one
  validation-fixture file (`rwb-05-qs-unused-api/node_modules/object-inspect/test/values.js`,
  a test file the case does not load) and in no adversarial fixture. It
  was not measured on a prototype.
- *Implementing task.* **A-3**, which owns the escape row and the
  non-invoking allowlist with its real-Node tests.

**Part B: accessor bodies.** This closes PRM-118, and keeps the
object-literal getter cases from turning into false `NOT_AFFECTED` when
PRM-118 is closed.

> A `get` or `set` accessor (object literal or class, instance or
> static) is its own owner, like a method. Its body is invoked by a
> *possible* edge from the owner that evaluates the definition, the same
> account § 2 gives a protocol member. It never gets no edge.

- *Effect.* A class getter that is never read reaches the target only
  through a possible edge, so it is `UNKNOWN` (today a false `AFFECTED`).
  An object-literal getter read by a builtin is also `UNKNOWN` (today
  `AFFECTED`: the right verdict, on a path that does not exist).
- *Why it is sound.* It replaces a resolved edge the program may not
  take with a possible edge. Decision 2 makes a possible edge reachable
  for family C, and never part of an `AFFECTED` path. Removing the
  attribution with no replacement edge would not be sound: the
  object-literal getter cases would become false `NOT_AFFECTED`, because
  no rule of this ADR covers a getter read.
- *Precision cost.* The S4 controls are unchanged (they use methods, not
  accessors). Every `AFFECTED` whose only path runs through an accessor
  body becomes `UNKNOWN`. That includes sweep round 2's directly read
  object-literal getter (`const read = o.v`), unless a later task adds a
  resolved edge for a property read of a known accessor. In the corpora,
  accessors occur in RWB-09's `semver` / `semver-vulnerable`
  `classes/comparator.js` and in `lru-cache`. The effect on RWB-09 is
  unmeasured, and the implementing task must measure it (§ 5's method).
- *Implementing task.* **A-4**, which builds the "possible, from the
  owner that evaluates the definition" account for protocol members. An
  accessor needs the same machinery.

**Not proposed.** One option is to extend the escape row to every
function-valued member of any object passed by name to any builtin. That
would close S1 and both named-handler cases directly. But it makes S4
`UNKNOWN` (the method of `obj` in `Array.isArray(obj)` would get a
possible edge), so it fails the precision controls.

S1 and the named-handler `Object.keys` case are closed by the fail-closed
default alone. That closure holds only while Decision 1 keeps
`console.*`, `util.inspect`, `util.format`, `Object.keys` and
`Object.getOwnPropertyNames` off the allowlist. What enforces this is
lane A's acceptance criteria in `docs/REMEDIATION-PLAN.md` § 5a, which
require these cases to become `UNKNOWN`. The open-defect records alone
do not.

## Decision record — Amendment A-0 (project owner, 2026-09-27)

Recorded by task
[`A-0`](../tasks/A-0-adr0008-coverage-reproduction.md), on the project
owner's decision of the `NEEDS_DECISION` that task reported. This ADR's
body, its first Decision record and the text of "Amendment A-0" above are
unchanged; this section is appended.

**Status of Amendment A-0: ACCEPTED**, parts A and B, each with the
conditions below. The acceptance criteria that carry the conditions are
in `docs/REMEDIATION-PLAN.md` (§ 5a, "A-0 additions to lane-A
acceptance"). This ADR's § 8 table is not rewritten.

**Part A (retaining builtins; task A-3). Accepted, with a condition.**

- A builtin is admitted as a `NonInvokingBuiltin` only if it runs no user
  code through any path at the call (Decision 1), **and** it is
  non-retaining: it does not return or store an object through which a
  later operation can invoke user code taken from its arguments.
- `new Proxy` and `Proxy.revocable` are excluded by name.
- The escape rule (§ 2's escape row) always takes precedence over any
  allowlist entry.
- **Condition: mechanical admission.** Every allowlist entry must have a
  passing H-0 builtin-probe test, run in CI, so that an entry whose probe
  fires cannot be admitted by hand. Examples of builtins whose probe
  fires: `console.*`, `util.inspect`, `util.format`, `Object.keys`,
  `Object.getOwnPropertyNames`, `JSON.stringify`, `Object.assign`,
  `Object.entries`. The closure of PRM-117 and of the named-handler
  `Object.keys` case depends on this condition. It is a stated acceptance
  criterion of A-3, the task that builds the allowlist.

**Part B (accessor bodies; task A-4). Accepted, with two conditions.**

- A getter or setter becomes its own owner, reached from its defining
  owner by a *possible* edge. It never gets no edge.
- **Condition 1.** Before merging, A-4 measures the precision cost with
  § 5's method, and reports explicitly RWB-09 (`semver`, `lru-cache`) and
  the full validation and adversarial results.
- **Condition 2.** The plan gains a later precision task, after the
  lanes: model the reader builtins (`JSON.stringify`, `Object.assign`,
  object spread, `Object.entries` and similar) as invoking the own
  enumerable accessors of attributable objects. Correct `AFFECTED`
  results that Part B turns into `UNKNOWN` then become proven `AFFECTED`
  again.

**Considered and rejected.** Extending the escape rule to the members of
any object passed to any builtin. This would break the S4 precision
controls (`Array.isArray(obj)`, `Object.is(obj, x)`), as the amendment's
"Not proposed" paragraph states.

## Corrections to two statements in this ADR (appended 2026-09-27)

Recorded by task
[`A-0`](../tasks/A-0-adr0008-coverage-reproduction.md). The original text
is not rewritten. Each item says what is true instead, with a pointer to
the evidence. Both statements are also named in "Amendment A-0", "Two
statements in this ADR that the reproduction shows are inaccurate".

1. **The Decision record of 2026-09-26, "Proxy traps" row**, says: "A
   Proxy `get` trap firing because the builtin accesses one of the six
   named protocol members is covered transitively (accessing that member
   is itself enumerated)." **This is not true.** § 2's protocol row gives
   an account to a *definition* with a listed name: a method or
   function-valued property named `toJSON`, and so on. The row does not
   account for a property *access*. A Proxy's `get` trap is a definition
   named `get`, so the row gives it no account, whichever property the
   builtin reads. The list also has ten entries, not six. In fact:
   - with an inline handler, the trap is a function-valued member of an
     argument of `new Proxy`, so § 2's escape row gives it a possible
     edge;
   - with a handler passed by name, the escape row as written gives
     nothing. The case is closed by Amendment A-0 part A (accepted
     above), which excludes `new Proxy` / `Proxy.revocable` from the
     allowlist, so the creation site gets an unknown edge (§ 3).

   Evidence: `S3.JSON.stringify.get` (the trap fires on the `toJSON`
   read; `main` answers `NOT_AFFECTED`) and the two `named-handler`
   cases in `tests/oracle/adr0008-coverage.test.ts`; AUD-01's appended
   text in `tests/validation/FINDINGS.md`.

2. **"Inspection is covered by the protocol-member rule."** This
   statement is in § 2's `NonInvokingBuiltin` bullet ("coercion and
   inspection are covered by the protocol-member rule instead"). It is
   in the ADR body, not in the Decision record. The Decision record's
   own table already contradicts it (`util.inspect.custom`: "Not
   covered"). **The inspection half is not true.** § 2's protocol row
   covers coercion (`valueOf`, `toString`, `Symbol.toPrimitive`) and
   serialization (`toJSON`) by name. It does not cover inspection:
   `util.inspect.custom`, which `console.log`, `util.inspect` and
   `util.format("%o")` run, is not a listed name. A method of an object
   passed by name is not "an object/array member of an argument", so the
   escape row does not reach it either. Inspection is closed only by the
   fail-closed default (§ 3), and only while the inspecting builtins stay
   off the allowlist. Amendment A-0 part A's mechanical-admission
   condition (accepted above) is what now enforces that. § 4's clause
   "the protocol-member rule covers the coercion these builtins do" is
   about coercion only, and is not corrected here.

   Evidence: PRM-117 in `tests/validation/FINDINGS.md`; the cases
   `S1.console.log`, `S1.util.inspect` and `S1.util.format-o` in
   `tests/oracle/adr0008-coverage.test.ts`.

## Decision record — allowlist admission ruling (project owner, 2026-09-27)

Decided by the project owner on 2026-09-27; recorded by task
[`task-0-workflow-bootstrap`](../tasks/task-0-workflow-bootstrap.md).
This ADR's body, its earlier decision records, "Amendment A-0" and the
"Corrections" section above are unchanged; this section is appended. It
applies to task **A-3**, which builds the non-invoking allowlist, and is
added to A-3's acceptance in `docs/REMEDIATION-PLAN.md` (§ 5a, "A-0
additions to lane-A acceptance").

**The ruling.** A builtin is admitted to the non-invoking allowlist **per
argument position**. For a position to pass, every hook the H-0 builtin
probe observes firing for that position must be:

- **(a) accounted for by this ADR independently of this call**: a member
  of § 2's protocol list (`toString`, `valueOf`, `toJSON`, `then`,
  `Symbol.iterator`, `Symbol.asyncIterator`, `Symbol.hasInstance`,
  `Symbol.toPrimitive`, `Symbol.dispose`, `Symbol.asyncDispose`), an
  accessor body (Amendment A-0 part B), or a Proxy trap (Amendment A-0
  part A, accounted at the Proxy's creation); **and**
- **(b) proven by an oracle case**: a vulnerable call inside that hook,
  reached through this builtin at this position, never yields
  `NOT_AFFECTED`.

Any other hook fails the position: the builtin calling a function
argument, `util.inspect.custom`, or any method not in the protocol list.

*Example.* `JSON.parse`'s first argument may be admitted, so RWB-07 keeps
its correct `NOT_AFFECTED`; its reviver argument never can, because the
builtin calls it.

*The probe.* The H-0 builtin probe must report "threw" separately from "a
hook fired". Today `probeBuiltinArgKind`
(`src/testing/oracle/builtin-probe.ts`) records a thrown exception in
`fired` as `THREW:<message>` and reports `ranUserCode: fired.length > 0`,
so a builtin that throws reads as one that ran user code.

**Checked when this record was written** (Node v22.11.0). `JSON.parse`'s
first argument fires `toString` and `Symbol.toPrimitive` for the objects
that define them, and Proxy `get` traps for a Proxy; for every other probe
kind (function, getter, `valueOf` alone, `toJSON`, `util.inspect.custom`)
it throws with no hook fired. Every hook it fires is in (a), so the
example holds, subject to (b). The probe's reporting of a throw is as
stated above.

**How it relates to the conditions already accepted.** Recorded here so
A-3 does not have to reconstruct it:

- It **refines Decision 1** (2026-09-26), which admitted an entry only if
  it runs no user code through any path "OR § 2's protocol-member rule
  provably covers the path". The ruling states what "covered" means (the
  three accounted kinds in (a)), requires a proof for each (b), and moves
  the unit of admission from the builtin to the argument position.
- It **keeps Amendment A-0 part A's conditions**: an admitted position
  must still be non-retaining; `new Proxy` and `Proxy.revocable` stay
  excluded by name; the escape row still takes precedence over every
  allowlist entry.
- It **keeps mechanical admission** (part A's condition): admission is
  decided by a probe test run in CI that reads which hooks fired and
  checks each against (a), never by hand. What changes is the reading of
  that condition's example list. `console.*`, `util.inspect` and
  `util.format` still fail, because their probe fires
  `util.inspect.custom`, so PRM-117's closure stands. `Object.keys`,
  `Object.getOwnPropertyNames`, `Object.entries` and `JSON.stringify`
  (first argument) fire only accessor bodies, listed protocol members or
  Proxy traps (the probe results under "Amendment A-0"), so a position of
  theirs **may** now pass, if (b) holds and it is non-retaining. The
  named-handler cases (`S3.Object.keys.ownKeys.named-handler`,
  `S3.in.has.named-handler`) stay closed by part A's exclusion of
  `new Proxy` at the creation site, which (b)'s oracle case for
  `Object.keys` must confirm.

## Decision record — iterator methods and unreadable keys (project owner, 2026-10-04)

Decided by the project owner on 2026-10-04, before task
[`A-4`](../tasks/A-4-protocol-members.md) wrote its task file; recorded
by that task. This ADR's body and every earlier section are unchanged;
this section is appended.

**Decision 1 (iterator methods). Accepted.** § 2's protocol-member row
gains `next`, `return` and `throw`. Every consumer of an iterator --
`for…of`, spread, array destructuring, `yield*`, `for await…of`, the
iterating builtins -- calls the `next` method of the object
`[Symbol.iterator]()` returns, `return` on an early exit and `throw`
through `yield*`. With the row's closed list as written, an iterator
class (`[Symbol.iterator]() { return this; } next() {…}`) or a literal
iterator stays a false `NOT_AFFECTED`: reproduced against real Node by
task A-4 and registered as RWF-068 (`tests/validation/FINDINGS.md`).
Measured cost on the corpora: no verdict changed over the 139 cases.

**Decision 2 (a value under a key that cannot be read). Fail closed.** A
key is a protocol key unless proven otherwise; a computed key the
analyzer cannot read may be `"toString"` at run time. A value the graph
cannot attribute, stored under such a key (`o[k] = v`, `{ [k]: v }`, a
class field `[k] = v`), gets an unknown edge (`protocol_value`, a subtype
of `unmodeled_construct`; § 3). An attributable function there gets a
possible edge in any case. Measured cost on the corpora: no verdict
changed over the 139 cases; RWB-05 (already `UNKNOWN`) gained five
`protocol_value` reasons. The cost on real projects with property-copy
loops is not measured.

## Decision record — BL-081: a store onto an object not proven to be the program's own is an escape (2026-10-16)

Taken by task [`BL-081`](../tasks/BL-081-builtin-replaced-without-name.md)
on the project owner's go of 2026-10-16, given on the announced plan
(measure both options of RWF-110, take the one the measurements support,
record it here for the owner to confirm by merging). This ADR's body and
every earlier section are unchanged; this section is appended.

**The question.** § 2's escape row makes a store an escape when its target
is "a member rooted in an ambient or builtin value", which A-3a read as a
store that SPELLS the value: its ambient name, a `const` alias, a builtin
module binding. § 4's builtin table then trusts a call of the builtin by
its identity at the call site. But a builtin object reaches a user binding
through routes no spelling shows -- a parameter (`install(Object)`), a
container, a returned value, a load, `({}).constructor`, `__proto__`,
`Object.getPrototypeOf`, a sloppy call's `this` -- and a store through any
of them replaces what the trusted call runs (RWF-110, RWF-063; with RWF-120,
seventy-four live false `NOT_AFFECTED`s on the base, measured against real
Node).
RWF-110 named two options: **(a)** a store through a base that may be a
builtin object is an escape; **(b)** every builtin call is unresolved
whenever a module that may run can replace a builtin.

**Decision: option (a), in the form "unless proven".** The routes to a
builtin object are unbounded, so (a) is decided by the converse: a store
is an escape unless the object it writes onto is PROVEN to be one the
program created (`escape-row.ts`, `isProvenFreshObject`; the proofs and
their inductive argument, over a closed list of store forms, are in its
comment). The escape's account is § 2's: a possible edge from the storing
owner to each attributable function stored, an unknown edge for anything
else. The store forms are an assignment (every destructuring target
too), a `for…of` head, a bare name or a `var` in a `with` body, and a
derived class's instance field or parameter property (RWF-120; the last
three found by this task's independent audit, whose later rounds found
the pattern, own-member, decorator, `prototype`-route and [[Prototype]] gaps below; ten rounds in all, each recorded in FINDINGS RWF-063, RWF-110 and RWF-120). What a pattern or a `for…of`
head stores is read from its source or yielded by an iterator: an
iteration always adds an unknown edge (an array literal's or a string's
iterator can be replaced too), and an object pattern is attributed only
from an object literal one level deep; a binding pattern's defaults are
stored values. A function or class that may carry its own members (a
static member, a base class, a decorator, a merged namespace, a store onto
one of its members in its own file through any route a freshness proof
accepts, followed by one relation that answers "unknown" when a route is
handed on) is also an opaque value wherever it is handed over, from its
own file or another (`G.Math = K`, then `Math.max(1)` runs `K.max`); a
function or class an escaping store or a builtin call may store under a
`prototype` or `exports` key is one too. A decorated class is never proven
fresh, nor its static `this`; nor an async function's `prototype`
(inherited), an object whose [[Prototype]] a `__proto__` or computed-key
store may change (an inherited setter would run -- the global object's
own, too), or a TypeScript declaration that binds no run-time value. A builtin's own function stored there, or handed to a
builtin at a non-admitted position, is fail-closed whatever else the
value holds.

**Why not (b).** (b) cannot close the class alone: Node invokes a
replaced builtin member where the program has no call of it --
`[].__proto__.join = f; String([1])` runs `f` through
`Array.prototype.toString`, `"abc".replace(/b/, …)` runs a replaced
`RegExp.prototype.exec` (measured) -- so there is no call site for (b) to
make unknown, and (b) needs (a)'s detection and account anyway. Measured
as an upper bound (every builtin callee unattributed), (b) loses 2,013 of
the 31,641 `node_modules` graph nodes whose search region had no unknown
edge; (a) loses 1,880 (5.9 %) and gains none (`scripts/bl081-builtin-store-escape-corpus.mjs`,
no time limit: a first, time-capped measurement gave load-dependent
numbers and is not quoted).

**Rejected refinement: keying the escape by member name.** Escaping only
stores under a name some builtin member has (`keys`, `join`, …) costs
less (measured only with a time cap, not quoted), but its soundness rests
on a claim no table can carry: Node reads members of its own objects by
names they do not have by default -- dictionary objects such as an
emitter's `_events` -- so a store under any name can matter.

**Cost.** No corpus verdict moved (139 cases); 1,880 of 31,641 clean
`node_modules` graph nodes; six oracle controls of earlier tasks answer
`UNKNOWN` (a store through a parameter, an array element, a load's
`module.exports`, `arguments.callee`, `helper.caller`), each marked as
this decision's cost. Not addressed: a documented invoking builtin keeps
its resolved callback edge after a replacement (RWF-121, a false
`AFFECTED`, backlog `BL-090`).

**The class is not certified closed.** The task's independent audit ran
ten rounds; each of the first ten found further store forms, value flows
or key spellings the proofs had missed, every one a live false
`NOT_AFFECTED` on the base as well, and each fixed on the branch. By the
project owner's decision of 2026-10-18 the tenth round was the last: its
two findings (RWF-122, a builtin call's key read through fewer forms than
its value; RWF-123, a lookup cache that ignored a `with` body) were fixed
after it as its auditor proposed and measured, without a further round.
Backlog `BL-091` re-audits them and the class; FINDINGS RWF-110, RWF-063
and RWF-120 are "fixed in part" until then. The precision figure above
was measured on the code before those two fixes, which only add edges.


## Note on the BL-081 decision record — BL-091's re-audit (2026-10-19)

Appended by task [`BL-091`](../tasks/BL-091-builtin-store-reaudit.md);
the decision record above is unchanged. BL-091 re-audited the rule in
three fresh-context rounds, each measured against real Node. RWF-122's
and RWF-123's fixes held. Each round found further live false
`NOT_AFFECTED`s in the class, all also on BL-081's base, and BL-091 fixes
them (RWF-127 in part, see below). They refine which objects the rule proves the program's own:

- **A class inherits.** A derived class's `prototype` inherits from its
  base's `prototype`, which a store onto a fresh function can make the
  global object (RWF-124). A derived class's static side inherits its
  base constructor's members and accessors (`class D extends util.inspect
  {}`; RWF-126). So a derived class's `prototype` is never proven the
  program's own. A derived class, and `this` in its static blocks and
  static fields, is proven only when its `extends` expression is.
- **TypeScript's emit is what runs.** The analyzer reads a TypeScript
  source, and Node runs its emit. Below target ES2022 a static field is
  emitted as an assignment, which runs an inherited setter (RWF-127). At
  target ES5 a class is a function whose `prototype` is writable
  (RWF-128). The analyzer does not read the target, so every TypeScript
  file is taken as that emit for these two forms. Two more stores the same
  emit makes, through a namespace merged with a class (RWF-131) and a
  field named `__proto__` (RWF-132), were found by BL-091's independent
  audit. Task BL-095 covers them, and the wider class they belong to: a
  namespace's exported members and an enum's members are stores onto an
  object the emit creates or reads, a use of a namespace's exported
  variable is a member access on it, and a legacy-emit field or parameter
  property is an assignment, under a key the freshness proofs read
  (`namespaceObjectIsOwn`, `enumObjectIsOwn`, `legacyFieldStoreKeys`,
  `legacyFieldTargetIsOwn` in `escape-row.ts`). Task BL-099 carried the
  member access into call resolution: an exported variable used in its own
  block, and every name a use walks out of a namespace for (the merged
  symbol's members are not all in the file's syntax), is an unknown callee,
  never the declaration's initializer or an outer declaration spelled the
  same (RWF-141, `namespace_member` in `named-bindings.ts`). Task BL-100
  carried the `Decorator` row past the call: what a decorator returns is
  handed to TypeScript's helpers, which install it, run it as an
  initializer, or make it the class, so its returned values get the escape
  row's account at a non-admitted position (`decoratorResultOf`,
  `decoratorResultEdges` in `call-graph.ts`; RWF-142), and a construction
  of a class a class decorator may replace gets a possible edge to the
  declared constructor, never a resolved one (`replacedClassEdges`;
  RWF-149). Both decorator modes are assumed (the mode is not read).
  Still not covered: a JavaScript source compiled with Babel's or swc's
  loose class fields (not measured).

**The class is still not certified.** Every one of the thirteen audit
rounds, BL-081's ten and BL-091's three, found further shapes, and so
did BL-091's independent audit. BL-091's were all an inherited accessor,
or a store the source does not show.
Whether the rule should prove less (for example no class at all) or read
more of the build (the TypeScript target, the transpiler) is the project
owner's decision, backlog `BL-094`. The precision cost of BL-091's
refinements, measured with `scripts/bl081-builtin-store-escape-corpus.mjs`
against BL-081's merge: no clean `node_modules` graph node lost, and no
corpus verdict moved.

## Proposed decision — BL-094: the escape row's "unless proven" rule (PROPOSED — requires project-owner decision)

Recorded by task [`BL-094`](../tasks/BL-094-escape-row-decision.md). This
ADR's body and every earlier section are unchanged; this section is
appended, and nothing in it is implemented. It answers the question the
note above hands the project owner: keep point-fixing the rule, prove
less, or read more of the build.

### What was measured

All on the base `842e808` (BL-105's merge), Node v22.11.0, TypeScript
5.9.3. Every script is in `scripts/bl094-escape-options/`.

**The inventory** (`inventory.mts`). Every oracle case of the five tasks
that built and re-audited the rule (BL-081, BL-091, BL-095, BL-099,
BL-100) whose `base` verdict was `NOT_AFFECTED` while real Node runs the
replacement: 195 historical false `NOT_AFFECTED`s, classified by the
clause they broke.

| axis | BL-081 | BL-091 | BL-095 | BL-099 | BL-100 | all |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| the rule absent (a builtin reached without its name, before BL-081) | 15 | 0 | 0 | 0 | 0 | 15 |
| a TypeScript emit (a store, read or call the source does not show) | 0 | 5 | 48 | 30 | 17 | 100 |
| a store form the closed list missed | 19 | 0 | 0 | 0 | 0 | 19 |
| a class (inheritance, its `this`, static side, `prototype`, members) | 5 | 21 | 0 | 0 | 0 | 26 |
| a non-class object's [[Prototype]] | 6 | 0 | 0 | 0 | 0 | 6 |
| a value or key route, or the proofs' bookkeeping | 29 | 0 | 0 | 0 | 0 | 29 |

Two facts follow. Both are classifications of the cases' own `finding`
and `mechanism` fields, not measurements of what a tier would have
pre-empted: every prototype below carries every point fix already made.
**Every one of the 121 historical false `NOT_AFFECTED`s registered after
BL-081** (BL-091's 26, BL-095's 48, BL-099's 30, BL-100's 17) **is a class
or a TypeScript emit**: BL-091's three re-audit rounds over the whole rule
found none in the store forms, the routes or a non-class object's
[[Prototype]]. (BL-081's own ten rounds are one suite; the inventory does
not tell them apart.) And **of the 100 TypeScript-emit cases, 47 are not
in `isProvenFreshObject` at all**: BL-099's 30 (RWF-141 23, RWF-147 6,
RWF-145 1: a namespace member's scope in call resolution) and BL-100's 17
(RWF-142 16, RWF-149 1: a decorator's result handed to TypeScript's
helpers, an account BL-100 gave in the escape row, but through no proof
clause). No change to the freshness proofs reaches them.

**One exception, found by this task's independent audit: RWF-151**, a live
false `NOT_AFFECTED` pre-existing on the base and present in every tier
but O2d. An object whose chain reaches `Array.prototype.toString` gets an
own `join`, stored (`const a = []; a.join = f`) or defined (`{ __proto__:
[], join: f }`), and coercing it (`String(a)`, `"" + a`, a template,
`Math.max(a)`) runs `f`. `join` is not a protocol member, so the
protocol-member row gives it no edge. The definition form never reaches
`isProvenFreshObject`: it is that row's gap (backlog `BL-109`), not the
freshness proofs', though its stored form passes through a clause every
tier keeps.

**Option O3, read the build** (`o3-emit-probe.mjs`). One TypeScript source
(RWF-126/RWF-127's shape: a static field on a class derived from
`util.inspect`) under one tsconfig, turned into what Node runs by each
tool the repository has, then run:

| tsconfig | `tsc` | esbuild (tsx, vite-node) | `node --experimental-strip-types` |
| --- | --- | --- | --- |
| target ES2020 | the setter runs (assign) | the setter runs (assign) | nothing runs (define) |
| target ES2022 | nothing runs (define) | nothing runs (define) | nothing runs (define) |
| target ES2022, `useDefineForClassFields: false` | the setter runs | the setter runs | nothing runs |

`tsc` and esbuild agree in every row; Node's own type stripping, which
reads no tsconfig at all, runs a different program from theirs under the
same tsconfig (target ES2020, or `useDefineForClassFields: false`). A
tsconfig is a statement about the tools that read it, not about what
runs: ADR 0010's C2 ruling for
module resolution, measured here for the emit. Babel's and swc's loose
class fields, which can assign where the tsconfig says define, are not
installed and not measured. And the emit's stores that do not depend on
the target at all -- a namespace's members, an enum's, a decorator's
helpers -- are untouched by any build setting.

**Options O2, prove less** (`*.patch`, each applicable to the base with
`git apply`). Each tier refuses more of `isProvenFreshObject`'s proofs;
refusing a proof only makes more stores escapes, so no tier can produce a
`NOT_AFFECTED` the base does not:

- **O2a0** — no derived class is proven (`extends` anything);
- **O2a** — no class at all (value, `this`, `prototype`, field target);
- **O2b** — O2a, and no object a TypeScript emit creates (a namespace's,
  an enum's);
- **O2c** — O2b, and no `this` and no `prototype`: literals, functions
  and the CommonJS `module` / `exports` / `module.exports` only;
- **O2d** — nothing is proven (the upper bound of the cost);
- **O2e** — O2a0 everywhere, and O2b in a TypeScript source only (a
  class, its `this` and `prototype`, a namespace's and an enum's objects
  are never proven where the emit, not the source, decides them).

Each measured separately: the real-Node oracle suite (1,304 tests; the
base passes all), the differential over the 139 corpus cases
(`scripts/differential.mjs`, base `842e808`), and the clean-node precision
of `scripts/bl081-builtin-store-escape-corpus.mjs` (183 JavaScript and 12
TypeScript `node_modules` packages, base 29,748 and 1,180 clean nodes).

| option | oracle failures (all precision: control → `UNKNOWN`, negative control → `UNKNOWN`) | graph differential | proof differential | verdict differential | JavaScript clean nodes lost | TypeScript clean nodes lost |
| --- | --- | --- | --- | --- | ---: | ---: |
| O2a0 no derived class | 4 (4, 0) | 0 cases | 0 | 0 | 0 | 0 |
| O2e hybrid | 22 (14, 8) | 0 cases | 0 | 0 | = O2a0 | 10 |
| O2a no class | 23 (16, 7) | 2 cases, +56 sites | 0 | 0 | 206 | 10 |
| O2b + no emit object | 26 (18, 8) | 2 cases, +56 sites | 0 | 0 | = O2a | 10 |
| O2c literal core | 29 (21, 8) | 2 cases, +98 sites | 0 | 0 | 207 | 10 |
| O2d no proof | 876 (90, 779; 6 open-defect records flip, 1 harness self-test) | 69 cases, +593 sites | 25 | 1 (`RWB-07` `NOT_AFFECTED` → `UNKNOWN`) | 677 | 25 |

No tier produced a `NOT_AFFECTED` the base does not, in any suite. "=
O2a" and "= O2a0" are equal by construction, not measured: O2b's and
O2e's further cuts are reachable only from TypeScript syntax (a namespace,
an enum) or are guarded by a TypeScript-source check, which no JavaScript
file reaches. The two graph cases of O2a, O2b and O2c are `RWB-09a` and
`RWB-09b` (a real package; their verdicts are D-09 known failures,
unchanged).

### Recommendation

**Adopt O2e: the rule proves less exactly where its findings came from,
and stops point-fixing there.** Concretely, `isProvenFreshObject` keeps
its proofs for literals, functions, a function's `prototype` through its
checked stores, a base class and its `this` and `prototype` in a
JavaScript source, the CommonJS `module` / `exports` / `module.exports`,
and a module's top-level `this`; and it refuses:

1. **every derived class** (`extends` anything), in any source: its static
   side, its `prototype` and its instances inherit from an object no
   syntax-local proof can establish. This deletes the recursive `extends`
   proof (`hasOwnStaticChain`'s second branch), the mechanism of RWF-124
   and RWF-126 (21 of BL-091's 26 findings);
2. **in a TypeScript source, every class** (its value, `this`, `prototype`
   and a field's target), **every namespace's object and every enum's
   object**: there the emit, not the source, decides what the object is
   and which stores run, and the emit is not knowable from the project
   (O3's probe). This deletes `classPrototypeIsStable`, the class branches
   of `namespaceObjectIsOwn` and `legacyFieldTargetIsOwn`, and the
   namespace and enum ownership proofs -- the clauses behind RWF-127,
   RWF-128, RWF-131 and RWF-132.

Why O2e over the others: it is the only tier that removes both axes and
costs no JavaScript corpus precision (0 of 29,748 clean nodes; its cuts
beyond O2a0 never run on a JavaScript file; in the oracle suites its
JavaScript cost is two controls, RWF-126's classes derived from the
program's own), its TypeScript cost is O2a's (10 of 1,180), and no corpus
verdict, proof or graph moves. O2a, O2b and O2c also refuse a
JavaScript base class, which costs 206--207 clean nodes and no finding of
the inventory justifies: a JavaScript base class's chain is
`Function.prototype` / `Object.prototype`, the same as a function's,
whose proof has had no finding since BL-081. O2d is not usable (876
oracle tests, `RWB-07`'s correct `NOT_AFFECTED` lost). O1 has no stated
end condition: after BL-081, the inventory's 121 consecutive findings are
all a class or a TypeScript emit, 74 of them classified in the proof
clauses O2e removes (BL-091's 26, BL-095's 48); RWF-151, found after them,
is another row's gap (above).

**Not adopted: O3.** A tsconfig cannot establish the emit (the probe
above); reading it would trade soundness for precision, which ADR 0010's
C2 ruling refused for resolution. A later precision task may consult the
build only as C2 does, as a cross-check that can refuse a proof, never
grant one.

**What O2e does not close, stated so it is not overclaimed:**

- **The stores TypeScript's emit makes that the source does not show.**
  O2e makes every such store an escape *when it is seen as a store*; it
  does not make it seen. An ES5 class's methods (`C.prototype.m = …`,
  RWF-143, backlog `BL-101`) are the known unseen one. Under O2e every
  TypeScript class's `prototype` is unproven, so BL-101's fix direction
  would make every method of every TypeScript class an escape: a cost not
  measured here, which BL-101 must measure before it lands.
- **The TypeScript emit outside the escape row**: 47 of the inventory's
  cases (a namespace member's scope in call resolution, RWF-141 and
  RWF-147; a decorator's result handed to TypeScript's helpers, RWF-142
  and RWF-149), and the open RWF-145, RWF-146, RWF-148 and RWF-150's
  family. They share one cause: the analyzer reads a TypeScript source
  while Node runs an emit of it. That is a design question for its own
  task (backlog `BL-108`), not for this rule.
- **A member a builtin invokes implicitly** (RWF-151, backlog `BL-109`):
  an own `join` on an object whose chain reaches `Array.prototype.toString`,
  stored or defined; the protocol-member row's account.

**Certification criterion.** The class is certified when one fresh-context
audit round over the reduced proof list, attacked against real Node,
finds no live false `NOT_AFFECTED` whose mechanism is a kept proof clause
itself. The test is by mechanism: a finding is the clause's when it
depends on the object being proven the program's own -- it no longer
reproduces once the object is unproven (an unknown parameter, say) -- and
does not reproduce with the member defined in the object's own literal
instead of stored. Such a finding drops that clause, rather than starting
another round of point fixes: a clause O2c also drops costs at most O2c's
measured 207 clean nodes; dropping one O2c keeps (literals, functions, the
CommonJS `module` / `exports`) is not measured, and lies between O2c's
cost and O2d's 677. Any other finding is another row's gap and is fixed
in that row, and the clause stays: RWF-151 reproduces in the definition
form, which no freshness proof touches, so it is the protocol-member
row's.

**Implementing task**: backlog `BL-107`. The controls that lose precision
(O2e's 22 oracle tests: 14 controls and 8 negative controls, all in a
TypeScript source or a derived class, two of them JavaScript) become the
decision's recorded cost, as BL-081's six were; none is pinned as a wrong
verdict. The prototype's sentinels (`bl094Option()`, `parent !==
undefined`, `false &&`) are measurement hacks: BL-107 deletes the refused
proofs instead.

## Decision record — BL-109: a member a builtin calls on its receiver by name (project owner, 2026-10-25)

Decided by the project owner on 2026-10-25, during task
[`BL-109`](../tasks/BL-109-join-protocol-member.md), from the measurements
below; recorded by that task. This ADR's body and every earlier section are
unchanged; this section is appended. It amends § 2's protocol-member row
and the allowlist admission ruling's condition (a).

**The gap.** A coercion, `JSON.stringify` or `for await` may run an
INHERITED builtin that calls a further member of its receiver by name, with
no call in the program. § 2's row keyed only the names the operation itself
invokes. RWF-151 (`join`, through `Array.prototype.toString`) is one; the
task's inventory found the rest (`scripts/bl109-implicit-receiver-methods.mjs`,
real Node v22.11.0, 795 prototypes and objects of Node's globals and builtin
modules, the coercions, iterations, `await`, `JSON.stringify` and the
admitted builtin positions): `toISOString` (`Date.prototype.toJSON`),
`utf8Slice` (Node's `Buffer.prototype.toString`, on Node 20 and 22; Node
26 calls an internal binding instead, and adds `off`, `removeListener`,
`values` and `listenerCount` under `for await`), and, under `for await`
over an object inheriting a Node stream, `on`, `read`, `push`, `emit`,
`destroy`, `_read` and `_destroy` -- Node's own JavaScript, which a release
may change, so no list of names closes it (RWF-152).

Which routes were live (oracle cases on the base `b256b6d`,
`tests/oracle/bl109-implicit-receiver-methods.cases.ts`): an array the
program creates is proven its own (`isProvenFreshObject`), so a `join`
stored onto it, or onto `A.prototype = []`, got no edge; and a member
DEFINED in an object literal that sets `__proto__` got none, whatever its
name, since a definition never reaches the escape row. So did a member of
a DERIVED class, whose `prototype` inherits its base's with no call
(`class D extends Date { toISOString() {} }` and `JSON.stringify(D.prototype)`;
RWF-153, found by the task's independent audit): a construction of one is
an unknown edge, but its `prototype` needs none. Every other route to such a
chain already failed closed through the escape row: a store onto a
`__proto__` literal or a builtin's result, `Object.setPrototypeOf`, a
`__proto__` store, a constructor's `this` under a replaced prototype.

**Decision 1. Accepted.** § 2's row gains `join`, everywhere a protocol
name applies (`PROTOCOL_NAMES`): an array's chain is
`Array.prototype.toString`'s, with no call in the program.

**Decision 2. Accepted.** Every member an object literal defines -- a
method, a property, a shorthand, a spread's values, a getter's returned
value -- is a protocol member, whatever its key, when the literal sets its
[[Prototype]] (`__proto__: p` or `"__proto__": p`, not a computed or
shorthand key) to a value not proven to be `null` or an object literal that
does not itself set one (`inheritsUnprovenPrototype`,
`src/code-intelligence/protocol-members.ts`). The `__proto__: p` property
itself defines no member.

**Decision 3. Accepted** (from the independent audit's finding, RWF-153).
Every member a class with an `extends` clause other than `extends null`
defines -- a method, a field's value, an accessor's returned value, static
ones too -- is a protocol member, whatever its key (`isDerivedClass`). No
base is exempt, the program's own class neither: proving a base's chain
ordinary is a proof surface of its own (a base re-prototyped later), left
for a precision task if its cost calls for one.

**Decision 4, which follows.** The allowlist admission ruling's condition
(a) accounts a fourth kind of hook: a member of such a literal or class.
The builtin probe builds the inventory's receivers (`join`, `toISOString`,
`utf8Slice`, `streamRead`); condition (b) has a case through a `__proto__`
literal (`join`: a stored array) and one through a derived class's
`prototype`; and every admitted position passes conditions (a) and (b) with
them.

Measured cost (`scripts/bl081-builtin-store-escape-corpus.mjs`, base
against this change, over this repository's `node_modules`): decisions 1
and 2 alone, 5 of 29,748 clean JavaScript graph nodes lost (183 packages,
113,778 nodes), +22 unknown and +27 possible edges; with decision 3, 293 of
29,748 lost, +629 unknown and +11,845 possible edges, and 32 of 1,180 clean
TypeScript nodes (12 packages, `--typescript`). Over 2,525 JavaScript files:
27 `join` definitions, 6 `__proto__` literals, 1,258 derived classes of
2,231 (8,067 members). One oracle precision control moves to `UNKNOWN`
(BL-091's static field of a class derived from the program's own). The
corpora's differentials are in the task's report.
