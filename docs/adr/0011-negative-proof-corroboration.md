# ADR 0011 — Negative Proofs Are Corroborated by Exact Identity, Never by Names

Lane V of [`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md). Status:
**proposed** (design only; nothing here is implemented).

## Context

`docs/SOUNDNESS-CONTRACT.md` § 3 defines three negative-proof families. Four
reproduced false `NOT_AFFECTED` show that `src/analysis/verdict.ts` can
issue a family B or C proof whose load-bearing premise was never checked
against the exact `PackageInstance`, or was checked by a name instead of an
identity:

| Finding | What the proof relied on | Why it was false |
| --- | --- | --- |
| PRM-101 | Site B: "no graph node of the advisory's package NAME" ⇒ a phantom target, then family C | A package loaded only through `export * from "pkg"` executes its top-level code with no call-graph node. The phantom is "unreachable" and certified. |
| PRM-102 | Site A/B chosen by manifest package name | A traversed instance whose manifest name differs from the lockfile name falls to Site B's phantom. |
| PRM-23 | `invalidatesCallGraphNegativeProof("traversal_truncated") === false` | A truncated closure hides a non-call loader hook in a file the call graph did walk. The graph was not truncated, so family C was certified. |
| PRM-25 | a `{file, symbol}` entrypoint root found by `n.name === entrypoint.symbol`, and "nothing to be incomplete about" when none is found | The root is the wrong node (a nested function of the same name), or no node, and the subgraph is still called complete. |

Each is the same shape: a *negative* conclusion drawn from a lookup that
cannot fail loudly. A name that matches nothing, or matches the wrong node,
yields an empty or wrong search space, and an exhaustive search of the wrong
space is a proof of nothing.

## Decision

### 1. The invariant

> **V.** A negative proof may be constructed only from facts keyed by exact
> identity: `PackageInstanceId` for packages, and declaration identity
> (file + source position) for graph nodes. Every family B and family C
> proof additionally carries a **closure corroboration**: a complete,
> gate-eligible `ModuleLoadClosure` whose incompleteness list is empty
> (including `traversal_truncated`), and which states whether the exact
> instance is loaded. A target that could not be attributed to a real node
> (a phantom) can never be the subject of family C; it can support only
> family A, and only through the closure.

Mechanically, this is checkable as four predicates over the proof inputs:

1. `closure !== undefined && closure.complete && closure.incompleteness.length === 0`
   for every family B/C proof (today B requires completeness but C ignores
   `traversal_truncated`);
2. Site A vs Site B is selected by
   `graph.nodes.some(n => identity(n).packageInstance === finding.packageInstance)`,
   never by package name;
3. `target.node` is a real graph node (not a phantom) for every family C;
4. every entrypoint root is materialized by declaration position, and a
   configured `symbol` that does not materialize is root incompleteness.

### 2. Enforcement and the structural gate

Where: `resolveTargetNodes`, `entrypointSourceNodes` and `buildFinding` in
`src/analysis/verdict.ts`; `invalidatesCallGraphNegativeProof` in
`src/analysis/module-load-closure.ts`.

Structural gate, in the spirit of the binding-grammar guard:

- **Proof inputs become unforgeable types.** `ConfirmedUnreachableTarget`
  and `ConfirmedAbsentInstance` are constructible only from a branded
  `ClosureCorroboration` (produced by exactly one function that checks
  predicate 1 and records `instanceLoaded`) and, for family C, an
  `AttributedTarget` (produced only from a real `GraphNode`). A phantom is
  typed `UnattributedTarget`, which the family C constructor does not
  accept. A violation is then a **compile error**, not a test failure.
- **A name-keyed-lookup census.** A Foundation test lists every expression
  in `src/analysis/` and `src/code-intelligence/` that finds a graph node or
  indexed function by comparing a `name` (today: `verdict.ts:303, 1105,
  1149, 1190`; `module-model.ts:6004, 6100`; `call-graph.ts:1694`), each
  with its declared direction (`widen-only`, `refuse-only`, or
  `test-flag-only`). A new name-keyed lookup, or one whose direction
  changes, fails the gate. `1105` and `1190` are removed by this lane;
  `6004` by lane E (ADR 0009).
- **Mutation tests** that delete each corroboration check and show a named
  test move from `UNKNOWN` to a false `NOT_AFFECTED` (ARCHITECTURE § 13,
  rule 7).
- Registered in `src/testing/foundation-invariants.ts` as
  `VT-INV-V-corroboration`.

### 3. Fail-closed default

A proof whose corroboration is missing is not issued; the finding is
`UNKNOWN` with an existing reason:

| Situation | Category | Reason (existing) |
| --- | --- | --- |
| phantom target, closure does not show the instance absent | `identity_unresolved` | `vulnerable_target_unresolved` |
| closure truncated | `budget_exceeded` | `traversal_truncated` (already a closure reason) |
| configured symbol not materialized | `identity_unresolved` | `entrypoint_root_incomplete` |

No seventh category and no new reason token are needed.

### 4. Modeled exceptions that keep precision

- **A genuinely unloaded package keeps a proof**, via family A: complete
  closure, instance absent. This is the common correct negative that Site B's
  phantom was meant to serve, and family A already serves it with a stronger
  premise.
- **A loaded, attributed, unreached target keeps family C** (the RWB-06,
  RWB-07 and RWB-11b shape): a real node exists, so corroboration is only
  predicate 1.
- **A `{file, symbol}` entrypoint that the export map attributes exactly**
  keeps its narrowed root. The prototype resolves the symbol through
  `mapExportsToFunctions` by position; this *improved* two verdicts (a false
  `AFFECTED` became a correct `NOT_AFFECTED`, and a false `NOT_AFFECTED`
  became a correct `AFFECTED`).

### 5. Precision cost

**Measured** with a throwaway prototype in a scratch clone outside the
repository (never committed), at `62b52b9`:

- the phantom path requires `closure.complete && !closure.loadedPackageInstances.includes(packageInstance)`,
  otherwise `unresolvedReason`;
- `invalidatesCallGraphNegativeProof` returns `true` for every reason;
- a configured symbol is resolved through `mapExportsToFunctions` by
  position, and an unmaterialized one reports
  `unresolved_entrypoint_root_candidate`.

The adversarial suites (`npm run test:adversarial`, 122 scenarios) and the
validation suite (`npm run test:validation`, 17 cases, live OSV) were run
on the pristine clone and on the prototype, and the runners' own
`ID EXPECTED ACTUAL` tables were diffed case by case. A second, finding-level
measurement dumped every finding of every validation fixture (85 findings)
from both runs and diffed them by (case, advisory, instance).

| Measure | Changed |
| --- | --- |
| adversarial scenarios | **0 / 122** |
| validation cases | **0 / 17** |
| validation findings (all, not only the selected one) | see [`REMEDIATION-PLAN.md` § 4](../REMEDIATION-PLAN.md) |
| all 5 targeted reproductions | flip to `UNKNOWN` or to the correct verdict |

The corpora contain no package loaded only through `export *` and not
called, and no truncated scan, which is why the measured cost is zero. The
known cost is exactly those two shapes: a loaded-but-unused package reached
only through `export *` moves from a correct `NOT_AFFECTED` to `UNKNOWN`,
and a scan whose closure hits `maxFiles` loses families B and C. Both
reproductions' negative controls show it.

### 6. Reopened certified behaviour

| Certified decision | Where | Reopened because |
| --- | --- | --- |
| VT-301B: Site B phantom "is correct and intentional" | `verdict.ts:613-620`, `479-486` | PRM-101 and PRM-102 reproduce false `NOT_AFFECTED` on ordinary code (`export *` barrels) |
| VT-307e: `traversal_truncated` "DOES NOT BLOCK either" | `module-load-closure.ts:520-531`; `verdict.ts:1912-1916` | PRM-23 reproduces family C over a hidden `Module.prototype.require` redirect at `maxFiles: 7`; the "(verified directly)" claim that a truncated closure implies a truncated graph is false because the closure walks re-export-only files the graph does not |
| VT-205 / P0-Z: a `{file, symbol}` root "has nothing to be incomplete about" | `verdict.ts:1102-1113`; FINDINGS P0-Z "Remaining limitations" | PRM-25 reproduces both a false `NOT_AFFECTED` and a false `AFFECTED` |

The reproductions are in the round-1 and round-2 comment-premise sweep
reports (cases `r2-phantom-export-star-barrel`,
`r2-siteB-name-mismatch-forwarded`, `closure-truncation-hides-hook`,
`symbol-entry-unmaterialized`, `symbol-entry-name-match`).

### 7. Interaction with the proof families and RWF-002

- **Family A** is unchanged and becomes the only route for a package
  instance with no real node. Its premise (complete closure, instance
  absent) is already the strongest one.
- **Family B** already requires a complete closure; it gains predicate 1's
  "no `traversal_truncated`" and instance-keyed site selection.
- **Family C** gains the closure corroboration and loses phantom targets.
  This does not weaken the contract; it restores § 3's "resolved,
  attributed target" wording, which the phantom silently bypassed.
- **RWF-002 (target-relevant completeness)** is orthogonal: it discharges
  unknown edges that are irrelevant to a *real* target. It cannot discharge
  a phantom, because there is no target to be relevant to. The extra
  `UNKNOWN`s this lane produces (the `export *` shape) are closed by lane A/E
  work that makes such packages visible to the graph (a module-evaluation
  edge through `export *`), not by RWF-002.

### 8. Implementation tasks, in order

| Task | Scope | Reproductions that flip | Existing tests that change |
| --- | --- | --- | --- |
| **V-1** closure corroboration for Site B; instance-keyed site selection | `verdict.ts` `resolveTargetNodes` | PRM-101 (both variants), PRM-102 | `verdict.site-b-target-authority.integration.test.ts` "still reports NOT_AFFECTED for a package nothing imports at all" must now pass via **family A** (assert the family, not only the verdict); any test asserting family C for a phantom |
| **V-2** `traversal_truncated` blocks families B and C | `module-load-closure.ts` `invalidatesCallGraphNegativeProof` | PRM-23 | **`verdict.negative-proof.test.ts` "case 10b"** (pins the false premise: must now expect `UNKNOWN`), and the assertion at line ~369 `invalidatesCallGraphNegativeProof("traversal_truncated")` |
| **V-3** identity-keyed roots; unmaterialized symbol is incompleteness; name-lookup census gate | `verdict.ts` `entrypointSourceNodes`; new Foundation census test | PRM-25 (both directions) | VT-205 tests in `verdict.test.ts` / `verdict.integration.test.ts` that configure a symbol whose export is a renamed local |
| **V-4** proof-input types (`ClosureCorroboration`, `AttributedTarget`) and mutation tests | `src/domain/evidence.ts` types, `verdict.ts` constructors | none new; locks V-1..V-3 | `verdict.f2-proof-guards.test.ts`, `verdict.f4-proof-mutation.test.ts` gain cases |

## Rationale

The priority order puts soundness first. A negative proof is a positive
claim (SOUNDNESS-CONTRACT § 1); a lookup that returns "nothing" on failure
cannot support a positive claim. Measured precision cost on both corpora is
zero, and the known cost is confined to two shapes that family A already
covers when the package is genuinely unloaded.

## Consequence

Families B and C become strictly harder to reach and strictly easier to
audit: every proof names the closure it was corroborated by. Site B's
phantom survives only as an explanatory placeholder for an `UNKNOWN`.
