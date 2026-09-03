# Fixture: commonjs-conditional-whole-module-export (RWF-014)

The permanent fixture for **RWF-014 — a whole-module CommonJS export
written from both arms of a runtime conditional**. It pins a false
NOT_AFFECTED that was reproducible on main before this task, with a
complete Family C proof behind it.

## Shape

`fixture-lib@1.0.0` does not decide its own callable API until load time:

```text
node_modules/fixture-lib/index.js
  function dangerousOp(input) { return danger.explode(input); }   <-- reaches the sink
  function safeOp(input)      { return "safe:" + input; }
  if (process.env.FIXTURE_LIB_MODE === "fast") {
    module.exports = dangerousOp;
  } else {
    module.exports = safeOp;
  }
        |
        v
node_modules/fixture-lib/danger.js
  exports.explode = explode                                       <-- the advisory's target
```

`src/index.cjs` requires the package and calls `fixture(input)` — the
package's whole exported value is itself the callable, exactly as with
`minimist`.

Both right-hand sides are **bare identifiers** naming a same-file function
declaration. That is the point of this fixture and what separates it from
`fixtures/commonjs-stale-alias-export` and from RWF-012's chained form:
`unwrapValue` is irrelevant here, RWF-012's chained-assignment guard never
engages, and the only thing that can refuse the binding is the *authority*
of the assignment itself.

## The defect this pins

Before RWF-014, `findLastModuleExportsAssignment` kept whichever
`module.exports` write it saw **last in source order** and let every
consumer treat it as the module's identity. Here that is `safeOp`, purely
because `else` is written after `if`. Downstream, that single wrong fact
compounded into a confident, internally consistent, wrong answer:

1. `mapExportsToFunctions` bound `"default"` to `safeOp`.
2. call-graph.ts gave the application's `fixture(input)` call a fully
   **resolved** edge to `safeOp`.
3. `dangerousOp` was left with no incoming edge at all, so nothing reached
   `danger.explode`.
4. The reachability search returned unreachable with
   `reachableSubgraphComplete: true` — a Family C negative proof.
5. Verdict: **NOT_AFFECTED**, for a package that calls `explode` on every
   run where `FIXTURE_LIB_MODE` is `"fast"`.

Nothing in that chain is a heuristic misfiring. Every step is correct given
step 0, and step 0 was a branch chosen by text position.

## Expected result

A rule targeting `{module: "fixture-lib/danger", export: "explode"}` is
**UNKNOWN**:

- no `confirmedUnreachableTarget` — Family C must not answer a question
  about a target whose identity was never established;
- neither `dangerousOp` nor `safeOp` appears in the evidence path;
- a rule targeting `{module: "fixture-lib", export: "default"}` is
  **UNKNOWN** too, rather than binding either arm.

Post-fix the whole-module export carries no provenance, so the call becomes
an honest `unknown(unresolved_target)` edge. UNKNOWN is not a degradation
here — it is the only answer the source supports.

## Negative controls, in the same fixture

1. **Family C still works.** `node_modules/fixture-lib/stable.js` exports
   `neverCalled` through a single **unconditional** top-level
   `module.exports = neverCalled`. Its identity is a fact, and the target
   is genuinely never called, so it must stay **NOT_AFFECTED** with
   `reachableSubgraphComplete: true`.

   It is scanned from its own entrypoint, `src/stable-only.cjs`, which
   never requires the conditionally-exporting module. That isolation is
   deliberate and load-bearing: RWF-014's ambiguity introduces a real
   `unknown` edge, and uncertainty is a property of the searched **region**
   — so scanning this control from `src/index.cjs` correctly returns
   UNKNOWN, and would prove nothing about whether unconditional exports
   still resolve. Two entrypoints keep the two questions separable.

2. **Wrong PackageInstance.** A finding pinned to a different install
   location of the same package name must never read a verdict off this
   instance's nodes, ambiguous export or not.

The fixture must not execute during static analysis.
