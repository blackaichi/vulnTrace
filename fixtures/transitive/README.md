# Fixture: transitive

An ESM project that depends on `fixture-wrapper@1.0.0`, which in turn
depends on `fixture-lib@1.0.0` — `fixture-lib` is never a *direct*
dependency of this project. `src/index.ts` calls `fixture-wrapper`'s
`run()`, which calls `fixture-lib`'s `vulnerable()`.

Expected result: a rule targeting `{module: "fixture-lib", export:
"vulnerable"}` is **AFFECTED**, with a three-hop evidence path
(`main -> run -> vulnerable`) crossing two package boundaries — proving
reachability analysis follows resolved calls through an intermediate
dependency, not just the scanned project's own direct dependencies.

`fixture-lib` is installed hoisted at the top level (the common case for
an unconflicting transitive dependency); resolving a rule's `module`
field against a transitive dependency that is *not* hoisted (nested
under the intermediate package's own `node_modules`) is a known gap —
see TASK-024's completion report.

The fixture must not execute during static analysis.
