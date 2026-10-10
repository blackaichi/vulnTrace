# B-4 — Inventory and identity drops

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: B-4
- **Branch**: b-4-inventory-identity-drops
- **Base SHA**: cfa6565fcd8d4a697f940a7a7c9f03075c9e5822
- **Commits**:
  - `4ac45f1` docs(tasks): B-4 task file — inventory and identity drops
  - `ec132eb` test(B-4): inventory and identity drops — PRM-34, PRM-64, PRM-66, AUD-08
  - `b74bded` fix(B-4): every installed package reaches the report — instance or identity entry
  - (this commit) docs(B-4): records — PRM-34, PRM-64, PRM-66, AUD-08 fixed, RWF-093, BL-060, plan § 5a, debts, architecture, backlog, progress, scorecard
- **Superseded by**: —

## Project context

Fourth task of lane B of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 16),
after [`B-3`](B-3-osv-cache.md) (PR #93, merged 2026-10-10). It has no
dependency.

The specification is REMEDIATION-PLAN § 7's B-4 row (files
`src/dependencies/dependency-graph.ts`, `package-lock.ts`,
`package-instances.ts`, `workspaces.ts`, `src/cli/scan.ts`): "a nameless
non-`node_modules` lock entry takes its name from the linking
`node_modules/<name>` entry or its own manifest, and otherwise becomes an
identity `unreportedCandidates` entry instead of `continue`; decision 4; a
malformed workspace manifest is recorded even when versionless; decision
9". § 6.1 decisions, both accepted as recommended:

- **4 (PRM-64)**: query OSV without a version for a versionless instance,
  and evaluate every advisory for the name against it (all `UNKNOWN` with
  `installed_version_unavailable`).
- **9 (AUD-08)**: cross-check the installed tree against the lockfile; an
  on-disk package the lockfile does not list becomes an
  `unreportedCandidates` entry.

Closes (`tests/validation/FINDINGS.md`), all silent drops:
**PRM-34**, **PRM-64**, **PRM-66** and **AUD-08**. Sources:
`docs/audits/2026-09-premise-sweep-round-1.md` § 4 and § 6 (PRM-34),
`docs/audits/2026-09-premise-sweep-round-2.md` (PRM-64, PRM-66),
`docs/audits/2026-09-independent-audit.md` § 4 (AUD-08).

What binds B-4 from earlier tasks (REMEDIATION-PLAN § 5a, "What B-1
binds", "What B-2 binds", "What B-3 binds"): every advisory the provider
returns ends in a finding or an `unreportedCandidates` entry per exact
instance; applicability is decided only by `matchVersion`; a cached answer
is served only by `FileOsvCacheStore.get`. B-4 adds no proof family,
moves no proof family and changes no verdict rule. It changes **which
instances exist** and **which advisories are asked for**.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **True** (PRM-34): `buildDependencyGraph` takes
  `entry.name ?? derivePackageName(entryPath)` and `continue`s when either
  the name or the version is missing. `derivePackageName` returns
  `undefined` for a path outside `node_modules`, and its comment claims
  that "npm always writes an explicit `name` for those". **False,
  measured with real npm 10.9.0 in this task**: `file:vendor/lodash`
  produces `"vendor/lodash": { "version": "4.17.20" }` with no `name`, and
  `"node_modules/lodash": { "resolved": "vendor/lodash", "link": true }`.
  npm omits `name` exactly when the directory's basename equals the
  manifest's name: `file:vendor/lod` (manifest `lodash`) gets
  `"name": "lodash"`.
- **True, and wider than PRM-34** (measured, same npm): a `file:`
  dependency whose manifest has no `version` gets
  `"vendor/nover": { "name": "nv" }` — named, versionless — and the same
  `continue` drops it. It is not a workspace member, so workspace discovery
  never names it either: no instance, no query, no entry. The B-4 fix
  covers it (a versionless lock entry is an instance with no version).
- **True** (PRM-64): `advisoryQueryVersions` contributes no query for an
  instance with no version. The instance is evaluated only against the
  advisories its siblings' versioned queries returned. OSV filters a
  versioned query by version, so an advisory that affects no sibling
  version is never seen. The comment's premise ("evaluated against
  whatever the siblings' queries return … instead of silently disappearing")
  is false for those advisories.
- **True** (PRM-66): `readManifestIdentity` (`workspaces.ts`) returns
  `{ exists: false }` for a manifest that exists and does not parse, so
  the member is skipped as "not a package". With a versioned lock entry
  the dependency graph still names the root and the registry records
  `installed_manifest_untrusted`. With a versionless lock entry nothing
  names it.
- **True** (AUD-08): the instance registry is built from the lockfile and
  the `workspaces` declaration only. The module-load closure's
  `loadedPackageInstances` is never reconciled against it, and nothing
  looks at `node_modules` on disk.
- **True**: the provider (`OsvProvider`, the cache key, the snapshot
  replay `SnapshotOsvProvider`) already accepts a query with no version.
  The snapshot replay throws on a key it has not recorded.
- **True**: a new `unreportedCandidates` reason is a subtype within an
  existing category. Earlier tasks added theirs to the schema's `reason`
  enum without a schema version bump (A-3b, B-1).

## Task

### Problem

Four ways a package that is really installed, and possibly loaded, reaches
no finding and no `unreportedCandidates` entry:

1. a nameless lock entry outside `node_modules` (`file:` dependency) is
   dropped, and so is any versionless lock entry (PRM-34);
2. a versionless instance is never asked about by its own name, only
   through its siblings' version-filtered answers (PRM-64);
3. a workspace member whose manifest does not parse is dropped when its
   lock entry is versionless (PRM-66);
4. a package on disk that the lockfile does not list is never queried and
   never reported (AUD-08).

### Why it matters

Soundness: each is a silent drop, the critical failure class next to a
false `NOT_AFFECTED`. A reader sees a clean report about a package the scan
never considered. Defect classes: A for PRM-34 (identity never
established), C for PRM-64 (a versionless instance's advisory set
collapsed onto its siblings').

### What to do

1. **Tests first**, shown failing on the base, end to end through
   `runScanCommand` with loud fixtures (every export the cases bind):
   - PRM-34: the real npm 10.9.0 lockfile shape. The vendored package is
     queried, gets a finding, and its root is a known package root. Also
     the named versionless `file:` shape; the shape where no authority
     names the entry (an identity entry).
   - PRM-64: the round-2 audit's synthetic provider (filters by version,
     returns everything without one). The versionless member gets an
     `UNKNOWN` (`advisory_version_applicability_indeterminate`) for the
     advisory no sibling version returns.
   - PRM-66: versionless lock entry plus malformed manifest: one
     `installed_manifest_untrusted` entry. A malformed workspace manifest
     no lock entry names is recorded too.
   - AUD-08: both of the audit's cases (a hoisted package missing from the
     lockfile; a nested on-disk-only copy beside a listed hoisted one), each
     an `unreportedCandidates` entry naming the exact on-disk instance; a
     package the closure loads from outside the project that the lockfile
     does not list.
   - Unit tests for the graph, the walk's bounds and links, and the query
     set.
