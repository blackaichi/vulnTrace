| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-05 | `vuln-lib` (synthetic fixture), prerelease version | `semver.coerce` strips prereleases, dropping a vulnerable installed prerelease and falsely flagging an unaffected one | silent drop (recorded as a false "not applicable"); also false AFFECTED in the reverse direction — see below | **Fixed** (B-2) — see below |

## AUD-05 — `semver.coerce` strips prereleases, dropping a vulnerable installed prerelease and falsely flagging an unaffected one

**Status:** Open
**Failure class:** silent drop (recorded as a false "not applicable"); also false AFFECTED in the reverse direction
**Defect class:** B
**Proof family affected:** not applicable
**Severity:** Critical
**Fix lane:** B — intake, cache, output

`version-matching.ts` coerces both the installed version and every advisory bound through `semver.coerce` before comparing, which strips prerelease identifiers. An installed `2.0.0-rc.1` against a `fixed: 2.0.0` advisory is reported `not_applicable` (dropped) although `semver.lt('2.0.0-rc.1','2.0.0')` is true under OSV's own SEMVER precedence; the reverse direction (`1.5.0-beta.3` outside a `1.5.0-beta.1`..`1.5.0-beta.2` range) gives a false AFFECTED. No test exercises a prerelease.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-05"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-2, 2026-10-10): Fixed.** `version-matching.ts`
and `osv-normalizer.ts` parse the installed version and every bound as
strict SemVer (`semver.parse`) and compare by SemVer precedence,
prereleases included and build metadata ignored; no production file
names `coerce` (an AST census in
`src/vulnerabilities/version-applicability.b2.test.ts`). A value that is
not a SemVer version (`1.2`, `latest`, a commit hash) is `indeterminate`
-- an `UNKNOWN` finding with `advisory_version_applicability_indeterminate`
-- never coerced into one.

Measured on the base (`5ce993c`), through the production
`normalizeOsvVulnerability` and `matchVersion` and end to end through
the real `OsvProvider` (`src/cli/scan.b2-version-applicability.test.ts`):
installed `2.0.0-rc.1` against `fixed: 2.0.0` and against
`fixed: 2.0.0-rc.2` is a `not_applicable` entry; after the fix, an
`AFFECTED` finding. `1.5.0-beta.3` against `last_affected: 1.5.0-beta.2`
is `AFFECTED` on the base and `not_applicable` after. Precision added to
this record (AGENTS.md § C): the audit's second reverse case is damaged
in the source; measured here, `1.5.0-beta.3` against
`introduced: 1.5.0-beta.1, fixed: 1.5.0-beta.2` is `not_applicable` on
the base too (both bounds coerce to `1.5.0`, and so does the installed
version), so it is right on the base for the wrong reason, and stays right
after. A `versions` list entry `2.0.0-rc.1` matched an installed `2.0.0`
on the base (false `AFFECTED`); it matches only `2.0.0-rc.1` now. Owner:
`VT-INV-B-version-applicability`.

Found by B-2's independent audit (finding 1) and fixed in the same
task: node-semver keeps a numeric prerelease identifier at or above
`Number.MAX_SAFE_INTEGER` as a string and compares it as a JavaScript
number, so `1.0.0-9007199254740992` and `1.0.0-9007199254740993` compare
equal (SemVer precedence orders them). B-2's first fix answered
`not_affected` for the first against `fixed` the second; the shared
`parseSemVer` (`version-matching.ts`) now refuses such a value, so it is
`indeterminate`. The base (`5ce993c`) gave the same false
`not_affected`, through `semver.coerce`.

---

