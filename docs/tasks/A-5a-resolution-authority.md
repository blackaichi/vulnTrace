# A-5a — Resolution authority, call-graph side: VT-213, strict folding, lexical `require`, VT-210, `function` declaration stability

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: A-5a
- **Branch**: a-5a-resolution-authority
- **Base SHA**: 3d87189fa381399f8386c3f0ad6b6d1b9d08411e
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Sixth task of lane A of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 6),
after [`A-4`](A-4-protocol-members.md) (PR #82, merged 2026-10-04).
Backlog row `A-5` was split on 2026-10-04 by the project owner into
**A-5a** (this task) and **A-5b** (PRM-18, VT-208 receivers), which
together carry every criterion of that row.

The specification is
[ADR 0008](../adr/0008-invocation-accounting-and-resolution-authority.md)
invariant A2 ("a **resolved** edge exists only when an authority from a
closed set has proved that the callee denotes exactly one function at
that site on every execution"), § 2's closed no-edge proofs
(`AmbientStaticRequire`: "the callee is the *ambient* `require`, proved
lexically"; `ProvablyDeadBranch`; the `if` row: "pruned only when folding
is a proof"), § 6's reopened decisions (VT-213, VT-210, VT-211, the P1-B3b
`require` ladder, the P1-B3 `function` declaration binding) and § 8's A-5
row. REMEDIATION-PLAN § 3 names the pinned VT-213 test; § 5a's "A-3b
additions" bind A-5 to make VT-210 count or refuse a function used as a
JSX factory.

Findings closed: PRM-13, PRM-14, PRM-15, PRM-16, PRM-17, PRM-104; RWF-071
(registered and closed by this task).

Premises, checked against `main` at the base SHA (`AGENTS.md` § D):

- **Measured (real Node v22.11.0, the oracle harness, 26 cases in
  `tests/oracle/a5a-resolution-authority.cases.ts`).** 19 are wrong on
  the base: 18 false `NOT_AFFECTED` and one fabricated `AFFECTED`:
  - PRM-13: `pick().parse("x", () => 0)` and `cb(() => 0)` with `cb`
    holding the target are `NOT_AFFECTED`. VT-213's resolved edge to the
    one inline callback replaces the callee's unknown edge. `cb(() =>
    lib.parse())`, with a `cb` that never calls its argument, is
    `AFFECTED`.
  - PRM-14: `1 == "1"`, `1 != "1"` and `0 == ""` are folded as strict.
  - PRM-15: a function-local `function require`, a block `const require`
    and a parameter named `require` get no edge. **New, measured:** the
    import extraction (`source-index.ts`, `extractRequireBindings`) also
    binds `const m = require("./util.js")` through a local `require` to
    `util.js`'s exports, so `m.parse()` resolves to the wrong module's
    function. That is PRM-15's own mechanism ("a local `function
    require` is never seen") on the binding side.
    `named-bindings.ts`'s `requireCallInitializer` applies the same
    text test, deliberately kept in step with it.
  - PRM-16: a CommonJS-exported and an `export function` higher-order
    function, called once in their own file, are resolved from that one
    call site.
  - PRM-17: `fn = fn || lib.parse`, `fn = lib.parse`, `[fn] = [...]` and
    sloppy `arguments[0] = lib.parse` are not seen.
  - **RWF-071 (new).** VT-210 reads `site.arguments[paramIndex]` with no
    check for a spread argument before that position, so in
    `each(...["x", lib.parse], helper)` the parameter `fn` (position 1)
    is attributed to `helper`. Real Node passes `lib.parse`.
  - PRM-104: `run = lib.parse; run("x")` and a deferred `setup()` write
    resolve `run` to its declaration.
- **Measured.** Four shapes are already `UNKNOWN` on the base for other
  reasons: the function aliased by `const g = each`, called through
  `.call`, a parameter written in a nested closure, and a reassigned
  function declaration exported by name. They are kept as regression
  guards. Three precision guards hold their verdict: strict `1 === 2` and
  same-type `"a" == "b"` stay pruned (`NOT_AFFECTED`), and a file-local
  higher-order call with one imported target stays `AFFECTED`.
- **Measured.** `UNPROVEN_NO_EDGE_LEDGER` (`src/domain/graph.ts`) holds
  exactly two reasons, `static_require_by_text` (PRM-15) and
  `constant_folded_branch` (PRM-14), both `closedBy: "A-5"`. Three
  open-soundness-defect records in `tests/oracle/a3a-escaped-values.cases.ts`
  are owned by PRM-13: `identity.parameter-named-setTimeout`,
  `audit.destructured-setTimeout-never-calls` and
  `reaudit.global-object-member-replaces-invoking-builtin`.
- **Measured, no finding.** `literalValue` reads `NumericLiteral.text`,
  which TypeScript normalizes (`010` → `8`, `1_000` → `1000`, `0x10` →
  `16`), so strict folding of numeric literals is exact.
- **Measured, no finding.** A destructured parameter (`function f({ fn })`)
  binds a `BindingElement`, so `resolveParameterDeclaration` returns
  nothing for it and VT-210 never misreads the argument as `fn`.
- **Assumed, not measured: the cost to the corpora.** ADR 0008 § 5's
  prototype measured zero for the whole of A2; this task re-measures it
  with the differential tool.

### Decisions (project owner, 2026-10-04)

Asked before this file was written (`docs/WORKFLOW.md` § 7):

1. **Split A-5** into A-5a (this task) and A-5b (PRM-18).
2. **A-5b's scope** (recorded here so that it is not lost; it binds A-5b,
   not this task): keep ADR 0008 § 4's static-member exception and A2's
   `const x = new C()` receiver authority, but withdraw a resolved method
   edge when ANY walked file may write that member, and only for a chain
   of plain class declarations with no shadowing field and no constructor
   `return`.

## Task

### Problem

Six resolution and pruning decisions in the call graph rest on an
assumed authority. Each one replaces the honest unknown edge, or prunes a
live branch, and family C then certifies the target unreachable.

### Why it matters

Soundness first: each is a reproduced false `NOT_AFFECTED` (one also a
fabricated `AFFECTED`). Defect classes:

- **A, wrong binding identity:** `require` is matched by spelling.
- **B, wrong runtime-value semantics:** loose equality is treated as
  strict; VT-213 assumes the callee calls its callback.
- **C, multi-valued provenance collapsed to one:** a reassigned function
  declaration; a parameter written in the body or through `arguments`,
  or passed by importers or through a spread.

### What to do

1. **Reproductions first.** The 26 cases above go in
   `tests/oracle/a5a-resolution-authority.*`, with loud fixtures, both
   controls and real-Node ground truth. The 19 failing on the base are
   shown failing there.
2. **PRM-13 / VT-213** (`call-graph.ts`): delete the inline-callback
   fallback (`resolveInlineCallbackArgument`). An unattributable callee
   keeps its unknown edge, and the callback gets A-3a's escape-row
   `possible` edge (`withEscapesAtUnknownCallee`). Correct the pinned
   test (`call-graph.test.ts`, "someUtterlyArbitraryMethodName") to
   assert the callee's unknown edge. Flip and delete the three A-3a
   records owned by PRM-13.
3. **PRM-14 / VT-211** (`evaluateConstantBoolean`): fold `==` and `!=`
   only on two literals of the same type, where loose equality is strict
   equality. A pruned branch's sites get the no-edge proof
   `provably_dead_branch`.
4. **PRM-15** (new `src/code-intelligence/ambient-names.ts`, holding the
   file-wide name sets `escape-row.ts` already uses, moved unchanged): a
   static `require("x")` is `AmbientStaticRequire` (no-edge proof
   `ambient_static_require`) only when the file declares no `require` in
   any form, writes no bare `require`, and the call is not inside `with`.
   Otherwise it goes through the ordinary callee ladder. The import
   extraction and `requireCallInitializer` bind names only for an
   ambient `require`. A shadowed one is still recorded as a load of its
   specifier (over-approximation: no load is removed).
5. **Remove `unproven_no_edge`** from `InvocationAccount`, together with
   `UnprovenNoEdgeReason`, `UNPROVEN_NO_EDGE_LEDGER` and their tests.
   ADR 0008's end state for that type, "empty", is reached. The A1
   invariant's text in `src/testing/foundation-invariants.ts` follows.
6. **PRM-16 / PRM-17 / RWF-071 / the JSX factory** (VT-210,
   `resolveHigherOrderCallTarget`). Refuse when any of these holds:
   - the function is exported by a modifier;
   - any identifier spelled like the function, in a value position in
     the file, is not the callee of one of its counted call sites
     (exports, aliases, `.call`, `new`, tags, decorators, shorthand
     properties);
   - the file contains a JSX site;
   - the parameter's name is written anywhere in the function;
   - the function references `arguments` or `eval`, or contains `with`;
   - a call site has a spread argument at or before the parameter's
     position.
7. **PRM-104** (`named-bindings.ts`, `resolveFrom`): a `function`
   declaration whose name is assigned anywhere in its owning scope is
   `reassigned`, the same rule the class and function-expression
   branches already apply.
8. **Mutations**: each refusal removed in turn is caught by a named
   test.
9. **Measure**: the differential tool over all corpus cases; validation
   case by case against OPEN-DEBTS D-09.
10. **Records**:
    - FINDINGS: PRM-13, 14, 15, 16, 17 and 104 closed; RWF-071
      registered and closed.
    - REMEDIATION-PLAN § 5a: an "A-5 split" record, carrying A-5b's
      measured VT-208 shapes.
    - Also OPEN-DEBTS, the backlog, progress and the scorecard.

## Boundaries

### Do not touch

- VT-208 / `resolveInstanceMethod` (A-5b); trailing chains and import
  names for string or computed keys (A-6, `symbol-binder.ts`, the rest of
  `source-index.ts`); export attribution (lane E); the loader classifier
  in `loader-constructs.ts`. Its name-based `require` recognition is
  over-approximate in the safe direction: a shadowed `require` read as a
  real one adds a load or a widening edge, never removes one.
- ADR 0008 § 2's other structural gates (the branded
  `resolvedEdge(authority, target)`, binding-grammar A2 rows,
  `VT-INV-A2-resolution-authority`). No plan row assigns them; they get a
  backlog row.
- `.github/workflows/ci.yml`, the proof families, `buildFinding`.
- The locked `rwf-046-require-binding-authority` worktree.

### STOP conditions

- A verdict moves to a WRONG answer on any corpus case or reproduction
  (`STOPPED_ON_FINDING`). A move to `UNKNOWN` is the reported precision
  cost.
- A non-additive output-schema change becomes necessary
  (`NEEDS_DECISION`).
- The independent audit blocks on something outside this scope.

## Acceptance criteria

- [ ] Every reproduction wrong on the base fails there and has its sound
      verdict on the branch; the precision guards and regression guards
      keep theirs.
- [ ] VT-213's fallback is gone; the pinned test asserts the callee's
      unknown edge; the three PRM-13 records are deleted and assert their
      expected verdict.
- [ ] `==` / `!=` fold only on same-type literals; a pruned site carries
      `provably_dead_branch`.
- [ ] A static `require` gets `ambient_static_require` only when
      `require` is provably the ambient one; a shadowed one is an
      ordinary callee; the import extraction and `requireCallInitializer`
      bind no name through it, and its load is kept.
- [ ] `InvocationAccount` has no `unproven_no_edge` variant;
      `UNPROVEN_NO_EDGE_LEDGER` and `UnprovenNoEdgeReason` are deleted;
      every no-edge account carries a proof with a named owner test.
- [ ] VT-210 refuses each shape in "What to do" 6, each by a named test.
- [ ] A reassigned `function` declaration is `reassigned`.
- [ ] Each mutation of the new refusals is caught by a named test.
- [ ] Graph, proof and verdict differentials reported separately, every
      moved case listed; the full validation (against OPEN-DEBTS D-09)
      and the full adversarial results reported.
- [ ] RWF-071 is registered; FINDINGS, plan, debts, backlog, progress and
      scorecard updated.
- [ ] An independent audit returned `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: the verdict
differential is zero, or only moves to `UNKNOWN`, which are reported as
precision cost. The known validation failures (OPEN-DEBTS D-09) are
unchanged.

## Report

In the format of `AGENTS.md` § J. Also report: the two decisions; every
correct `AFFECTED` turned into `UNKNOWN`; the new finding RWF-071.
