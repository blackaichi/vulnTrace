| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-09 | `vuln-lib` (synthetic fixture) | A GIT-type version range is compared as semver, and an advisory entry with neither ranges nor versions reads as not-affected | silent drop (false "not applicable") — see below | **Fixed** (B-2) — see below |

## AUD-09 — A GIT-type version range is compared as semver, and an advisory entry with neither ranges nor versions reads as not-affected

**Status:** Open
**Failure class:** silent drop (false "not applicable")
**Defect class:** B
**Proof family affected:** not applicable
**Severity:** High
**Fix lane:** B — intake, cache, output

A GIT-type range's fixed commit hash is run through `semver.coerce` (e.g. `coerce('3f2a9c1b0d')` = `'3.0.0'`), so an installed `5.0.0` is reported `not_applicable` against a range that cannot legitimately be interpreted as semver at all. An affected entry with no ranges and no versions list is likewise read as `not_affected` rather than indeterminate. The file's own comment already admits the GIT case is "silently miscompared".

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-09"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-2, 2026-10-10): Fixed.** The normalizer keeps
`ranges[].type`, and the domain's `VersionRange` has an uninterpretable
member that says why a range cannot be compared. Only a `SEMVER` range is
ordered against an installed version; a `GIT` range (commit hashes), an
`ECOSYSTEM` range ("arbitrary, uninterpreted strings", OSV), a range of
another type or of none, an `affected` entry for the package with no
ranges and no versions, a SEMVER range with no `introduced` event (OSV:
"There must be at least one"), a bound that is not a SemVer version, and
two events of different kinds at one version (which OSV's
`sorted(range.events)` leaves unordered) are each uninterpretable, never
an empty range. `matchVersion` answers `indeterminate` for an empty list
and for an uninterpretable range that no other range or listed version
covers: an `UNKNOWN` finding with
`advisory_version_applicability_indeterminate` (category
`identity_unresolved`), never a `not_applicable` entry. A range that does
cover the version still decides `AFFECTED` (a GIT range beside a
`versions` list naming the installed version).

Measured on the base (`5ce993c`): the audit's GIT record
(`fixed: "3f2a9c1b0d"`, installed `5.0.0`) and its empty entry each give a
`not_applicable` entry; so do an `ECOSYSTEM` range and a range with no
type. After the fix, each is one `UNKNOWN` finding per exact instance.
The recorded OSV snapshot's `ECOSYSTEM` ranges all belong to `Maven` and
`RubyGems` entries, which the normalizer already ignores, so no corpus
verdict moves (`node scripts/differential.mjs`: 0 graph, 0 proof, 0
verdict changes over 139 cases). Owner: `VT-INV-B-version-applicability`.

---

