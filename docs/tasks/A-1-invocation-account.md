# A-1 — `InvocationAccount`, syntax-kind census, handler table; tagged templates, decorators, implicit `super`

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: A-1
- **Branch**: a-1-invocation-account
- **Base SHA**: c5ca8852575ad5eaa2e2edae1f6c8401b3031e4e
- **Commits**: filled in by the last commit
- **Superseded by**: —

## Project context

First task of lane A of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 2). The
specification is [ADR 0008](../adr/0008-invocation-accounting-and-resolution-authority.md)
§ 8's A-1 row, read with § 1 (invariant A1), § 2 (the positive
enumeration, the closed no-edge proofs, the structural gates), § 3 (the
fail-closed default) and § 4 ("Decorators and implicit `super`: resolved,
because the language guarantees the call"), plus the acceptance
criterion the project owner's Decision 2 adds (ADR 0008, "Decision record
— project owner, 2026-09-26"; `REMEDIATION-PLAN.md` § 6.1 item 2).

It closes three open findings in `tests/validation/FINDINGS.md`, all
false `NOT_AFFECTED` through family C:

- **PRM-37** — a tagged template (`` tag`x` ``) gets no call-graph edge.
- **PRM-19** — a derived class with no constructor: the synthesized
  implicit constructor has no edge to the base constructor that
  `super(...args)` runs.
- **PRM-115** — TypeScript decorators (legacy and standard) get no edge,
  although they are invoked at class definition.

Premises, checked against `main` at the base SHA (`AGENTS.md` § D):

- **Measured.** `walkFile` (`src/code-intelligence/call-graph.ts`)
  classifies only `CallExpression` and `NewExpression`. `classifyCall`
  and `classifyNew` return `CallEdge | undefined`, and `undefined` is
  returned by four branches that are not proofs: an ambient-global root
  (VT-201), a Node builtin binding (VT-305), a static `require("x")`
  matched by text (P1-B3b; PRM-15), and — outside those functions — a
  branch pruned by `evaluateConstantBoolean` (VT-211; PRM-14), whose
  sites are never visited at all.
- **Measured.** `source-index.ts`'s `extractImplicitConstructor` gives a
  class with no constructor a node, and its doc comment states that the
  node "can never acquire outgoing edges" because "an implicit
  constructor provably does nothing". For a derived class that premise
  is false (PRM-19; real Node runs `Base`'s constructor for `new Sub()`).
- **Measured**, with the oracle harness on the base SHA (the cases this
  task commits in `tests/oracle/a1-invocation-sites.cases.ts`): every
  tagged-template, implicit-`super` and decorator case whose target real
  Node calls is `NOT_AFFECTED`; the precision controls are
  `NOT_AFFECTED`, correctly.
- **Measured, new.** A tagged template whose tag is a loader capability
  executes code: `` vm.runInThisContext`…` `` compiles and runs the
  template text (the strings array coerces to a string; verified on
  Node v22.11.0). `findClosureWideningConstructs`
  (`src/code-intelligence/loader-constructs.ts`) checks only a tagged
  template's substitutions, never its tag, so a `vm` tag that loads a
  package not otherwise required gives a false `NOT_AFFECTED` through
  family A (measured). Recorded as a new finding (the next free RWF ID);
  fixed here because the tag's account must use the shared loader
  classifier and the two layers must not disagree about what a loader is
  (VT-307c-fix-3, the reason the classifier is shared).
- **Measured.** An explicit `super(...)` call is an ordinary
  `CallExpression` whose callee is not attributable, so it already gets
  an unknown edge (sound; imprecise). Not in this task's scope.

## Task

### Problem

Three invocation-capable syntaxes invoke user code and get no account at
all, so the reachable subgraph looks exhaustively searched and family C
certifies a target that real Node calls. And the graph has no structural
guarantee that a new syntax — or a new branch that returns `undefined` —
cannot do the same again.

### Why it matters

Soundness: each of the three is a reproduced false `NOT_AFFECTED`. The
defect class is "no edge at all for code that runs" (ADR 0008 Context,
class 1), which none of AGENTS.md § F's three classes names directly; it
is closest to B (the analyzer assumes a construct invokes nothing, which
real Node contradicts).

### What to do

1. **Reproductions first** (`tests/oracle/`), with the real-Node oracle
   harness, loud fixture and both controls, shown failing on the base
   SHA: tagged templates (an import member, a local function, a
   destructured import, an unattributable tag, a `vm` tag), implicit
   `super` (local base, a chain, an unattributable base, a
   never-constructed precision control) and decorators, legacy and
   standard (class, method, static method, field, parameter — legacy
   only —, the target export as the decorator, a factory, and two
   precision controls inside a function that never runs).
2. **`InvocationAccount`** (`src/domain/graph.ts`): a closed union — one
   or more edges, or an explicitly *unproven* no-edge account that names
   the legacy branch it comes from. No producer returns `undefined`.
   ADR 0008 § 2's closed no-edge proofs (`AmbientStaticRequire`,
   `PrimitiveOnlyArguments`, `NonInvokingBuiltin`, `ProvablyDeadBranch`)
   are not claimed: none of today's no-edge branches is one of them (see
   the premises). Each unproven reason names the open findings it
   carries and the lane-A task that removes it (A-3 or A-5), and a test
   keeps that ledger honest against `FINDINGS.md`.
