| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-02 | `vuln-lib` (synthetic fixture) | A package's own `exports.x()` / `module.exports.x()` self-call gets no call-graph edge | false NOT_AFFECTED — see below | **Fixed** (A-3b), through the fail-closed default — see below |

## AUD-02 — A package's own `exports.x()` / `module.exports.x()` self-call gets no call-graph edge

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** B
**Proof family affected:** C
**Severity:** Critical
**Fix lane:** A — call graph

The same early return that drops AUD-01's callback edges also fires when a module calls its own `exports.danger(x)`, `module.exports.danger(x)` or `exports['danger'](x)` — the root identifiers `exports`/`module` are on the same exempted list. Family C then certifies the target unreachable while Node's own `require` of the package calls it. Not RWF-047: this is the package writing and reading its own export inside one file, not a consumer mutating a required module object.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-02"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task A-3b, 2026-10-02): Fixed, through the fail-closed
default.** A call or `new` rooted in an undeclared CommonJS module-scope
binding no longer gets the unproven no-edge account
`module_scope_callee`, which task A-3b deleted
(`docs/tasks/A-3b-own-exports-jsx.md`). `exports…` and `module.exports…`
get an unknown `own_export_call` edge (non-widening,
`unmodeled_construct`); any other member of `module` or `require` an
unknown `loader_capability_escape` edge; `__dirname` / `__filename` the
receiver-shape subtype. A function handed to such a call gets a possible
edge, as at any unknown callee. ADR 0008 § 2's row allows "the own
export's node, or unknown"; a resolved edge was NOT given, by the project
owner's decision of 2026-10-02: the export model's attribution does not
see in-module write order (`exports.x = a; exports.x(); exports.x = b`)
or the `exports` alias going stale after `module.exports = …`, so it is
no authority for one until lane E's write set (backlog `BL-042`). The
three spellings the audit names, `new exports.X()` and an application
module calling its own export are reproduced against real Node in
`tests/oracle/a3b-own-exports-jsx.test.ts`: each a false `NOT_AFFECTED`
on the base, `UNKNOWN` on the branch. While reproducing them, task A-3b
found that the same branch hid a loader gap: RWF-065.

---

