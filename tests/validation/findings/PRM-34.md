| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-34 | `lodash` (`file:`-vendored, real npm 10.9.0 lockfile) | A `file:`-vendored dependency whose real npm lockfile entry has no `name` is silently dropped entirely | silent drop — see below | **Fixed** (B-4) — see below |

## PRM-34 — A `file:`-vendored dependency whose real npm lockfile entry has no `name` is silently dropped entirely

**Status:** Open
**Failure class:** silent drop
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** B — intake, cache, output

For a `package.json` dependency declared as `file:vendor/lodash`, real npm 10.9.0 writes a lockfile entry (`vendor/lodash`) with no `name` field, plus a `node_modules/lodash` link entry. `package-lock.ts`'s comment assumes npm "always writes an explicit name" for such entries; when it does not, a `continue` branch drops the package from the registry entirely — no finding, no `unreportedCandidates` entry, exit 0 — although Node loads and runs the vulnerable code. Reproduced against a real npm-generated lockfile, not a synthetic one.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-1.md § 4, "PRM-34: silent drop (real npm lockfile)"`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task B-4, 2026-10-10): Fixed.** `buildDependencyInventory`
(`src/dependencies/dependency-graph.ts`) no longer drops an entry that is a
package. A nameless entry outside `node_modules` is named by its own
manifest, else by the one name its linking `node_modules/<name>` entries
agree on; one nothing names (or two disagreeing linking names with no
manifest name) is an `unreportedCandidates` entry, reason
`lockfile_entry_unidentified` (a new subtype of `identity_unresolved`),
never `continue`. A versionless `link: true` entry is still not a package
(its target is). The comment premise is corrected: measured with real npm
10.9.0 in this task (six shapes), npm omits `name` when the manifest
declares none, or when the manifest's name, the directory's name and the
name the package is linked under all agree (`file:vendor/lodash` linked as
`lodash`, manifest `lodash`); it writes it otherwise (`vendor/lod` linked
as `lodash`, manifest `lodash`: `"name": "lodash"`; `vendor/x` linked as
`foo`, manifest `x`: `"name": "x"`). So this is the ordinary `file:`
dependency. (Two earlier drafts of this rule were each measured false by
B-4's independent audit, finding 3 and its re-audit.) Reproduced end to end with the real lockfile shape, failing on
the base (`src/cli/scan.b4-inventory-identity.test.ts`, "B-4 / PRM-34"):
the vendored package is now queried at `4.17.20` and is an `AFFECTED`
finding on `vendor/lodash`, with real `node` running it; on the base, no
query and no finding. See also RWF-093, the versionless half.

---

