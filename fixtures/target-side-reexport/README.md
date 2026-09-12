# Fixture: target-side-reexport (P1-A1)

The permanent fixture for **P1-A1 — target-side re-export resolution**, the
remediation of the `RWB-05` family. Asserted by
`src/analysis/verdict.target-side-reexport.integration.test.ts`, with real
Node ground truth in `verify.cjs`.

## What this family is, and what it is not

The **vulnerable package itself** publishes the advisory's named symbol
through one or more forwarding layers, so the advisory's target is defined
nowhere in the file that exports it. That must be resolved to the concrete
implementation *before* reachability can reason about it.

Two neighbouring problems it is deliberately **not**:

- **Consumer-side re-export** (RWF-004a/b,
  `fixtures/commonjs-reexport-same-package`): a call site following a value
  through a package's re-exports. That relation already worked. It resolves
  `fixture-lib#vulnerable` only because some file in that package exports
  the advisory's literal name (`exports.vulnerable = vulnerable` in
  `lib.js`), which per-file attribution finds directly.
- **Application-entrypoint root derivation** (P0-Z,
  `fixtures/entrypoint-reexport-root-completeness`): deriving reachability
  ROOTS from a configured entrypoint's forwarded exports. Root selection
  must WIDEN when uncertain; target identity must REFUSE. Opposite failure
  directions — the two must never share a relation.

`RWB-05`'s real `qs@6.10.1` is the case neither covers:

```js
// qs/lib/index.js -- declares nothing
var parse = require('./parse');
module.exports = { formats: formats, parse: parse, stringify: stringify };

// qs/lib/parse.js -- the implementation, an ANONYMOUS whole-module default
module.exports = function (str, opts) { ... };
```

No file in `qs` exports anything called `parse`: the advisory-facing name
is `parse`, the implementation-facing name is the canonical `"default"`.
Per-file attribution therefore could not answer the advisory at all, and
the finding degraded to UNKNOWN.

## The matrix

Each installed package under `node_modules/` isolates one forwarding shape;
each `src/*.cjs` is a consumer entrypoint scanned on its own.

| Package | Shape | Expected target resolution |
|---|---|---|
| `direct-lib` | no forwarding at all (control) | `index.js`'s own `vulnerable` |
| `onehop-lib` | **the exact `qs` shape** — `var impl = require("./impl")` published through an object literal, landing on an ANONYMOUS default | `impl.js`'s anonymous callable |
| `twohop-lib` | `index` → `api` → `impl`, whole-module both hops | `impl.js`'s `twoHopImplementation` |
| `renamed-lib` | `exports.vulnerable = require("./impl").internalName` — plus a decoy literally named `vulnerable` in that same file | `internalName`, **never** the decoy |
| `alias-lib` | single-assignment local alias between require and export | `impl.js`'s `internalName` |
| `reassigned-lib` | alias REASSIGNED before the export write | **refused** — the stale binding is not what Node publishes |
| `duplicate-lib` | two writes to `exports.vulnerable`, last wins | the LAST write's `harmless`, never the stale first |
| `cycle-lib` | `index` → `a` → `b` → `a` | **refused**, terminating — never an arbitrary member |
| `dynamic-lib` | computed `require()` specifier | **refused** |
| `conditional-lib` | conditional export write | **refused** |
| `boundary-lib` | relative hop escaping the package root into `outside-lib` | **refused** — advisory ownership is not re-pointed |
| `crosspkg-lib` | bare-specifier hop into `outside-lib` | **refused**, same reason |
| `twin-lib` | same name **and** version installed twice (top-level, and nested under `wrapper-lib`), each forwarding to its own impl | each instance answered only by its own install path |

Reachability controls: `src/onehop-reachable.cjs` calls the forwarded
export (→ AFFECTED, with a concrete path into `impl.js`);
`src/onehop-unreachable.cjs` calls only the unrelated sibling export, so the
same target resolves exactly and then receives a genuine negative proof
(→ NOT_AFFECTED). Exact resolution must never, by itself, force AFFECTED.

## Ground truth

`node verify.cjs` asserts, under real Node: which instance and which
forwarding files load, which concrete callable each package publishes under
`vulnerable` (by identity, not just by name), that the reassigned and
duplicated cases publish the *current* value rather than the stale one, that
the cycle publishes nothing, that the two twins are name- and
version-identical yet publish different callables, and that every reachable
consumer really does enter its implementation.

VulnTrace itself never executes target code — the runtime oracle is
test-only, and is run out-of-process by the integration suite.
