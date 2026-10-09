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

## Correction (task C-1, 2026-10-09)

The expected result above is no longer **AFFECTED**: it is **UNKNOWN**
(`unresolved_module`). Node never reads `tsconfig.json`, so real `node`
looks for an installed package named `@lib/wrapper.js` and throws
`MODULE_NOT_FOUND`; the program runs only under a toolchain that rewrites
or honours `paths` (a bundler, `tsconfig-paths`), and which file that
toolchain loads is not Node's answer. Under ADR 0010 invariant C2 a
tsconfig mapping that disagrees with Node's resolution makes the specifier
unresolved, rather than following either answer (the project owner's
decision of 2026-10-09; `docs/tasks/C-1-runtime-resolution-mode.md`). The
fixture is kept unchanged as the regression for that rule; see
`src/analysis/fixture-suite.integration.test.ts`.