3. **Syntax-kind census and handler table**
   (`src/code-intelligence/invocation-sites.ts`): every `ts.SyntaxKind`
   classified — an invocation site with a handler, a site pending a named
   later lane-A task, or not invocation-capable with the reason — and a
   census test that fails on an unclassified kind. `walkFile` dispatches
   every site through one table typed `satisfies` over the site kinds.
4. **The three sites**: a tagged template's tag and a decorator are
   resolved like a callee, after the shared loader classification; the
   implicit constructor of a derived class gets an edge to the base
   constructor, resolved or unknown. A decorator is attributed to the
   owner that evaluates the class definition. Inline-callback
   resolution (VT-213, PRM-13) is not extended to the new sites.
5. **Every site is accounted, including the ones in a pruned branch**,
   and a site-coverage test proves it over the corpora.
6. **The loader classifier** accounts for a tagged template's tag in both
   layers (the new finding).
7. **Decision 2**: amend `docs/SOUNDNESS-CONTRACT.md` and the invariant
   map (`src/testing/foundation-invariants.ts`) with the `possible`-edge
   rule, worded as binding on A-2, which introduces the edge kind; and
   register `VT-INV-A1-invocation-accounting`.
8. Records: `FINDINGS.md` (PRM-19, PRM-37, PRM-115 closed; the new
   finding), `OPEN-DEBTS.md` where it counts them, the scorecard
   regenerated, and the differentials measured with
   `node scripts/differential.mjs`.

## Boundaries

### Do not touch

- The ambient-global, builtin, static-`require` and constant-folding
  no-edge behaviour: it is A-3's and A-5's to replace. A-1 names it, it
  does not change it.
- The `possible` edge kind itself (A-2), escaped function values, JSX
  and own-export calls (A-3), protocol members and accessors (A-4), the
  resolution authorities (A-5, A-6).
- The locked `rwf-046-require-binding-authority` worktree.

### STOP conditions

- A differential moves a verdict outside the cases this task targets in
  a way that is not a sound consequence of the new accounts
  (`NEEDS_DECISION`).
- A correct fix needs a `possible` edge (A-2) rather than a resolved or
  unknown one.
- The independent audit blocks on something outside this scope.

## Acceptance criteria

- [ ] The reproductions exist, were shown failing on the base SHA, and
      pass: every case at its expected verdict, with real Node agreeing.
- [ ] No invocation-site producer can return `undefined`: `InvocationAccount`
      is a closed union, and the only no-edge account is the explicitly
      unproven one, each of whose reasons names its open findings and
      closing task.
- [ ] Every `ts.SyntaxKind` is classified by the census; the census test
      fails on an unclassified kind.
- [ ] `walkFile` dispatches through a handler table typed
      `satisfies Record<InvocationSiteKind, …>`.
- [ ] Every invocation site of every walked file in the corpora gets at
      least one account, including sites in a pruned branch (site-coverage
      test).
- [ ] Tagged templates, decorators and implicit `super` are accounted as
      ADR 0008 § 2 and § 4 state; a decorator is attributed to the owner
      that evaluates its class definition.
- [ ] The loader classifier accounts for a tagged template's tag in the
      call graph and in the module-load closure.
- [ ] `docs/SOUNDNESS-CONTRACT.md` and the invariant map state Decision
      2's rule; `VT-INV-A1-invocation-accounting` is registered with an
      owner the Foundation gate runs.
- [ ] Graph, proof and verdict differentials reported separately; the
      validation baseline compared case by case (OPEN-DEBTS D-09).
- [ ] An independent audit returned `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected differentials: the
graph gains edges wherever the corpora contain a derived class with no
constructor, a tagged template or a decorator; no verdict is expected to
move on the validation corpus (ADR 0008 § 5 measured 0 / 17 cases for
the whole of lane A), and any that does is reported by case.

## Report

In the format of `AGENTS.md` § J.
