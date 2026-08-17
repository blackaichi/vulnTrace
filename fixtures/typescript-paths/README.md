# Fixture: typescript-paths

An ESM project (NodeNext module resolution) with a real `tsconfig.json`
declaring `baseUrl`/`paths` (`"@lib/*": ["src/lib/*"]`). `src/index.ts`
reaches `fixture-lib`'s `vulnerable` export only through a path-aliased
local wrapper, `src/lib/wrapper.ts`, imported as `"@lib/wrapper.js"`.

Expected result: a rule targeting `{module: "fixture-lib", export:
"vulnerable"}` is **AFFECTED** — `main()` unconditionally calls
`callVulnerable()` via the aliased import, and `callVulnerable()`
unconditionally calls `vulnerable()`.

The `.js` extension on `"@lib/wrapper.js"` is required, not optional: under
NodeNext/ESM module resolution, TypeScript enforces the same explicit
extension requirement Node's own ESM resolver enforces for relative
imports, and a `baseUrl`/`paths`-mapped specifier is resolved the same way
once substituted. Omitting it (`"@lib/wrapper"`) fails resolution — this
was confirmed, during VT-206's investigation, to be the true root cause
behind an earlier version of this fixture appearing to expose a resolver
bug: the resolver was already correct; the fixture's own import was
missing a required extension. See VT-206's completion report and
`src/analysis/fixture-suite.integration.test.ts`'s `typescript-paths` case
for the real, end-to-end regression guard.

The fixture must not execute during static analysis.
