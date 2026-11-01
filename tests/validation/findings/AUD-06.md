| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-06 | `vuln-lib` (synthetic fixture), cache | The OSV cache has no TTL or staleness signal, so an advisory published after the first scan is silently never seen | silent drop — see below | **Fixed** (B-3) — see below |

## AUD-06 — The OSV cache has no TTL or staleness signal, so an advisory published after the first scan is silently never seen

**Status:** Open
**Failure class:** silent drop
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** Critical
**Fix lane:** B — intake, cache, output

`osv-cache.ts` records no fetched-at timestamp and no TTL. Once a scan caches an empty provider response, every later scan reuses it forever with zero provider queries, no finding and no diagnostic — even after the provider starts returning a real advisory. `--no-cache` is the only escape.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-06"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-3, 2026-10-10): Fixed.** Every stored entry
records when the provider answered (`fetchedAt`), and `FileOsvCacheStore`
serves it only while it is younger than the TTL:
`vulnerabilities.cache.ttlHours`, default 24 (decision 8). An entry as old
as the TTL or older, and one stamped in the future, is a miss, and the
provider is asked again. Reproduced end to end, failing on the base
(`src/cli/scan.b3-osv-cache.test.ts`, "B-3 / AUD-06"): an answer cached
empty, then re-scanned 25 hours later after the provider started returning
an advisory, is now re-queried and the advisory is an `AFFECTED` finding;
on the base it was served forever. Foundation invariant
`VT-INV-B-cache-authority`.

---

