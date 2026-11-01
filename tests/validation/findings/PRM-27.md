| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-27 | `vuln-lib` (synthetic fixture) | A later string-key or getter property in an object-literal export is ignored; the earlier plain-key value is still published | false NOT_AFFECTED — see below | **Fixed** (E-1) — see below |

## PRM-27 — A later string-key or getter property in an object-literal export is ignored; the earlier plain-key value is still published

**Status:** Open
**Failure class:** false NOT_AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** C
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** E — export model

Spread elements are (correctly) skipped as unresolvable, but the same path also skips a later string-literal key (`run: safe, "run": danger`) or getter override (`get run(){ return danger; }`), so the earlier `safe` value is kept as the published export although JavaScript's last-write-wins semantics make `danger` the real one.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 3 (`PRM-27`) and § 4 (`export-map-string-key-override`, `export-map-getter-override`)`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task E-1, 2026-10-13): Fixed.** Three shapes were live
(a later string key, a getter, a spread); a dynamic computed key was
already `UNKNOWN`. `unpackObjectLiteralExports` now applies ADR 0009 § 4:
every key form names a property, the last plain definition of a name wins,
an accessor of the name or an unresolved computed key after its last
definition withdraws it, a spread anywhere in the literal withdraws every
name (ADR 0009 § 4, as written; E-1's audit, finding 6), and `__proto__:`
is no export. `tests/oracle/e1-export-write-set.test.ts`
(`prm27.*`, and the controls `control.literal-*`, one of which was a false
`AFFECTED` on the base).

---

