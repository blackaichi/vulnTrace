| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-65 | `vuln-lib` (synthetic fixture), paginated OSV response | The real `OsvProvider` sends one request with no `page_token`, so a paginated OSV response's later pages are silently never seen | silent drop — see below | **Fixed** (B-1) — see below |

## PRM-65 — The real `OsvProvider` sends one request with no `page_token`, so a paginated OSV response's later pages are silently never seen

**Status:** Open
**Failure class:** silent drop
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** B — intake, cache, output

`OsvProvider` never follows `next_page_token`, so an advisory on a second results page is never fetched. Reproduced with a synthetic paginated response; depends on OSV emitting `next_page_token` for large result sets, which OSV documents.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-2.md § 5 ("PRM-65 FALSE")`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-1, 2026-10-10): Fixed, by the project owner's
decision 5** (`docs/REMEDIATION-PLAN.md` § 6.1). `OsvProvider` follows
`next_page_token`, repeating the query with a top-level `page_token`
until no token is returned, and returns every page; OSV's documentation
(`post-v1-query`, read 2026-10-09) confirms the protocol and that a page
may carry a token and no records. A failed page, a repeated token, a
token that is not a non-empty string, and an answer longer than the page
cap (100) fail the query as `OsvResponseError` -- exit 4, never a
shorter list. The OSV cache key gains an answer-format marker, so an
entry cached before the fix (a first page only, under the same tool
version, with no expiry until B-3) is never served again. Measured on
the base (`a496141`), before the fix: an advisory on page 2 gave no
finding; after the fix, `AFFECTED`, as the one-page control
(`src/cli/scan.b1-provider-completeness.test.ts`,
`src/vulnerabilities/osv-provider.pagination.test.ts`,
`src/cache/osv-cache.test.ts`). Owner:
`VT-INV-B-provider-completeness`.

---

