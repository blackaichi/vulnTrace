# A-3b — Own-export calls; JSX

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: A-3b
- **Branch**: a-3b-own-exports-jsx
- **Base SHA**: 32dcbf92cab7cef1fad36bedd3c61599de797381
- **Commits**:
  - `3fb314e` docs(tasks): A-3b task file — own-export calls, JSX
  - `33a5d11` test(A-3b): real-Node reproductions — own-export calls, JSX, the automatic runtime's load
  - `f071d96` fix(A-3b): own-export calls and module-scope callees, JSX sites, the JSX runtime's load
  - (this commit) docs(A-3b): records — findings, debts, plan § 5a, contract, backlog, progress, scorecard
- **Superseded by**: —

## Project context

Fourth task of lane A of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 4), the
second half of backlog row `A-3`, which the project owner split on
2026-09-30 ([`A-3a`](A-3a-escaped-values.md), "Which half owns what").

The specification is
[ADR 0008](../adr/0008-invocation-accounting-and-resolution-authority.md)
§ 2: the JSX row ("`JsxOpeningElement`, `JsxSelfClosingElement` with a
non-intrinsic tag | the component: *possible* (rendering is not
guaranteed)"), the own-export row ("a call to the module's own
`exports.x` / `module.exports.x` | the own export's node, or unknown"),
the escape row, and § 3's fail-closed default. The acceptance lines are
REMEDIATION-PLAN § 5a's "A-2 additions" (producer obligations, for the
`possible` edges this task emits) and "A-3a additions" (A-3b:
`module_scope_callee` is removed or its remainder named in the ledger).

Findings closed: AUD-02, PRM-116.

Premises, checked against `main` at the base SHA (`AGENTS.md` § D):

- **Measured.** `classifyCallee` and `classifyConstructee`
  (`src/code-intelligence/call-graph.ts`) return
  `unproven_no_edge("module_scope_callee")` for any callee whose root
  identifier is an undeclared CommonJS module-scope binding (`module`,
  `exports`, `require`, `__dirname`, `__filename`;
  `isModuleScopeRoot`, `escape-row.ts`), after the loader classifier,
  the static-`require` check and the lexical authority, and before
  VT-208, VT-210 and VT-214. It is the only unproven reason left on the
  builtin side (`UNPROVEN_NO_EDGE_LEDGER`, `src/domain/graph.ts`).
- **Measured (real Node v22.11.0, the oracle harness).** AUD-02
  reproduces in all three spellings the audit names, inside the
  vulnerable package itself: `exports.run = function (x) { return
  exports.parse(x); }`, `module.exports = { …, run(x) { return
  module.exports.parse(x); } }`, `exports["parse"](x)`, the application
  calling `lib.run(1)`: family C `NOT_AFFECTED`, real Node calls `parse`.
- **Measured.** PRM-116 reproduces: with `jsx: react`,
  `jsxFactory: "h"`, `function h(tag, props) { return tag(props); }`,
  `function App() { return lib.parse("x"); }`, `<App />`: family C
  `NOT_AFFECTED`, real Node calls `parse`. A JSX element has no
  invocation account at all: the census classifies
  `JsxOpeningElement`, `JsxSelfClosingElement` and `JsxOpeningFragment`
  as `pending` (A-3b), and `invocationSiteOf` returns `undefined` for
  them. The factory call is also invisible: `<div />` with a classic
  factory `h` that calls the target is family C `NOT_AFFECTED`.
