# Fixture: commonjs-reexport-same-package (RWF-004a)

The permanent fixture for **RWF-004a — same-package CommonJS re-export
resolution** (see `docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md` § 5, R-5a).
Deliberately kept separate from RWF-004b's own (cross-package re-export)
coverage, so one relation can never be confounded with the other.

## Shape

`fixture-lib@1.0.0` declares nothing in its own entry file. Its public
export table is assembled entirely from `require()`d siblings **inside the
same installed package**, over the real-world `var` + shorthand/property
spelling that qs and semver both use:

```text
node_modules/fixture-lib/index.js            (facade -- declares nothing)
  module.exports = { vulnerable: middle.vulnerable, safe: lib.safe, ... }
        |                                        |
        | var middle = require("./internal/middle")
        v
node_modules/fixture-lib/internal/middle.js  (whole-module re-export)
  module.exports = require("../lib")
        |
        v
node_modules/fixture-lib/lib.js              (the ONLY real declarations)
  function vulnerable(input) { ... }
  exports.vulnerable = vulnerable
```

`src/index.cjs` requires the package and calls `fixture.vulnerable(input)`.

## Expected result

A rule targeting `{module: "fixture-lib", export: "vulnerable"}` is
**AFFECTED**, and — this is the part the fixture actually pins — the
resolved target must be the real implementation:

- exact target file: `node_modules/fixture-lib/lib.js`, **not** the facade
  `index.js` and **not** the `internal/middle.js` hop;
- exact symbol: `lib.js`'s own `vulnerable` function declaration;
- exact PackageInstance: `<root>/node_modules/fixture-lib`;
- evidence path ends at `lib.js`.

## Negative control, in the same fixture

`node_modules/other-lib` is a **different installed package** exporting a
function with the **identical name** `vulnerable`, and `fixture-lib`'s
facade re-exports it as `fromOtherPackage`. Since RWF-004b that hop is
chased -- and it lands in **other-lib's own installed instance**, which is
the point: a `fixture-lib` rule target must still never bind to
`other-lib`'s function. A bare property-name match would fall for exactly
this, and so would a chase that resolved a package by name rather than by
where the `require()` actually points.

The fixture must not execute during static analysis.
