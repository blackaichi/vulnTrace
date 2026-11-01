| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-64 | `foo` (synthetic workspace fixture) | A versionless package instance is evaluated only against advisories its own (missing) version would filter to | silent drop — see below | **Fixed** (B-4) — see below |

## PRM-64 — A versionless package instance is evaluated only against advisories its own (missing) version would filter to

**Status:** Open
**Failure class:** silent drop
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** B — intake, cache, output

`package-instances.ts`'s comment states a versionless instance is "still evaluated against whatever the siblings' queries return", but the synthetic provider (modeling OSV's documented per-version filtering) is queried once at the one concrete version present; a sibling advisory that a different, unversioned query would have returned is never considered and nothing records that it was skipped.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-2.md § 5 ("PRM-64 FALSE")`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task B-4, 2026-10-10): Fixed** (decision 4).
`advisoryQueryVersions` adds one query **without a version** for a
package name with any instance whose version is not established, and
every advisory returned is evaluated against every instance of the name:
the versionless instance gets an `UNKNOWN` finding
(`advisory_version_applicability_indeterminate`) for each, a versioned
sibling keeps its own applicability (`matchVersion`). This covers every
reason a registry instance has no version: no version declared, a
contradiction (`installed_version_conflicted`) and an unreadable or
unusable installed manifest (`installed_manifest_untrusted`) alike; before
B-4 each of those was asked nothing, and an advisory affecting no
sibling's version was never named. Reproduced end to end with the round-2
audit's fixture, failing on the base
(`src/cli/scan.b4-inventory-identity.test.ts`, "B-4 / PRM-64"): `GHSA-y`
now reaches `packages/foo`, and is `not_applicable` to the nested
`foo@1.0.0`. Five existing tests pinned "no query" as expected and were
changed to the decided behaviour (F3 § 4, F1-B § 18–24, P1-A5 G/H; listed
in the B-4 task file).

---