2. **The fix**:
   - `buildDependencyGraph`: a versionless lock entry becomes a node with
     no version (`DependencyNode.version` optional), never `continue`. A
     versionless `link: true` entry is not itself a package (its target
     entry is) and stays out. A nameless entry outside `node_modules` is
     named by its own manifest, else by the one name its linking
     `node_modules/<name>` entries agree on. Otherwise it is reported as an
     identity `unreportedCandidates` entry. Correct `derivePackageName`'s
     comment.
   - Decision 4: a name with any versionless instance is also queried
     without a version, and every advisory returned is evaluated against
     every instance of the name, as sibling answers already are.
   - PRM-66: workspace discovery tells a missing manifest from one that
     does not parse. The latter is recorded, and the scan reports it when
     nothing else names the root.
   - Decision 9: the scan enumerates the installed tree (the project's and
     each workspace member's `node_modules`, recursively, scoped packages
     included, links followed by realpath, bounded and reported when
     truncated) and the closure's loaded instances. Every canonical root
     not in the registry is an `unreportedCandidates` entry. It is not an
     instance: decision 9 records it, and the registry stays
     metadata-driven.
3. **Records**: FINDINGS (PRM-34, PRM-64, PRM-66, AUD-08 fixed; any new
   record), OPEN-DEBTS, REMEDIATION-PLAN § 5a "B-4 additions", schema
   enum, ARCHITECTURE's reason table if it lists reasons, backlog,
   progress, scorecard.

## Boundaries

### Do not touch

- Exit codes and output wording beyond the new entries (B-5), disclosure
  (D-1), RWF-090's schema strictness (BL-059).
- `verdict.ts`'s proof families, the normalizer, version matching, the
  cache.
- `tests/validation/` expected verdicts and the D-09 known failures.
- another task's worktree (`rwf-046-require-binding-authority`).

### STOP conditions

- A corpus verdict or proof moves in a way not explained by an instance
  that newly exists or an advisory newly asked for.
- A fix needs a seventh uncertainty category or an output schema version
  change.
- The snapshot replay has no answer for a newly made unversioned query
  and cannot be re-recorded (no network): report it, do not fake an
  answer.

## Acceptance criteria

- [ ] PRM-34: the real npm lockfile's nameless `file:` entry is an
      instance, queried and found; a versionless lock entry is an instance;
      an entry no authority names is an identity entry. On the base each is
      dropped.
- [ ] PRM-64: a versionless instance is queried without a version and
      evaluated against every advisory returned.
- [ ] PRM-66: a malformed manifest under a versionless lock entry, or
      under a workspace pattern alone, is recorded.
- [ ] AUD-08: an on-disk package the lockfile does not list, hoisted or
      nested, and a loaded instance outside the registry, are each an
      `unreportedCandidates` entry naming the exact instance; a truncated
      walk is reported.
