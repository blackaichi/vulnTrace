| ID | Package | Root cause | Impact | Status |
|---|---|---|---|---|
| PRM-66 | `bad` (synthetic workspace fixture) | A workspace member with a malformed manifest is silently skipped only when its lockfile entry is versionless | silent drop (versionless lock entry only) — see below | **Fixed** (B-4) — see below |

## PRM-66 — A workspace member with a malformed manifest is silently skipped only when its lockfile entry is versionless

**Status:** Open
**Failure class:** silent drop (versionless lock entry only)
**Defect class:** not classified in the report
**Proof family affected:** not applicable
**Severity:** not rated in the report (report verdict: `CRITICAL_FINDINGS`)
**Fix lane:** B — intake, cache, output

For a versioned lockfile entry, a malformed workspace manifest is correctly recorded as `installed_manifest_untrusted`. For a versionless entry, the same malformed manifest instead gives `findings: []` and `unreportedCandidates: []` with no record at all. Node itself refuses to load the package (`ERR_INVALID_PACKAGE_CONFIG`), so there is no runtime exposure — but the silent-drop contract is still violated for the versionless case.

Full reproduction: `docs/audits/2026-09-premise-sweep-round-2.md § 5 ("PRM-66 FALSE only for a versionless lock entry")`. Not fixed here; this section records the finding only, per this task's boundaries.


**Status update (task B-4, 2026-10-10): Fixed.** Two mechanisms. The
versionless lock entry is now a dependency-graph node (PRM-34's fix, named
by its linking `node_modules/bad` entry), so the registry reads its
manifest and records `installed_manifest_untrusted`, as it already did
for a versioned entry; the instance is then queried without a version
(PRM-64). And workspace discovery no longer reads a manifest that exists
and cannot be parsed as "no manifest" (`readManifestIdentity` in
`workspaces.ts` now uses the registry's own reader): a member nothing else
names is reported as `installed_manifest_untrusted` by its instance.
Reproduced end to end, failing on the base
(`src/cli/scan.b4-inventory-identity.test.ts`, "B-4 / PRM-66"), both lock
variants and the pattern-only case, with a directory that has no
`package.json` at all as the control.

---

