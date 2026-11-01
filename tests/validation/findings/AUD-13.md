| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-13 | `vuln-lib` (synthetic fixture) | Babel-style `__esModule` interop is not modeled for a default ESM import of a CommonJS module | false AFFECTED — see below | Open |

## AUD-13 — Babel-style `__esModule` interop is not modeled for a default ESM import of a CommonJS module

**Status:** Open
**Failure class:** false AFFECTED
**Defect class:** B
**Proof family affected:** not applicable
**Severity:** Low
**Fix lane:** E — export model

For a library with `exports.__esModule = true; exports.default = realDanger`, Node's real ESM default import binds the whole `module.exports` object (an object, not a function); an app that branches `typeof def === 'function' ? def(1) : def.safe(1)` therefore calls the safe path. The analyzer does not model this Node ESM/CJS interop rule and reports AFFECTED.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-13"`. Not fixed here; this section records the finding only, per this task's boundaries.

---