- **Measured, new (registered by this task).** With the automatic JSX
  runtime (`jsx: react-jsx`, `jsxImportSource: "vuln-lib"`), the
  compiled element calls `require("vuln-lib/jsx-runtime")`, which no
  source line spells: family A `NOT_AFFECTED` (the module-load closure
  never sees the load), real Node calls `parse` from the runtime. A
  `@jsxImportSource` pragma switches a classic project to the automatic
  runtime too (measured with TypeScript 5.9.3's `transpileModule`).
  Registered as **RWF-066**; closed by this task, fail-closed (below).
- **Measured, new (registered by this task, not fixed).**
  `module.parent.require("vuln-lib")` (and `module.children[i].require`)
  loads a package the loader classifier
  (`classifyClosureWideningCall`, `loader-constructs.ts`) does not
  recognise: family A `NOT_AFFECTED`, real Node calls `parse`. The call
  graph gives the call `module_scope_callee` today. Family A's closure is
  the loader classifier's whole-file scan, not the call graph, so no
  call-graph account closes it. Registered as **RWF-065**, lane C
  (backlog `BL-040`), by the project owner's decision of 2026-10-02.
- **Measured.** Corpus occurrences of a call rooted in a module-scope
  binding (all 724 source files of the validation and both adversarial
  corpora): `debug`'s own-export calls in RWB-08 (`exports.enable()`,
  `exports.humanize()`, …), `require.resolve` in RWB-10's handlebars
  `precompiler.js`, and the loader shapes the loader classifier already
  answers (`module._compile`, `require.main.require`,
  `module.constructor._load`, `module.paths.unshift`). No corpus file
  contains JSX.
- **Assumed, not measured: the cost to real React applications.** Every
  reachable JSX element blocks families B and C, and under the automatic
  runtime family A as well, until the factory is resolved (backlog
  `BL-041`).

### Decisions (project owner, 2026-10-02)

Asked before the task file was written, as three precision-versus-scope
choices (`docs/WORKFLOW.md` § 7):

1. **JSX: fail closed now.** Every JSX element and fragment gets an
   unknown edge for its factory, plus possible edges for the component
   and every attributable function value its attributes and children
   hand the factory. The closure scan marks a JSX site whose compiled
   form may load a module (automatic runtime, an undetermined runtime) as
   closure-widening. Precise resolution of the factory is a P4 follow-up
   (`BL-041`).
2. **Own-export calls: an unknown edge now.** A resolved edge needs lane
   E's write set: today's export attribution does not see in-module write
   order (`exports.x = a; exports.x(); exports.x = b`), nor the stale
   `exports` alias after `module.exports = …`. Resolution through the
   write set is a P4 follow-up (`BL-042`, after E-1/E-2).
3. **`module.parent.require`: register and backlog.** RWF-065 and
   `BL-040` (P1, lane C). In the call graph, a call through the module's
   own `module` / `require` objects that the loader classifier did not
   classify gets an unknown closure-widening edge, so families B and C
   fail closed now; family A stays open until `BL-040`.

## Task

### Problem

A module calling its own export (`exports.x()`, `module.exports.x()`,
`exports["x"]()`) gets no edge, and family C certifies the export's body
unreachable while Node runs it (AUD-02). A JSX element is a call to the
configured factory, which may render the component and invoke the
functions handed to it; the graph sees none of it (PRM-116), and under
the automatic runtime the element also loads a module the closure never
sees (RWF-066).

### Why it matters

Soundness first: each is a reproduced false `NOT_AFFECTED` (families C,
C and A). Defect class B: the analyzer assumes `exports.x()` calls
nothing of the program's, and a JSX element calls nothing at all.

### What to do

1. **Reproductions first** (`tests/oracle/`, loud fixture, both
   controls, real-Node ground truth), failing on the base: AUD-02's three
   spellings and `new exports.X()`; PRM-116 with a calling factory, a
   factory that itself calls the target, a component, an attribute
   callback, a child callback, a fragment; RWF-066 (the
   `jsxImportSource` option and the pragma); RWF-065 as an
   open-soundness-defect record (its correct verdict left standing).
2. **Domain** (`src/domain/graph.ts`, `uncertainty.ts`, both schema
   reason enums): three `DynamicCallReason` subtypes, no seventh
   category: `own_export_call` (non-widening, `unmodeled_construct`),
   `jsx_factory_call` (a classic factory the graph does not attribute;
   non-widening, `unmodeled_construct`), `jsx_runtime_load` (a JSX site
   whose compiled form may load a module the graph does not follow;
   widening, `capability_escape`). `module_scope_callee` is deleted from
   `UnprovenNoEdgeReason` and the ledger.
