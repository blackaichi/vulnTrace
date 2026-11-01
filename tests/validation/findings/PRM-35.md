| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-35 | `vuln-lib` (synthetic fixture), cache | A cache-directory write failure (`ENOTDIR`) aborts the whole scan with exit 4 instead of degrading to a diagnostic | scan abort — see below | **Fixed** (B-3) — see below |

## PRM-35 — A cache-directory write failure (`ENOTDIR`) aborts the whole scan with exit 4 instead of degrading to a diagnostic

**Status:** Open
**Failure class:** scan abort
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** B — intake, cache, output

`osv-cache.ts`'s comment states that losing the cache "must never be able to abort an otherwise-successful scan", but only the read path (`get()`) is guarded; a `set()` failure propagates and the scan exits 4 with a vulnerability-provider-failure diagnosis, misdiagnosing a local filesystem problem as a provider failure.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 4, "PRM-35: cache write aborts the scan"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-3, 2026-10-10): Fixed.** `createCachingProvider`
catches a failed `set` and returns the provider's answer as it came; the
scan counts the failures and reports them once, as a `cache` diagnostic
(also on stderr), never exit 4. Writes are atomic (a temporary file, then
a rename). Reproduced end to end, failing on the base
(`src/cli/scan.b3-osv-cache.test.ts`, "B-3 / PRM-35"): a cache directory
under a regular file now gives the uncached scan's exit code (1, two
`AFFECTED` findings) and one diagnostic counting three answers; on the
base, exit 4 with "vulnerability provider failure ... ENOTDIR". A real
provider failure is still exit 4.

---

