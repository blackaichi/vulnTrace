# VulnTrace — Software Design Document v0.2

**Status:** Proposed / remediation baseline  
**Scope:** JavaScript/TypeScript MVP  
**Basis:** Adversarial validation + architecture remediation findings  
**Date:** 2026-08-17

> Amendment to the existing VulnTrace SDD. Existing sections not explicitly
> changed here remain authoritative.

## 1. Purpose

VulnTrace determines whether a CVE/GHSA vulnerability and its vulnerable
behavior are reachable from configured JavaScript/TypeScript entrypoints.

The product MUST distinguish `AFFECTED`, `NOT_AFFECTED`, and `UNKNOWN`.

Core safety property:

> Absence of evidence of reachability MUST NOT be treated as evidence of
> non-reachability when analysis contains unresolved or unsupported behavior.

## 2. Findings Driving v0.2

The adversarial suite contains 34 scenarios: 23 passed, 11 failed, for a
67.6% pass rate. Accuracy was 63.6% for AFFECTED, 75.0% for NOT_AFFECTED,
and 75.0% for UNKNOWN. The failures expose architectural gaps rather than
isolated defects. fileciteturn4file0L15-L28

The main findings are silent call-graph gaps, higher-order calls,
constructors, instance methods, re-exports, inconsistent target resolution,
multiple installed dependency instances, TypeScript path aliases,
entrypoint semantics, and static dead-code semantics. The remediation
analysis identifies the silent-edge issue as the primary soundness problem:
the verdict layer can only propagate UNKNOWN if graph construction actually
emits an unknown edge. fileciteturn4file2L117-L130

## 3. Core Architectural Invariants

### 3.1 No silent call-like constructs

For every `CallExpression` and `NewExpression` visited by graph construction,
the result MUST be either:

```text
resolved target
OR
unknown edge with reason = unsupported_construct
```

A visited call-like construct MUST NOT silently disappear from the graph.
A construction-time completeness assertion SHOULD detect future unsupported
syntax. This is an MVP soundness requirement. fileciteturn4file2L119-L130

### 3.2 UNKNOWN is first-class

Unresolved or unsupported constructs MUST propagate uncertainty into
reachability. `UNKNOWN` MUST NOT be converted into `NOT_AFFECTED` merely
because no path was found.

### 3.3 NOT_AFFECTED requires positive evidence

`NOT_AFFECTED` is valid only when relevant reachable paths are exhausted,
analysis coverage is complete, target/module identity is consistent, and no
reachable UNKNOWN can change the conclusion.

Absence of a graph edge caused by an unmodelled construct is NOT evidence of
non-reachability.

### 3.4 AFFECTED requires a concrete reachable target

`AFFECTED` requires a sufficiently evidenced path:

```text
entrypoint -> resolved graph path -> vulnerable symbol/behavior
```

An UNKNOWN path cannot by itself be upgraded to AFFECTED.

## 4. ResolvedTarget and Module Identity

VulnTrace MUST introduce an explicit `ResolvedTarget` concept.

Conceptually:

```ts
type ResolvedTarget = {
  packageIdentity?: PackageIdentity
  packageInstance?: PackageInstance
  packageVersion?: string
  moduleId: ModuleIdentity
  resolvedFile: string
  exportedSymbol?: string
  symbolId?: string
  resolutionEvidence: ResolutionEvidence[]
}
```

The exact TypeScript representation may evolve; the semantics are normative.

### 4.1 ModuleIdentity

A module identity MUST identify the concrete module instance used by the
program graph, not merely a package name. It must distinguish package name,
package instance/root, concrete file, and symbol where applicable.

### 4.2 PackageInstance

Different installed versions or dependency instances MUST remain distinct.

Example:

```text
node_modules/foo/
node_modules/bar/node_modules/foo/
```

must not collapse into one `foo` identity.

