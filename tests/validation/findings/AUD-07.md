| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-07 | `vuln-lib` (synthetic fixture), cache | The default OSV cache directory lives inside the scanned project's own tree, and its contents are trusted unvalidated | silent drop — see below | **Fixed** (B-3) — see below |

## AUD-07 — The default OSV cache directory lives inside the scanned project's own tree, and its contents are trusted unvalidated

**Status:** Open
**Failure class:** silent drop
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** Critical
**Fix lane:** B — intake, cache, output

The cache defaults to `<projectRoot>/.vulntrace-cache/osv`, and its comment's premise that "its shape is entirely controlled by VulnTrace itself" is false — the directory belongs to the target project being scanned, not to VulnTrace. A committed empty-array cache file suppresses every advisory for that key with zero provider queries; a truncated file is treated as a miss, but a wrong-shaped one (`{}`, `5`, `true`) throws.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-07"`. Not fixed here; this section records the finding only, per this task's boundaries.

**Status update (task B-3, 2026-10-10): Fixed.** Validation alone
could not close this: a planted `[]` is a well-formed answer ("no
advisories") under the provider's schema. What closes it is the location.
The default cache directory is the user's (`XDG_CACHE_HOME` when it is
absolute, else `LOCALAPPDATA` on Windows, else `~/.cache`, then
`vulntrace/osv`; `src/cache/cache-location.ts`), and a directory that is,
or resolves through a symlink to, a place inside the scanned project is
refused: the scan runs uncached, with a `cache` diagnostic. The scanned
project's config cannot set the location. Every entry is a strict envelope
(`format`, `key`, `fetchedAt`, `vulns`), `vulns` validated with the
provider's own schema (`OsvVulnerabilityListSchema`); a wrong shape, an
entry written under another key and the pre-B-3 bare array are misses,
never served and never fatal. The comment premise this section quotes is
gone. Reproduced end to end, failing on the base
(`src/cli/scan.b3-osv-cache.test.ts`, "B-3 / AUD-07"): an empty answer
planted at the base's default location under the exact key is no longer
read, and the scan writes nothing into the project; a cache directory
inside the project, by `XDG_CACHE_HOME`, a symlink or `cacheDir`, is
refused; `5`, `{}`, `[5]`, a bare array and an envelope without a fetch
time are misses (on the base, `5` crashed the scan and the others were
served). Foundation invariant `VT-INV-B-cache-authority`.

---

