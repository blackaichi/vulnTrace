# Fixture: not-reachable

An ESM project with one direct npm dependency, `fixture-lib@1.0.0`
(`export function vulnerable() {}` / `export function safe() {}`).
`src/index.ts` imports and calls only the unrelated `safe` export;
`vulnerable` is never imported anywhere.

Expected result: a rule targeting `{module: "fixture-lib", export:
"vulnerable"}` is **NOT_AFFECTED** — the call graph is fully resolved
(no dynamic/unresolved edges anywhere), so reachability search
positively establishes that `vulnerable` is unreachable from every
discovered entrypoint, rather than merely finding no path.

The fixture must not execute during static analysis.
