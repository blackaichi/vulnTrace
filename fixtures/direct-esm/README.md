# Fixture: direct-esm

A minimal ESM project with one direct npm dependency, `fixture-lib@1.0.0`
(`export function vulnerable() {}` / `export function safe() {}`).
`src/index.ts` imports `vulnerable` directly and calls it from its
exported `main()`.

Expected result: a rule targeting `{module: "fixture-lib", export:
"vulnerable"}` is **AFFECTED** — `main` calls `vulnerable()` directly,
a one-hop resolved call path.

The fixture must not execute during static analysis.
