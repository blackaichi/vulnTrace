| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-15 | `vuln-lib` (synthetic fixture) | A same-file `const require = ...` shadow is matched by identifier text before the lexical authority runs | false NOT_AFFECTED — see below | **Fixed** (A-5a) — see below |

## PRM-15 — A same-file `const require = ...` shadow is matched by identifier text before the lexical authority runs

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** A
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** A — call graph

`isStaticRequireCall` matches `require("literal")` by name before checking whether `require` resolves to any lexical declaration in scope; a function-local `function require(name){ return lib.parse(name); }` shadow is read as the real module loader, and the call is treated as import setup with no edge, rather than as a call to the shadow. Family C certifies the target unreachable; Node calls the shadow, which calls `lib.parse`.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-15`) and § 4 (`local-require-shadow`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task A-5a, 2026-10-04): Fixed, on both sides.** A static
`require("x")` gets no edge only with the no-edge proof
`ambient_static_require` (ADR 0008 § 2's `AmbientStaticRequire`). It holds
only when five things are true:

- the file is a CommonJS module that never reads the wrapper's
  `arguments` (`isProvenCommonJsModuleScope`). Two variants came from
  task A-5a's independent audit, each a false `NOT_AFFECTED` on the base:
  - in an ES module, a bare `require` is a global lookup another module
    may set. An ES module is a `.mjs` file; a file with ESM syntax,
    including the two inputs Node's syntax detection also keys on, a
    top-level `await` and a top-level `let` / `const` / `class` that
    redeclares a wrapper parameter (the second and third audit rounds);
    or a `package.json` with `"type": "module"`;
  - in sloppy CommonJS, `arguments[1] = f` rebinds the wrapper's
    `require`.
- no enclosing scope declares `require` in any form;
- the file has no TypeScript `enum` or `namespace` of that name;
- the file writes no bare `require` in any assignment form, wrappers
  such as `(require) = f` and `require! = f` included;
- the call is not in a `with` body.

The check is `isAmbientStaticRequireCall` in `named-bindings.ts`. Any
other `require(...)` is an ordinary callee: a local `function require` or
`const require` resolves to it, and a parameter named `require` gets an
unknown edge.

**Measured, the binding side.** This task also found the same spelling
test in the import extraction (`source-index.ts`,
`extractRequireBindings`) and in `named-bindings.ts`'s
`requireCallInitializer`. So `const m = require("./util.js")` through a
local `require` that returns `lib` bound `m` to `util.js`'s exports, and
`m.parse()` resolved to the wrong module's function (a false
`NOT_AFFECTED`). Both now bind a name only through the ambient `require`.
The specifier is still recorded as a load, because dropping a load could
let family A certify a loaded package as never loaded.

The loader classifier (`loader-constructs.ts`) still recognises
`require` by spelling. That errs only toward an extra load or widening
edge, and is left as is.

Reproduced against real Node in
`tests/oracle/a5a-resolution-authority.test.ts` (`require.*` and the
audit's four `audit.*` cases), eight false `NOT_AFFECTED` on the base:

- the local function shadow and the local `const` shadow are `AFFECTED`;
- the parameter shadow, the shadowed binding, the `arguments` rebinding,
  the ES-module global `require`, the top-level-`await` file and the
  wrapper-redeclaring file are `UNKNOWN`.

A TypeScript file with ESM syntax compiled to CommonJS also loses the
proof, a precision cost.

The unproven `static_require_by_text` account is deleted.

---