- [ ] No new category; any new reason is a subtype, classified and in the
      schema enum.
- [ ] Mutations each caught by a named test, the `PackageInstance` one as
      a sibling borrow.
- [ ] Differentials reported (graph, proof, verdict); every moved line
      explained; validation equals the D-09 baseline case by case.
- [ ] Records updated; scorecard regenerated; every gate green.
- [ ] Independent audit `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: corpus movement only
where an instance newly exists or an advisory is newly asked for;
validation exactly the five D-09 known failures (`RWB-03`, `RWB-05`,
`RWB-09b`, `VAL-002`, `VAL-003`).

## Report

In the format of `AGENTS.md` § J.

## Corrections (appended during the task)

- **A premise in this file is false** (the independent audit, finding 3,
  re-measured with npm 10.9.0): npm does not omit `name` "exactly when the
  directory's basename equals the manifest's name". It omits it when the
  manifest's name agrees with the name the package is linked under, or
  the manifest has none (`vendor/y` linked as `y`, manifest `y`: no name;
  `vendor/z` linked as `bar`, no manifest name: no name; `vendor/x` linked
  as `foo`, manifest `x`: `"name": "x"`). The code's naming order
  (manifest name, else the one linking name) was right for every shape;
  the comments and the FINDINGS update now state the measured rule.
- **That correction was itself incomplete** (the re-audit): `vendor/lod`
  linked as `lodash`, manifest `lodash` — this file's own first
  measurement — gets `"name": "lodash"`. The rule that fits all six
  measured shapes: npm omits `name` when the manifest has none, or when
  the manifest's name, the directory's name and the link name all agree.
  The comments and the FINDINGS update state that rule; the code does not
  depend on it.
- **Scope of decision 4, read as the code defines "versionless"**: every
  registry instance whose version is `undefined` is queried without one —
  none declared, a contradiction (`installed_version_conflicted`) or an
  untrusted installed manifest (`installed_manifest_untrusted`). F1-B § 22
  and P1-A5 G/H had chosen "no query" for the last two; that silently
  hid every advisory whose range covers the installed (contradicted)
  version (F1-B's own Case B). Flagged for the project owner in the pull
  request.
- **Existing tests changed, not weakened** (each pinned "no query" or a
  limitation B-4 closes): `scan.f3-no-finding.test.ts` (F3 § 4: one test
  split in two, the versionless query and the no-advisory entry),
  `scan.metadata-uncertainty.test.ts` (F1-B: seven "no query" assertions
  now assert one versionless query and an `UNKNOWN`; § 17's pinned
  limitation now asserts `AFFECTED`), `scan.multi-instance.test.ts` (G/H),
  `package-instances.test.ts` (the pinned `[]`),
  `verdict.workspaces.integration.test.ts` (the "no identity" baseline is
  now modelled explicitly with the pre-B-4 graph, and the lockfile-only
  identity is asserted), `foundation-differential.test.ts`
  (`candidate-manifest-untrusted` now has a finding; a version-indeterminate
  `UNKNOWN` names no target, backlog `BL-060`), and two exact-shape
  workspace tests (the new `unreadableManifestRoots` field).
- **PRM-36 overlap**: the `installed_version_unavailable` detail had to
  change (it said no sibling query found an advisory; the instance is now
  queried itself). It now names a `--cve` filter when one is set. PRM-36's
  prescribed fix (compute the condition from the unfiltered set) is still
  B-5's; PRM-36 is not marked fixed.
- **Choices § 7's row does not make**, each in the fail-closed direction: a
  nameless entry is named by its manifest before its linking entry (the
  identity authority, as for an alias); two disagreeing linking names with
  no manifest name are not chosen between; an unlisted installed package is
  reported, never made an instance (decision 9's wording); the walk does
  not descend into a checkout linked from outside the project (the
  closure's cross-check covers what is loaded from there); the truncation
  and unreadable entries use stage `workspace_discovery` (an unknown
  number of candidates, no package named), avoiding a schema change.
- **Independent audit: CERTIFIED**, four non-blocking findings. Fixed: a
  read error was read as an empty directory (now
  `installed_tree_unreadable`, `analysis_precondition_unmet`); the walk's
  cost was bounded by listings only (every examined entry now counts,
  structural tests); the walk's comment overclaimed what Node loads
  (corrected); the npm naming rule was stated falsely (corrected twice, see
  above). Recorded as a known limitation (finding 4): a nameless `file:`
  package whose manifest has no name is named by its link, as npm does, so
  a registry advisory of that name selects it (an extra finding, never a
  hidden one). The delta was re-audited: CERTIFIED.
- **Acceptance criteria**, answered: every box is yes. Nineteen mutations,
  each caught by a named test (M10 first survived: its sibling-borrow
  test's twin was also loaded, so the closure reported it; an unloaded twin
  test was added). The differential moved nothing (0 graph, 0 proof, 0
  verdict, unreported +0/−0 over 139 cases); validation equals the D-09
  baseline (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`, each with
  the same verdict on base and head).
