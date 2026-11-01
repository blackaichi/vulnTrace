| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-10 | `vuln-lib` (synthetic fixture) | A malformed OSV record is dropped to diagnostics only, with no `unreportedCandidates` entry | silent drop (product/observability) — see below | **Fixed** (B-1) — see below |

## AUD-10 — A malformed OSV record is dropped to diagnostics only, with no `unreportedCandidates` entry

**Status:** Open
**Failure class:** silent drop (product/observability)
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** Medium
**Fix lane:** B — intake, cache, output

`normalizeOsvVulnerability`'s catch logs "skipping malformed vulnerability record" to diagnostics and the scan exits 0, but nothing is recorded in `unreportedCandidates` — the one channel that exists to account for a candidate that produced no finding.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-10"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-1, 2026-10-10): Fixed.** A record the
normalizer cannot use is now an `unreportedCandidates` entry for every
exact instance of the queried name: stage `advisory_applicability`,
disposition `undetermined`, reason `advisory_record_malformed` (a new
subtype of `analysis_precondition_unmet`, not a new category), naming
the record's id when one can be read. The diagnostic and the stderr line
are kept, with the same facts. Under `--cve`, such a record is filtered
out only when its id and aliases can both be read and neither names the
filter; one whose identity cannot be read may be the advisory asked for,
and is accounted.

Measured on the base (`a496141`), before the fix
(`src/cli/scan.b1-provider-completeness.test.ts`, through the real
`OsvProvider`): both of the audit's shapes -- `introduced: 0` (a
number) and ecosystem `"NPM"` -- give no entry; after the fix, one
`undetermined` entry each, per instance. Precision added to this record
(AGENTS.md § C): the audit's own summary says "a malformed **or
unmatched** OSV record"; the record above names only the first. Both
reach the same `catch`, and both are fixed. Owner:
`VT-INV-B-provider-completeness`.

---

