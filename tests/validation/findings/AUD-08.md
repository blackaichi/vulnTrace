| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| AUD-08 | `vuln-lib` (synthetic fixture), lockfile/disk mismatch | A package really loaded from disk but missing from `package-lock.json` is never queried or reported | silent drop — see below | **Fixed** (B-4) — see below |

## AUD-08 — A package really loaded from disk but missing from `package-lock.json` is never queried or reported

**Status:** Open
**Failure class:** silent drop
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** Critical
**Fix lane:** B — intake, cache, output

The dependency inventory is built from `package-lock.json` alone; a package present and required on disk but absent from the lockfile produces zero findings, zero `unreportedCandidates` and zero diagnostics, although Node loads and runs it. A nested on-disk-only copy shadowing a hoisted lockfile entry is silently skipped the same way while Node runs the nested one.

Full reproduction: `docs/audits/2026-09-independent-audit.md § 4, "AUD-08"`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task B-4, 2026-10-10): Fixed** (decision 9). The scan
cross-checks the installed tree against the inventory
(`src/dependencies/installed-tree.ts`): every directory under the
project's `node_modules`, and each workspace member's, recursively,
scoped packages included and links followed by realpath, plus every
package instance the module-load closure loads (which covers one Node
finds in an ancestor `node_modules`, outside the project). Each canonical
root no lockfile entry or workspace declaration names is an
`unreportedCandidates` entry, `package_identity`, `undetermined`, reason
`installed_package_not_in_lockfile` (a new subtype of
`identity_unresolved`), naming the exact instance and, when its manifest
says, the package. It is not made an instance: decision 9 records it, and
the registry stays metadata-driven. The walk is bounded (50,000
directory listings) and a truncated walk is reported
(`installed_tree_enumeration_truncated`, `budget_exceeded`). Reproduced end
to end, failing on the base (`src/cli/scan.b4-inventory-identity.test.ts`,
"B-4 / AUD-08"): both of the audit's cases (a hoisted package absent from
the lockfile; a nested on-disk-only copy that shadows a listed hoisted
one, real `node` running the nested copy), a nested twin with the listed
copy's own name and version (loaded, and not loaded), a scoped package,
and a package loaded from an ancestor `node_modules`. Foundation invariant
`VT-INV-B-inventory-identity`.

---

