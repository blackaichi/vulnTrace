# Fixture: commonjs

A minimal CommonJS project with one direct npm dependency, `fixture-lib@1.0.0`
(a plain CommonJS package: `module.exports = { vulnerable, safe }`).
`src/index.cjs` requires the whole module (`const fixture =
require("fixture-lib")`) and calls `fixture.vulnerable()` from the
function it assigns to `module.exports`.

Expected result: a rule targeting `{module: "fixture-lib", export:
"vulnerable"}` is **AFFECTED** — this exercises `require()` +
whole-module property-access call resolution (docs/SDD.md § 17's
`const foo = require("foo"); foo.vulnerable();` convergence case),
distinct from the destructuring fixture's binding pattern.

The fixture must not execute during static analysis.
