# Fixture: alias

An ESM project with one direct npm dependency, `fixture-lib@1.0.0`.
`src/index.ts` imports `vulnerable` under a local alias (`import {
vulnerable as v } from "fixture-lib"`) and calls it via the alias
(`export const main = () => v();`).

Expected result: a rule targeting `{module: "fixture-lib", export:
"vulnerable"}` is **AFFECTED** — this exercises symbol binding through
a renamed local identifier (docs/SDD.md § 17's `import { vulnerable as
v } from "foo"; v();` convergence case), proving resolution follows the
import's declared exported name, not the local alias.

The fixture must not execute during static analysis.
