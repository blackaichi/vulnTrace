# Fixture: destructuring

A minimal CommonJS project with one direct npm dependency,
`fixture-lib@1.0.0` (a plain CommonJS package: `module.exports = {
vulnerable, safe }`). `src/index.cjs` destructures the vulnerable
export directly out of `require()` (`const { vulnerable } =
require("fixture-lib")`) and calls it from the function it assigns to
`module.exports`.

Expected result: a rule targeting `{module: "fixture-lib", export:
"vulnerable"}` is **AFFECTED** — this exercises destructured
`require()` binding resolution (docs/SDD.md § 17's `const {
vulnerable } = require("foo"); vulnerable();` convergence case),
distinct from the commonjs fixture's whole-module property-access
pattern.

The fixture must not execute during static analysis.
