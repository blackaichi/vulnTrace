## Precision limit — reachability does not prune paths after definitely-abrupt evaluation

**Severity:** PRECISION / false `AFFECTED` — **not** P0, and **not** a
soundness finding. No false `NOT_AFFECTED` and no Family C consequence
follows from it.
**Status:** **Open, pinned.** Cross-family and pre-existing; surfaced through
one additional spelling by RWF-023 and deliberately not fixed there.
**Discovered:** the independent RWF-023 soundness audit, which reproduced
every row below on base `86c8669` and on the RWF-023 branch.
**Pinned by:** `src/analysis/verdict.abrupt-completion-precision-limit.integration.test.ts`
(12 cases).

### The limitation

`analyzeReachability` walks the call graph, and the call graph is a purely
structural MAY-reachability over-approximation: **it does not model abrupt
completion at all.** Nothing prunes the statements that follow a `throw`, a
call that can only throw, or a class definition that cannot finish.

Abrupt-completion reasoning exists in this repository only in
module-model.ts, where RWF-016/017/018/019/020/022 use it to decide which
CommonJS export WRITE is authoritative. That is a different question, on a
different graph, with the opposite quantifier — MUST-execute rather than
MAY-execute. The two have never been connected, and the limitation is
visible with no class involved at all:

```js
bail();   // throws
key();    // never runs -- reported reachable
```

### Runtime truth (real node v26.7.0, asserted)

In every row below, `key()` **does not execute**. Any `AFFECTED` is a false
`AFFECTED`.

A class's heritage expression is evaluated FIRST, before any element and
therefore before any computed key — the superclass has to exist before the
prototype chain can be built — so a heritage call that throws leaves the
element list entirely unevaluated. (RWF-020's fixture README documents the
same ordering from the abrupt side. Note the deliberate contrast with
RWF-022's case, where the heritage call RETURNS an invalid value: there the
keys DO run before the `TypeError`, and RWF-023 correctly reports that one
`AFFECTED`.)

### Measured, base vs. now

| shape | runtime | base `86c8669` | now |
| --- | --- | --- | --- |
| `bail(); key();` | key does not run | AFFECTED | AFFECTED |
| `throw new Error("x"); key();` | key does not run | AFFECTED | AFFECTED |
| throwing heritage + **FIELD** key | key does not run | AFFECTED | AFFECTED |
| throwing heritage + **GETTER** key | key does not run | AFFECTED | AFFECTED |
| throwing heritage + **SETTER** key | key does not run | AFFECTED | AFFECTED |
| throwing heritage + **METHOD** key | key does not run | UNKNOWN | **AFFECTED** |
| throwing heritage + **STATIC METHOD** key | key does not run | UNKNOWN | **AFFECTED** |
| `throw ...;` then class + METHOD key | key does not run | UNKNOWN | **AFFECTED** |
| `[false && key()]` **FIELD** | key does not run | AFFECTED | AFFECTED |
| `[false && key()]` **GETTER** | key does not run | AFFECTED | AFFECTED |
| `[false && key()]` **METHOD** | key does not run | NOT_AFFECTED | **AFFECTED** |

### What RWF-023 did and did not do here

RWF-023 did **not** introduce an abrupt-completion model, and did not widen
one. Before it, a computed key on a METHOD was mis-attributed to the method's
own deferred node — so these shapes answered UNKNOWN or NOT_AFFECTED
*accidentally*, for a reason unrelated to abrupt completion. Correcting that
ownership made the method spelling answer the way its FIELD, GETTER and
SETTER siblings already did on base.

The bold rows are therefore the pre-existing limitation becoming visible
through one more spelling, not a new defect. Every movement is toward
`AFFECTED`; an over-approximation can only add findings, never license a
negative proof.

Where the analyzer *does* hold a real proof, RWF-023's new edge respects it:
`if (false) { class C { [key()]() {} } }` stays `NOT_AFFECTED` with a
complete Family C proof, because `evaluateConstantBoolean` keeps the walk out
of the untaken branch and the new edge is only emitted for nodes the walk
actually visits. The fix participates in the existing traversal rather than
blanket-rooting every computed key, and that boundary is pinned too.

### Why it was not fixed inside RWF-023

Gating the new computed-key edge on RWF-020's
`isDefinitelyAbruptClassHeritage` was considered and rejected:

- it would introduce a **call-graph → module-model dependency**, importing
  MUST-execute cutoff logic into a MAY-execute reachability walk;
- it would leave the FIELD, GETTER, SETTER and plain-statement spellings
  untouched, creating a semantic asymmetry between spellings of one shape;
- made consistent across those spellings, it would move existing findings
  from `AFFECTED` to `NOT_AFFECTED` — the one direction a reachability change
  must never take as a side effect of an unrelated task;
- and it would address only *throwing heritage*, not `throw`, not a throwing
  call in statement position, and not any other definitely-abrupt form.

### The proper fix

A unified, abrupt-completion-aware reachability model applied across all of
these forms at once: sequential top-level statements, throwing heritage,
throwing calls in any evaluated position, and every computed-key spelling.
That is an architectural change to the call-graph walk, it must be sound in
the `NOT_AFFECTED` direction before it is precise in the `AFFECTED`
direction, and it deserves its own task. Constant folding inside arbitrary
expressions (`false && key()`) is a separate, smaller sub-question and was
deliberately not added — inventing new positive proofs is how a false
`NOT_AFFECTED` gets built.

### Scope

- **False `AFFECTED` only.** Over-approximation cannot produce a false
  `NOT_AFFECTED` and cannot license a Family C proof.
- **Family A/B, ModuleLoadClosure, PackageInstance identity, entrypoint-root
  derivation:** unaffected.
- **RWF-014 … RWF-022 export-authority semantics:** unaffected; those live in
  module-model.ts and are untouched by this limitation and by its pin.

