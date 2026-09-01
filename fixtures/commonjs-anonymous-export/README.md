# Fixture: commonjs-anonymous-export (RWF-003)

The permanent fixture for **RWF-003 — an anonymous function assigned
directly to `module.exports`** (see `tests/validation/FINDINGS.md` RWF-003,
discovered on real `minimist@1.2.5`, and hit again in `qs/lib/parse.js` /
`qs/lib/stringify.js`). It deliberately composes with RWF-004a's
same-package re-export chase, because that is the shape the real benchmark
hits — but the two relations stay separately observable, and the fixture
pins the RWF-004b boundary as unattributed exactly as
`commonjs-reexport-same-package` does.

## Shape

`fixture-lib@1.0.0` declares nothing in its own entry file, and the
implementation it forwards to has **no name at all**:

```text
node_modules/fixture-lib/index.js            (facade -- declares nothing)
  module.exports = require("./internal/middle")
        |
        v
node_modules/fixture-lib/internal/middle.js  (whole-module re-export)
  module.exports = require("../lib")
        |
        v
node_modules/fixture-lib/lib.js              (the real implementation)
  module.exports = function (input) { ... }   <-- ANONYMOUS
```

`src/index.cjs` requires the package and calls `fixture(input)` — the
package's whole exported value is itself the callable, exactly as with
`minimist`.

## Expected result

A rule targeting `{module: "fixture-lib", export: "default"}` — the
existing rule vocabulary's name for "the callable exported as
`module.exports`" — is **AFFECTED**, and the resolved target must be the
exact anonymous function:

- exact target file: `node_modules/fixture-lib/lib.js`, **not** the facade
  `index.js` and **not** the `internal/middle.js` hop;
- exact function: the anonymous `FunctionExpression` on `lib.js`'s
  `module.exports = ...` line — identified by its own source position,
  never by a name, because it has none;
- exact PackageInstance: `<root>/node_modules/fixture-lib`;
- evidence path ends at `lib.js`.

## Negative controls, in the same fixture

1. **Same-name decoy in the target's own file.** `lib.js` declares a
   function literally named `vulnerable` that nothing exports, *before* the
   real export — so both a bare same-file name search and a "first function
   in the file" heuristic bind there. A rule targeting
   `export: "vulnerable"` must stay **UNKNOWN**, never bind to it.
2. **Cross-package re-export (RWF-004b).** `node_modules/other-lib` is a
   different installed package whose whole API is *also* an anonymous
   `module.exports` function; `fixture-lib`'s facade hangs it off its own
   exported value as `fromOtherPackage`. A rule targeting that name must
   stay **UNKNOWN**: making anonymous exports resolvable must not, as a
   side effect, make them resolvable across a package boundary.
3. **Wrong PackageInstance.** A finding pinned to a different install
   location of the same package name must never read AFFECTED off this
   instance's nodes.

The fixture must not execute during static analysis.