3. **Module-scope callees** (`call-graph.ts`): a call or `new` rooted in
   an undeclared module-scope binding gets an unknown edge, never no
   edge: `own_export_call` for `exports…` and `module.exports…`;
   `loader_capability_escape` for any other member of `module` or
   `require` (the loader API; the loader classifier answers the shapes
   it knows first); the receiver-shape subtype for `__dirname` /
   `__filename`. The escape row's possible edges apply, as at any
   unknown callee.
4. **JSX** (`invocation-sites.ts`, `call-graph.ts`, a new
   `jsx-runtime.ts`): a site kind `jsx` for `JsxOpeningElement`,
   `JsxSelfClosingElement` and `JsxOpeningFragment`; its account is the
   factory's unknown edge (`jsx_runtime_load` unless the file's runtime
   is classic with a factory rooted outside the module-scope bindings,
   then `jsx_factory_call`), plus a possible edge to an attributable
   non-intrinsic component and to every attributable function value in
   the attributes and children (the escape row at an unknown callee).
   The runtime is TypeScript's: the file's `@jsxRuntime` /
   `@jsxImportSource` / `@jsx` / `@jsxFrag` pragmas, then the project's
   `jsx`, `jsxFactory`, `jsxFragmentFactory`; without a project, it is
   undetermined.
5. **Closure** (`loader-constructs.ts`, `module-load-closure.ts`,
   `scan.ts`): the closure scan records `jsx_runtime_load` at every JSX
   site the same predicate says may load a module; the scan threads the
   project's JSX settings to it; absent settings are undetermined.
6. **A-2's producer obligations** for the `jsx` site kind: a
   production-`buildFinding` reproduction ending `UNKNOWN` with
   `possible_invocation`; the walked-file check covers the new cases.
7. **Measure**: the differential tool over all corpus cases; validation
   case by case against OPEN-DEBTS D-09.
8. **Records**: FINDINGS (AUD-02, PRM-116 closed; RWF-065, RWF-066
   registered), the ledger, REMEDIATION-PLAN § 5a, OPEN-DEBTS, backlog
   (`BL-040`, `BL-041`, `BL-042`), progress, scorecard.

## Boundaries

### Do not touch

- The loader classifier's call shapes (`classifyClosureWideningCall`):
  RWF-065 is `BL-040`'s. This task adds only the JSX site to the
  closure's whole-file scan.
- Export attribution and the write set (lane E); VT-208, VT-210, VT-213,
  VT-214 (A-5); protocol members and accessors (A-4); the builtin table
  and its admission (A-3a, BL-039).
- `.github/workflows/ci.yml`, the proof families, `buildFinding`'s proof
  selection.
- The locked `rwf-046-require-binding-authority` worktree.

### STOP conditions

- A verdict moves to a WRONG answer on any corpus case or reproduction
  (`STOPPED_ON_FINDING`). A move to `UNKNOWN` is the expected, reported
  precision cost.
- A non-additive output-schema change becomes necessary
  (`NEEDS_DECISION`).
- The independent audit blocks on something outside this scope.

## Acceptance criteria

- [ ] Every AUD-02, PRM-116 and RWF-066 reproduction fails on the base
      and is `UNKNOWN` on the branch; none is `NOT_AFFECTED`.
- [ ] RWF-065 is recorded as an open-soundness-defect case with its
      correct verdict standing.
- [ ] `module_scope_callee` no longer exists; `UNPROVEN_NO_EDGE_LEDGER`
      names only A-5's two reasons.
- [ ] The census classifies `JsxOpeningElement`,
      `JsxSelfClosingElement` and `JsxOpeningFragment` as sites; no
      `pending` entry names A-3b.
- [ ] A-2's producer obligations hold for every `possible` edge this task
      emits (walked-file check; one production-`buildFinding`
      reproduction for the `jsx` site kind).
- [ ] No seventh uncertainty category; each new reason is classified
      for widening and category, and is in both schema enums.
- [ ] Graph, proof and verdict differentials reported separately, every
      moved case listed; validation compared case by case with
      OPEN-DEBTS D-09.
