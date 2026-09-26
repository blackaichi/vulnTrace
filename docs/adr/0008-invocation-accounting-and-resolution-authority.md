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