The remediation analysis confirms that the multiple-version failure shares
the same root cause as conditional-export target resolution: reachability
finds the correct installed instance, while the verdict path can resolve a
different one. fileciteturn4file1L99-L106

### 4.3 PackageInstance Selection Authority

§4.2 and §5 together require that distinct installed instances never
collapse into one identity, and that the verdict layer reuse graph-discovered
resolved targets rather than independently re-resolving them. Neither
explicitly states which layer is *authoritative* for a given finding's own
PackageInstance, or what MUST happen when the call graph discovers fewer
physical instances than dependency discovery knows exist. This is a real
gap, not merely an implementation slip: an implementation can satisfy §5's
letter (it reuses a graph-discovered target) while violating §4.2's intent
(a finding silently receives a different instance's verdict).

The dependency graph (docs/SDD.md § 11), not the call graph, MUST be the
authoritative source of which PackageInstance a given finding corresponds
to. Each installed instance dependency discovery produces already carries
its own install location; that location MUST be carried into
`ResolvedTarget`/verdict resolution for that specific finding, not
reconstructed after the fact from whichever instances the call graph
happened to traverse.

This matters because the call graph only discovers instances actually
reached by a resolved import (§7's on-demand traversal); it MUST NOT be
treated as an enumeration of every installed instance. A package with N
installed instances may have fewer than N of them appear in the call graph
-- correctly, since some may genuinely never be imported.

Verdict resolution for one specific finding's PackageInstance MUST NOT
substitute a different PackageInstance's graph-discovered result merely
because it is the only one the call graph happens to contain. Selection MUST
be authorized by the finding's own known instance identity, never by
locating "some" instance sharing the target package name and assuming it
coincides.

When a finding's specific PackageInstance was not traversed by the call
graph at all, and graph construction was not truncated (§3.3), this MUST be
treated as confirmed non-reachability for that instance -- §7's on-demand
discovery is complete under a non-truncated graph, so an instance's total
absence from it is itself the positive evidence §3.3 requires -- never as
license to reuse an unrelated instance's reachability result.

Confirmed by the independent v2 adversarial suite (`tests/adversarial-v2/`,
ADV2-045): with two installed instances of the same package at different
versions, only one of which is ever imported, the unreached instance's
finding incorrectly inherited the reached instance's AFFECTED verdict.
Root cause: target-node selection in the verdict layer only cross-checked a
finding's version against graph-discovered instances when more than one
instance was present in the call graph; with exactly one graph-discovered
instance, it was reused unconditionally regardless of whether its version
matched the finding under evaluation. See VT-212 (§13).

## 5. Single Resolution Source of Truth

Module resolution MUST be consistent throughout the pipeline.

Conceptually:

```text
Source code
   ↓
Module resolver
   ↓
ResolvedTarget
   ↓
Call graph
   ↓
Reachability
   ↓
Verdict
```

The verdict/reachability layer MUST reuse graph-discovered resolved targets
instead of independently resolving the vulnerability target from a generic
project-root context.

This is an MVP P0 requirement for conditional exports and multiple installed
versions. fileciteturn4file1L81-L95

## 6. Entrypoint Semantics

VulnTrace MUST distinguish file and symbol entrypoints.

Recommended precise form:

```yaml
entrypoints:
  - file: src/index.ts
    symbol: main
```

When a symbol is explicitly configured, only that symbol is an entrypoint
source. Other exports in the same file are not automatically reachable.

Thus:

```js
export function main() {
  safe();
}

export function unused() {
  vulnerable();
}
```

must not become AFFECTED merely because `unused` is exported.

Multiple configured entrypoints are evaluated independently; one genuinely
vulnerable entrypoint is sufficient for AFFECTED.

## 7. Call Graph

Call edges MUST preserve resolution status:

```ts
type CallEdgeResolution =
  | { kind: "resolved"; target: GraphNode }
  | {
      kind: "unknown"
      reason: DynamicCallReason
      potentialTargets?: GraphNode[]
    }
```

### 7.1 Higher-order calls

For:

```js
function invoke(fn) {
  fn();
}
invoke(vulnerable);
```

the MVP MUST at minimum avoid false NOT_AFFECTED. If value-flow resolution
is not implemented, `fn()` may conservatively become
`UNKNOWN(unsupported_construct)`. Full lightweight value-flow is P1. The
remediation plan identifies the missing value flow as the cause of ADV-019.
fileciteturn4file3L134-L143

**VT-213 (landed):** a structurally distinct case from the named-parameter
form above -- a call passing exactly one *inline* function-expression/
arrow-function argument (`arr.map(() => vulnerable())`,
`promise.then(() => vulnerable())`) -- is now also resolved, without
special-casing any specific method name. The inline callback's own body was
already walked and correctly recorded any calls made from within it; only
the connecting edge from the call site to the callback's own node was
missing. Deliberately narrow, matching this section's own MVP framing:
exactly one inline callback argument (never a named reference -- that
remains the case above, still P1/not yet implemented as VT-214), and never
when more than one inline callback argument is present in the same call
(picking one over another would be a guess). Confirmed by the independent
v2 adversarial suite (ADV2-018, ADV2-024).

**VT-214 (landed):** the named-reference case explicitly deferred above is
now partially closed -- specifically, a same-file `const` binding that
simply aliases an already-resolvable value: a plain reassignment
(`const doIt = vulnerable; doIt();`), an object-literal property holding
one (`const o = { run: vulnerable }; o.run();`), or a destructured rename
off a namespace import (`const { vulnerable: v } = lib; v();`).
`let`/`var` bindings are intentionally excluded (reassignment is not
tracked); the aliased-to value must itself resolve via an already-shipped
mechanism (single-hop, no further aliasing). Confirmed by the independent
v2 adversarial suite (ADV2-036, ADV2-037, ADV2-038).

**VT-217 (landed):** two related, deliberately narrow computed-key
capabilities, both scoped to "the key is a literal or a same-file `const`
initialized to one" -- never a parameter, function call, or reassignable
binding:

- Export side (`module-model.ts`): `module.exports = { [NAME]: impl }`
  now unpacks to a real named export when `NAME` resolves to a literal,
  instead of being unconditionally skipped as "computed, therefore
  unknowable." Confirmed by ADV2-028.
- Call side (`call-graph.ts`): VT-214's alias resolution now also handles
  `const fn = fns[KEY];` (an element access, not just an identifier or
  property access) when `KEY` resolves to a literal, converting it into
  the equivalent property access and resolving it the same way. `fns`
  itself is additionally resolved through at most one hop of same-file
  `const` aliasing with any type-assertion wrapper unwrapped first
  (`const fns = lib as unknown as X;` makes `fns` and `lib` the exact
  same runtime value -- a type assertion is erased at compile time, not a
  second layer of real indirection). Confirmed by ADV2-042 (the exact
  double-assertion shape above is the real fixture's own shape).

Neither capability introduces general points-to analysis: both terminate
in a single, bounded lookup, and a key that isn't a traceable literal
(ADV2-025/026/027/040/043's genuinely dynamic/environment-driven cases)
correctly stays unresolved.

### 7.2 Constructors

`new VulnerableClass()` MUST create a constructor edge. If the target cannot
be resolved, it must be UNKNOWN rather than silently omitted.

**VT-215 (landed):** a class relying on the implicit/default constructor
(no explicit `constructor() {}` of its own -- the common case) has no
`ConstructorDeclaration` AST node at all, so `new VulnerableClass()` for
such a class could never resolve, degrading to an unrelated
`unknown(unresolved_target)` edge that could spuriously block an otherwise-
confirmed `unreachable` conclusion elsewhere in the same search. A
synthetic constructor entry is now indexed at the class's own name
position for any class with no explicit constructor of its own; since it
has no corresponding real AST subtree, it can never acquire outgoing edges
-- an implicit constructor provably does nothing. Confirmed by the
independent v2 adversarial suite (ADV2-041).

This synthesis interacted with a separate, pre-existing gap in
`bindCallee`'s own named-import handling (it deliberately ignores a
callee's trailing property chain -- see its own doc comment): once a bare
class name started resolving successfully far more often, `ClassName.
member()` calls began being silently misattributed to `ClassName`'s own
(now-resolvable, edge-less) constructor instead of staying honestly
unresolved -- a newly-reachable false NOT_AFFECTED, confirmed against
ADV2-021 during VT-215's own implementation. A guard was added alongside
VT-215 (not a VT-216 implementation -- resolving static/inherited member
access correctly is still VT-216's separate task) that refuses this
specific resolved-to-the-wrong-node outcome and falls through to the
later resolution attempts instead. Where VT-208 (§ 7.3) can independently
resolve the real member via the type checker, this incidentally also
closes ADV2-021 without VT-216 -- but a case VT-208 itself can't resolve
(e.g. ADV2-022's inherited-member gap) correctly remains UNKNOWN.

### 7.3 Instance methods

For `instance.vulnerableMethod()`, the implementation SHOULD use the
TypeScript type checker (`getTypeAtLocation` / `getSymbolAtLocation`) to
associate the receiver with its class and resolve the method. This is
consistent with the existing TypeScript-based resolution approach.
fileciteturn3file1L93-L104

**VT-216 (landed):** the gap above is closed. `resolveInstanceMethod` no
longer manually scans the receiver's own `classDecl.members`; it uses
`checker.getPropertyOfType(type, name)` instead, which follows the
checker's own apparent-type resolution -- including inherited members from
a base class the receiver's own (sub)class declares no override of. A
locally-defined subclass with no override of its own
(`class MySub extends Base {}`) now resolves `instance.vulnerableMethod()`
to `Base`'s real declaration, in whatever file it actually lives in. An
overridden method correctly resolves to the *subclass's* own override, not
the base's, matching real prototype-chain shadowing (the checker's own
resolution already handles this correctly). Exactly one real method
declaration is still required -- a union-of-classes receiver producing
more than one candidate declaration for the same name still falls back to
`unsupported_construct`/UNKNOWN, unchanged from VT-208's original
conservatism. Confirmed by the independent v2 adversarial suite (ADV2-022).

### 7.4 Re-exports

One-hop and multi-hop re-export chains MUST preserve vulnerable-symbol
identity and become permanent regression fixtures.

## 8. TypeScript Path Aliases

`baseUrl` / `paths` are MVP scope and MUST work end-to-end using the real
project `tsconfig.json`, not only isolated resolver tests.

The current investigation found that the real fixture can load the correct
compiler options while on-demand resolution still returns unresolved.
The exact compiler-host root cause remains to be isolated. fileciteturn4file5L217-L230

A fixture-level regression test is mandatory.

## 9. Reachability Semantics

For MVP:

```text
reachable = a graph path exists
```

This is graph reachability, not proof that code executes at runtime under
every branch/environment.

Therefore static `if (false)` handling is a precision enhancement unless
explicitly promoted. The remediation analysis classifies documenting this
semantics as MVP P0 and constant folding as post-MVP P2. fileciteturn2file4L195-L206

## 10. Verdict Algorithm

Conceptually:

```text
1. Resolve dependency/vulnerability target.
2. Build graph from configured entrypoints.
3. Traverse reachable nodes.
4. Track resolved edges, unknown edges, resolution failures and coverage.
5. Determine whether the vulnerable target is reached.
6. Apply verdict rules.
```

Rules:

```text
IF vulnerable target is reached with sufficient evidence
    => AFFECTED

ELSE IF target is not reached
     AND no relevant UNKNOWN exists
     AND analysis coverage is complete
     AND target/module identity is consistent
    => NOT_AFFECTED

ELSE
    => UNKNOWN
```

## 11. Evidence

### AFFECTED

Evidence SHOULD include entrypoint, source location, call path, resolved
package instance, vulnerable symbol, and resolution evidence.

### NOT_AFFECTED

Evidence SHOULD establish that entrypoints were examined, target identity
was resolved consistently, reachable paths were exhausted, no relevant
UNKNOWN remains, and analysis coverage is complete.

### UNKNOWN

Evidence MUST explain unresolved, unsupported, ambiguous, or incomplete
analysis.

## 12. Adversarial Regression Suite

All 34 adversarial scenarios become permanent regression fixtures. Expected
verdicts MUST remain independent of VulnTrace output.

A second, independently-authored suite (`tests/adversarial-v2/`, 45
scenarios) exists to detect overfitting to the original 34. It is not yet
folded into the MVP safety gate below; ADV2-045 identified VT-212 (§13).

CI MUST fail on regressions.

Minimum MVP safety gate:

```text
All P0 adversarial scenarios: PASS
No false NOT_AFFECTED caused by silent analysis gaps
```

## 13. Remediation Tasks

### P0

- **VT-201 — Graph completeness invariant**
- **VT-202 — UNKNOWN-safe verdict**
- **VT-203 — ResolvedTarget / module identity**
- **VT-204 — Reuse graph resolution**
- **VT-205 — Entrypoint semantics**
- **VT-206 — TypeScript path aliases**
- **VT-212 — PackageInstance selection authority in verdict resolution**
  (§4.3; identified post-hoc via the independent v2 adversarial suite,
  ADV2-045; not yet implemented)

### P1

- **VT-207 — Constructor resolution**
- **VT-208 — Instance method resolution**
- **VT-209 — Re-export chains**
- **VT-210 — Lightweight higher-order value flow**

### P2 / post-MVP

- **VT-211 — Static branch folding**

## 14. Implementation Order

```text
VT-201 Graph completeness
        ↓
VT-202 UNKNOWN-safe verdict
        ↓
VT-203 ResolvedTarget / identity
        ↓
VT-204 Single resolution source
        ↓
VT-205 Entrypoints
        ↓
VT-206 TS paths
        ↓
VT-207 Constructor
        ↓
VT-208 Methods
        ↓
VT-209 Re-exports
        ↓
VT-210 Higher-order flow
        ↓
VT-211 Static branches
        ↓
VT-212 PackageInstance selection authority (not yet implemented)
```

The first six tasks (VT-201-206) plus VT-212 are the MVP safety gate; VT-212
was identified after VT-211 shipped, via the independent v2 adversarial
suite, so it lands out of its natural implementation-order position in this
diagram.

## 15. MVP Readiness

VulnTrace MUST NOT be considered MVP-ready merely because unit tests pass.

MVP requires:

1. all P0 remediation tasks complete;
2. all 34 adversarial scenarios pass, or remaining deviations are explicitly
   accepted and documented;
3. no known false NOT_AFFECTED caused by silent graph gaps;
4. graph and verdict share consistent target identity (not currently met --
   see VT-212, §4.3, §13; ADV2-045 shows a finding can silently receive a
   different PackageInstance's verdict);
5. entrypoint semantics are deterministic;
6. UNKNOWN is conservative;
7. evidence explains every verdict;
8. TypeScript path aliases work end-to-end;
9. conditional exports and multiple installed versions do not produce false
   NOT_AFFECTED.

## 16. Non-Goals

This revision does not require full runtime simulation, general-purpose
points-to analysis, arbitrary dynamic-code resolution, complete control-flow
feasibility, symbolic execution, or full interprocedural data-flow analysis.

The goal is sound, explainable reachability rather than maximal language
coverage.

## 17. Design Principle

> **A vulnerability is actionable when the vulnerable behavior can be
> demonstrated as reachable from configured application entrypoints, with
> enough evidence to support the verdict.**

Corollary:

> **When VulnTrace cannot establish non-reachability safely, it must say
> UNKNOWN rather than NOT_AFFECTED.**