- [ ] Each mutation of the new rules is caught by a named test.
- [ ] An independent audit returned `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: a graph
differential limited to RWB-08's `debug` and RWB-10's `require.resolve`
(if reached), no verdict movement on the corpora (no JSX; RWB-08 is
`AFFECTED` through a resolved path), the six known validation failures
(OPEN-DEBTS D-09) unchanged.

## Report

In the format of `AGENTS.md` § J. Also report: the three decisions and
what each leaves to its follow-up row; RWF-065 and RWF-066.

## Corrections (2026-10-02)

Appended during the task; the text above is unchanged.

1. **"Expected: a graph differential limited to RWB-08's `debug` and
   RWB-10's `require.resolve`".** False. The measured graph, proof and
   verdict differentials are all zero over the 139 corpus cases: `debug`
   reassigns `exports` (`exports = module.exports = …`), so `exports` is
   not the undeclared module-scope binding there and its own-export
   calls already had unknown edges on the base; handlebars'
   `precompiler.js` is never loaded. No corpus site reached
   `module_scope_callee`, and no corpus file contains JSX.
2. **"What to do" 4: the classic runtime's factory "rooted outside the
   module-scope bindings".** Replaced after the independent audit: a
   spelling test under-approximates every alias of the loader. A classic
   site is non-widening only when every declaration of its factory's root
   in the file is a top-level, non-`declare` function or class
   declaration, or a value import from a non-builtin module, and nothing
   writes the name (any assignment form, destructuring and TypeScript-
   wrapped targets included); otherwise it is `jsx_runtime_load`.
3. **"What to do" 4: the runtime.** Also reads the project's
   `jsxImportSource` (it alone selects the automatic runtime),
   `reactNamespace` (the default classic factories), the LAST of
   repeated `@jsxRuntime` / `@jsxImportSource` pragmas, refuses a repeated
   `@jsx` / `@jsxFrag`, and treats a JavaScript file without `allowJs` as
   undetermined. Each rule is checked against TypeScript 5.9.3's emit.
4. **A capability handed to a classic factory** (`<X load={require} />`)
   gives the site `loader_capability_escape`, as for a call's arguments
   (`classifyClosureWideningJsx`); not in "What to do".
5. **Additions to records**: RWF-067 and `BL-043` (found by the audit),
   `BL-044` (the audit's unmeasured `importHelpers` / `tslib` risk); the
   stale statements in `docs/SOUNDNESS-CONTRACT.md`,
   `src/testing/foundation-invariants.ts` and `classifyCall`'s comment.

## Outcome (2026-10-02)

**Acceptance criteria**: all **yes**.

- Reproductions (`tests/oracle/a3b-own-exports-jsx.test.ts`): 20 cases
  plus 2 open-soundness-defect records. The first 13 fail on the base
  (each a false `NOT_AFFECTED`, real Node calling the target); the 7
  added from the audit fail on the version they were found on; all are
  `UNKNOWN` on the branch. RWF-065 and RWF-067 are records with the
  correct verdict standing.
- `module_scope_callee` deleted; the ledger names only A-5's two
  reasons. The census lists the three JSX kinds as sites; no pending
  entry names A-3b.
- A-2 obligations: the walked-file check runs on every oracle case; three
  production-`buildFinding` reproductions for the `jsx` site kind
  (`src/analysis/verdict.possible-edge.test.ts`).
- Three `DynamicCallReason` subtypes, no new category, both schema enums.
- Mutations: 18, each caught by a named test (the report lists them).
- Differentials (139 cases): graph 0, proof 0, verdict 0, explained in
  Corrections 1.
- Validation: the six known failures (OPEN-DEBTS D-09), unchanged.
- Independent audit: `BLOCKED` four times (all findings in scope, fixed
  and reproduced), then `CERTIFIED`.

**Discovered**: RWF-065 (`BL-040`, P1), RWF-066 (fixed), RWF-067
(`BL-043`, P1), `BL-041`, `BL-042` (precision), `BL-044` (P1, reproduce
first).

