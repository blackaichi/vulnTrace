# Fixture: dynamic

An ESM project with one direct npm dependency, `fixture-lib@1.0.0`.
`src/index.ts` imports the whole module as a namespace (`import *
as fixture from "fixture-lib"`) and calls it through a computed
property access whose key is a runtime value, not a string literal
(`fixture[method]()`).

Expected result: a rule targeting `{module: "fixture-lib", export:
"vulnerable"}` is **UNKNOWN** — the call target cannot be statically
determined (docs/SDD.md § 21's `dynamic_member_access`), so the search
encounters a genuinely unresolved edge and must not be coerced into
either AFFECTED (fabricating a target) or NOT_AFFECTED (fabricating
certainty the search never established).

The fixture must not execute during static analysis.
