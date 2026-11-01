| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-14 | `vuln-lib` (synthetic fixture) | An OSV record's `withdrawn` field is not parsed; a withdrawn advisory is still analyzed | false AFFECTED — see below | **Fixed** (B-1) — see below |

## AUD-14 — An OSV record's `withdrawn` field is not parsed; a withdrawn advisory is still analyzed

**Status:** Open
**Failure class:** false AFFECTED
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** Low
**Fix lane:** B — intake, cache, output

The normalizer schema has no field for `withdrawn`; a record carrying `withdrawn: "2026-01-01…"` is analyzed exactly like a live advisory rather than being reported as an `unreportedCandidates` disposition.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-14"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-1, 2026-10-10): Fixed, by the project owner's
decision 10** (`docs/REMEDIATION-PLAN.md` § 6.1). The normalizer reads
`withdrawn` (OSV: "an RFC3339-formatted timestamp in UTC", the time the
entry "should be considered to have been withdrawn"). An advisory
withdrawn by the time of the scan is not analyzed: it is an
`unreportedCandidates` entry per exact instance with the new disposition
`withdrawn`, reason `advisory_withdrawn` and no category (the provider's
certain statement about the advisory, like `not_applicable`; never a
`NOT_AFFECTED`). Output schema `0.6` → `0.7`; the schema refuses a
`withdrawn` entry with a category, with another reason, or naming no
advisory. Three choices this task made where decision 10 is silent, each
in the fail-closed direction: a `withdrawn` time still in the future is
not yet a withdrawal (analyzed); a `withdrawn` the normalizer cannot read
makes the record unusable (`advisory_record_malformed`), neither
withdrawn nor live; a live copy of an id displaces a withdrawn copy.
Measured on the base (`a496141`), before the fix: a withdrawn advisory
whose target the application calls was `AFFECTED`; after the fix, no
finding and one `withdrawn` entry per instance; the not-withdrawn and
future-withdrawn controls stay `AFFECTED`
(`src/cli/scan.b1-provider-completeness.test.ts`).

---

