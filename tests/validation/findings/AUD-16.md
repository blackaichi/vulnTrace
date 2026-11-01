| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-16 | `vuln-lib` (synthetic fixture) | Two README sentences and two HTML-report sentences describe cache/no-finding behavior that AUD-05/06/07/08/09 show is false | disclosure — see below | Open |

## AUD-16 — Two README sentences and two HTML-report sentences describe cache/no-finding behavior that AUD-05/06/07/08/09 show is false

**Status:** Open
**Failure class:** disclosure
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** Low
**Fix lane:** D — disclosure

README says the cache directory is "(gitignored)" — true only of VulnTrace's own `.gitignore`, not a scanned project's — and that a different build's cache entry "is never reused" — the key is the literal `package.json` version string, not a build identity, so two builds sharing that string collide. `html-report.ts`'s summaries for "not applicable" and "no findings" describe behavior AUD-05/06/07/08/09 show is not what happens. The two README sentences are corrected by this task (see README.md); the HTML report's own sentences are left to a later, code-owned fix, per this task's instructions.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-16"`. Not fixed here; this section records the finding only, per this task's boundaries.

---

