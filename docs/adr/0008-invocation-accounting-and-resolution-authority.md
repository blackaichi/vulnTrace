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
