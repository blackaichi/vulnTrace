| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-36 | `vuln-lib` (synthetic fixture), workspaces | The `--cve` unreported-candidate reason "no advisory was discovered for any sibling instance" is computed from the filtered result, not the true discovery set | false reason — see below | **Fixed** (B-5) — see below |

## PRM-36 — The `--cve` unreported-candidate reason "no advisory was discovered for any sibling instance" is computed from the filtered result, not the true discovery set

**Status:** Open
**Failure class:** false reason
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** B — intake, cache, output

Filtering with `--cve CVE-Y` on a package for which `GHSA-x` (`CVE-X`) was really discovered still reports the `unreportedCandidates` detail as "no advisory was discovered for any sibling instance" — false, since `GHSA-x` was discovered and then filtered out by `--cve`, not because none exists.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 4, "PRM-36: false reason under --cve"`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task B-5, 2026-10-11): Fixed.** Measured first:
the recorded sentence ("no advisory was discovered for any sibling
instance") no longer existed on `main` at B-5's base. B-4 queries a
versionless instance itself and rewrote the detail to "no advisory matching
`<id>` was returned". On the audit's own fixture shape and `--cve CVE-Y`,
the versionless member now gets an `UNKNOWN` for `GHSA-y` and no "no
advisory" entry at all (asserted, passing on the base too). What was left
is the plan's prescription: the detail's condition was still the filtered
set, so with a filter matching nothing for the name it could not say that
advisories were returned and filtered out. B-5 decides it on the
unfiltered set (`returnedForName` in `scan.ts`): "no advisory was returned
for this name" only when none was, and otherwise "`N` advisories were
returned for this name (its query without a version included), and none
matches --cve `<id>`" (or "none was usable"), counting distinct advisories
over all of the name's queries (B-5's audit found the first draft counted
one advisory twice when one query returned it usable and another
malformed). Failing on the base:
`src/cli/scan.b5-cli-output.test.ts`, "B-5 (PRM-36)".

---

