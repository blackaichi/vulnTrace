| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-11 | `vuln-lib` (synthetic fixture) | A single OSV record with an empty `id` string fails schema validation and discards the whole report | scan abort — see below | **Fixed** (B-1) — see below |

## AUD-11 — A single OSV record with an empty `id` string fails schema validation and discards the whole report

**Status:** Open
**Failure class:** scan abort
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** Medium
**Fix lane:** B — intake, cache, output

The normalizer accepts `id: z.string()` without `.min(1)`. One record with `id: ""`, even for an unrelated package, fails `result.schema.json` validation at output time: exit 3, and the entire report — including real AFFECTED findings for other packages — is lost rather than that one record being skipped.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-11"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-1, 2026-10-10): Fixed.** The normalizer requires
a non-empty `id`, so a record with `id: ""` is refused there and
accounted as one unusable record (AUD-10's channel, reason
`advisory_record_malformed`, with no `vulnerability` field, since there
is no usable id to name); it never reaches a finding. Measured on the
base (`a496141`), before the fix: a real `AFFECTED` finding plus one
`id: ""` record gave exit 3 and no report; after the fix, exit 1, the
`AFFECTED` finding, and the record accounted
(`src/cli/scan.b1-provider-completeness.test.ts`). The output schema's
only advisory-derived field with a length constraint is the id
(`findings[].vulnerability`, `unreportedCandidates[].vulnerability`);
both are now produced only from a non-empty id.

---

