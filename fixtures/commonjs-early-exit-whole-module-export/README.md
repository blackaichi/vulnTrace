# Fixture: commonjs-early-exit-whole-module-export (RWF-015)

The permanent fixture for **RWF-015 — a top-level early exit that bypasses
the final whole-module CommonJS export**. It pins a false NOT_AFFECTED
that was reproducible on main after RWF-014, with a complete Family C
proof behind it.

## Shape

`fixture-lib@1.0.0` picks its callable API at load time and then leaves
module evaluation early:

```text
node_modules/fixture-lib/index.js
  function dangerousOp(input) { return danger.explode(input); }   <-- reaches the sink
  function safeOp(input)      { return "safe:" + input; }
  if (process.env.FIXTURE_LIB_MODE === "fast") {
    module.exports = dangerousOp;
    return;                          <-- ends module evaluation
  }
  module.exports = safeOp;           <-- top-level, unconditional, NOT always run
        |
        v
node_modules/fixture-lib/danger.js
  exports.explode = explode                                       <-- the advisory's target
```

`node_modules/fixture-lib/thrower.js` is the same file with the `return`
replaced by an uncaught `throw`. Each is scanned from its own entrypoint
(`src/index.cjs`, `src/thrower.cjs`) so the two abrupt-completion forms
stay independently observable.

## What separates this from RWF-014

`fixtures/commonjs-conditional-whole-module-export` writes `module.exports`
from both arms of an `if`/`else`, so **neither** write is a top-level
statement and RWF-014's rule — *the last write in the file must be
unconditional* — refuses on the spot.

Here the last write **is** a direct child of the source file. It is
unconditional by every syntactic test the analyzer had, and RWF-014
accepted it. The only thing wrong with it is that execution does not
always get there, and nothing in the model asked that question:

> Source order is last-write order only when every write definitely runs.
> RWF-014 established the "definitely runs" half for the write itself.
> RWF-015 is the other half — whether module evaluation is still running by
> the time the write is reached.

Node wraps every CommonJS module in a function, so a module-scope `return`
is legal and ends module evaluation where it stands; an uncaught
module-scope `throw` propagates out of the `require()` that triggered the
load. Either one leaves whatever `module.exports` already held as the
module's exported value.

## The defect this pins

With `FIXTURE_LIB_MODE=fast` the package genuinely exports `dangerousOp`
and genuinely calls `danger.explode`. The analyzer said otherwise:

1. `selectAuthoritativeWholeModuleExport` accepted the final write —
   `"unconditional"`, last in the file, no deferred writes anywhere.
2. `mapExportsToFunctions` bound `"default"` to `safeOp`.
3. call-graph.ts gave the application's `fixture(input)` call a fully
   **resolved** edge to `safeOp`.
4. `dangerousOp` was left with no incoming edge at all, so nothing reached
   `danger.explode`.
5. The reachability search returned unreachable with
   `reachableSubgraphComplete: true` — a Family C negative proof.
6. Verdict: **NOT_AFFECTED**, for a package that calls `explode` on every
   fast-path load.

As in RWF-014, nothing in that chain is a heuristic misfiring. Every step
is correct given step 1, and step 1 asked "is this write unconditional?"
when the question it needed answered was "is this write reached?".

## Expected result

A rule targeting `{module: "fixture-lib/danger", export: "explode"}` is
**UNKNOWN**, from both the `return` and the `throw` entrypoint:

- no `confirmedUnreachableTarget` — Family C must not answer a question
  about a target whose identity was never established;
- neither `dangerousOp` nor `safeOp` appears in the evidence path;
- a rule targeting the whole-module export itself is **UNKNOWN** too,
  rather than binding either branch.

Post-fix the whole-module export carries no provenance, so the call becomes
an honest `unknown(unresolved_target)` edge. UNKNOWN is not a degradation
here — it is the only answer the source supports.

## Negative controls, in the same fixture

1. **Family C still works.** `node_modules/fixture-lib/stable.js` exports
   `neverCalled` through a single unconditional top-level
   `module.exports = neverCalled`, with **no abrupt completion anywhere
   above it**. Its identity is a fact, and the target is genuinely never
   called, so it must stay **NOT_AFFECTED** with
   `reachableSubgraphComplete: true`.

   It is scanned from its own entrypoint, `src/stable-only.cjs`, which
   requires neither early-exit module. That isolation is deliberate and
   load-bearing, for the same reason as in the RWF-014 fixture: ambiguity
   introduces a real `unknown` edge, and uncertainty is a property of the
   searched **region** — so scanning this control from `src/index.cjs`
   correctly returns UNKNOWN and would prove nothing about whether
   definitely-reached exports still resolve. Separate entrypoints keep the
   questions separable.

2. **Wrong PackageInstance.** A finding pinned to a different install
   location of the same package name must never read a verdict off this
   instance's nodes, ambiguous export or not.

The fixture must not execute during static analysis.
