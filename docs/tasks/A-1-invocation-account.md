# A-1 — `InvocationAccount`, syntax-kind census, handler table; tagged templates, decorators, implicit `super`

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: A-1
- **Branch**: a-1-invocation-account
- **Base SHA**: c5ca8852575ad5eaa2e2edae1f6c8401b3031e4e
- **Commits**:
  - `54fec68` docs(tasks): A-1 task file — invocation accounting, census, three sites
  - `aaaa2d3` test(A-1): real-Node reproductions for tagged templates, implicit super, decorators
  - `82152e9` fix(A-1): account for every invocation site; tagged templates, decorators, implicit super
  - `a1970b2` docs(A-1): contract and invariant map — resolved-only AFFECTED paths, VT-INV-A1
  - (this commit) docs(A-1): records — backlog, plan, debts, scorecard, progress
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

## Outcome (2026-09-28)

**Acceptance criteria**: all **yes**.

- Reproductions: 37 oracle cases in `tests/oracle/a1-invocation-sites.*`.
  On the base `c5ca885`, 25 fail and 12 controls pass: 24 are false
  `NOT_AFFECTED` findings, and the 25th is the getter-body precision cost
  described below. All 37 pass on the branch.
- `InvocationAccount` is a closed union. Its only no-edge account is
  `unproven_no_edge`, and each reason names its open findings and its
  closing task (`UNPROVEN_NO_EDGE_LEDGER`, owner test in
  `call-graph.invocation-account.test.ts`).
- Census: every `ts.SyntaxKind` is classified, and a new node kind fails
  `invocation-sites.census.test.ts`.
- Handler table: `INVOCATION_SITE_HANDLERS` `satisfies` a mapped type
  over `InvocationSiteKind`.
- Site coverage: every site of every walked file over the 134 corpus
  fixtures has an account, pruned branches included
  (`invocation-sites.site-coverage.test.ts`).
- The three sites are accounted as ADR 0008 § 2 and § 4 state. A
  decorator is accounted from the owner that evaluates its class
  definition.
- Loader classification covers a tag in both layers (RWF-057).
- `SOUNDNESS-CONTRACT.md` § 1 and § 3 and the invariant map are updated;
  `VT-INV-A1-invocation-accounting` and
  `affected-path-resolved-edges-only` are gated.
- Differentials (`node scripts/differential.mjs`, 139 cases):
  - graph: +30 call sites in 4 adversarial cases, all implicit-`super`
    edges (1 resolved, 29 unknown); 0 withdrawn, 0 retargeted;
  - proof: 0;
  - verdict: 0.
  Validation matches the D-09 baseline case by case.
- Independent audit: round 1 `BLOCKED`, round 2 `CERTIFIED` (details
  below).

**Deviations from this file and from ADR 0008 § 8, with the reason.**

1. ADR 0008 § 8 names "tests that assert an edge count for a file
   containing a derived class with no constructor or a tagged template"
   as tests that would change. No such test exists on `main`, and no
   existing test changed (4,563 → all green before the new tests were
   added).
2. No ADR 0008 § 2 no-edge proof is claimed, because none of today's
   no-edge branches establishes one. They are named `unproven_no_edge`
   accounts instead. ADR 0008's "no fourth outcome" is the end state of
   lane A, not of A-1.
3. `loader-constructs.ts` is changed, although it is not in the ADR's
   file list for A-1. A tag and a decorator must get the loader
   classification a callee gets, and the two layers must agree on it
   (RWF-057).
4. From the independent audit, round 1:
   - A tagged template and a decorator are accounted from the owner that
     EVALUATES them (`evaluatingOwnerOf`), not from the walk's stack.
   - A decorator TypeScript erases in every mode is not a site.
   - A site in an accessor body is withdrawn to unknown until A-4. The
     cost: a decorated class in a getter that is never read is `UNKNOWN`,
     where the base gave a correct `NOT_AFFECTED`. This is the one
     verdict the reproductions move away from a correct base result.
5. `docs/REMEDIATION-PLAN.md` § 5a gains "A-1 additions to lane-A
   acceptance". It adds two A-3 criteria (RWF-060, and a class handed to
   `Reflect.construct` must reach its constructor node), because A-3 as
   specified would not close them. **Project-owner review requested.**
6. The Foundation gate gains `invocation-sites.site-coverage.test.ts`
   (~26 s of test time over the corpora). The gate now takes about 75–85
   s wall-clock on this machine.

**Independent audit.**

- Round 1: `BLOCKED`.
  - Resolved edges for decorators TypeScript erases: fixed.
  - Decorators attributed to the module inside an instance field or an
    accessor: fixed.
  - Unregistered false `NOT_AFFECTED` defects predating A-1:
    registered as RWF-060 and RWF-061.
  - Shared-authority notes (PRM-20): added.
  - Two overclaims, a stale reference and a wrong census reason:
    corrected.
  - Decorator loader classification differing between layers: aligned.
- Round 2: `CERTIFIED`, with three non-blocking findings, all addressed:
  - The constructor attribution's cost under `Reflect.construct`:
    recorded, and added to A-3's acceptance.
  - Parameter and `declare`-field decorators of a class expression are
    erased in every mode: now not sites.
  - A constructor-overload false `NOT_AFFECTED`, predating A-1:
    registered as RWF-062 (`BL-038`).

**Discovered** (backlog rows, "discovered in A-1"):

| Row | Finding | Priority | Scope |
| --- | --- | --- | --- |
| `BL-037` | RWF-061 | P1 | lane C |
| `BL-038` | RWF-062 | P1 | |
| A-3 acceptance | RWF-060 | P1 | |
| `BL-036` | RWF-059 | P2 | |
| `BL-034` | — | P4 | explicit `super(...)`, precision |
| `BL-035` | RWF-058 | P4 | |

