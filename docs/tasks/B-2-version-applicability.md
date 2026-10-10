# B-2 — Version applicability

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: B-2
- **Branch**: b-2-version-applicability
- **Base SHA**: 5ce993c076049a9fbe87c778479c230475f4e403
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Second task of lane B of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 14),
after [`B-1`](B-1-provider-completeness.md) (PR #91, merged 2026-10-10).
It has no dependency.

The specification is REMEDIATION-PLAN § 7's B-2 row: files
`src/vulnerabilities/version-matching.ts`, `osv-normalizer.ts`; "compare
SEMVER ranges with prerelease semantics, never `semver.coerce`; a
non-SEMVER range type (GIT, ECOSYSTEM) or an `affected` entry with no
ranges and no versions is `indeterminate`, never `not_applicable`".

Closes (`tests/validation/FINDINGS.md`): **AUD-05** (silent drop, and a
false finding the other way) and **AUD-09** (silent drop). Source:
`docs/audits/2026-09-independent-audit.md` § 4 and its recommendations
("Property-test version matching against uncoerced semver ... carry the
OSV range type into VersionRange").

What binds B-2 from earlier tasks (REMEDIATION-PLAN § 5a, "B-1
additions"): an advisory the provider returns ends in a finding or an
`unreportedCandidates` entry per exact instance. B-2 adds no proof and
moves no proof family; it changes which advisories are declared out of
range (`not_applicable`) and which are `indeterminate` (an `UNKNOWN`
finding, `advisory_version_applicability_indeterminate`, already
produced by `verdict.ts`).

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

Measured with the base's own `normalizeOsvVulnerability` and
`matchVersion`:

- **True**: `version-matching.ts` passes the installed version and every
  bound through `semver.coerce`. Installed `2.0.0-rc.1` against
  `fixed: 2.0.0` and against `fixed: 2.0.0-rc.2` is `not_affected`
  (a false `not_applicable`); `1.5.0-beta.3` against
  `last_affected: 1.5.0-beta.2` is `affected` (false). Ground truth: OSV's
  SEMVER type uses SemVer 2.0 § 11 precedence, under which
  `2.0.0-rc.1 < 2.0.0` (`semver.lt` is `true`).
- **True**: a `GIT` range `fixed: "3f2a9c1b0d"` gives `not_affected` for
  `5.0.0` (`semver.coerce("3f2a9c1b0d")` is `3.0.0`); an `affected` entry
  with no ranges and no versions normalizes to an empty list, and
  `matchVersion` answers `not_affected` for an empty list. The normalizer
  drops `ranges[].type` entirely; `ECOSYSTEM` and a missing type are
  compared as semver too.
- **New, measured** (not in the audit): the normalizer pairs OSV events
  in array order. OSV's specification (read 2026-10-10,
  `ossf.github.io/osv-schema`, "Evaluation") sorts `range.events` before
  walking them, and only recommends, never requires, a sorted array. The
  unsorted `[{introduced: 2.0.0}, {fixed: 1.0.0}]` gives `not_affected`
  for `2.5.0`; the specification's walk gives affected. A false
  `not_applicable`, in the same function and the same class as AUD-09:
  included here (WORKFLOW § 2, required for "compare SEMVER ranges"), and
  registered as a new RWF record.
- **True** (spec): "There must be at least one `introduced` object";
  `introduced: "0"` sorts before every version; a `limit` event narrows a
  range (and "may result in false negatives"); `last_affected` and
  `fixed` are not both allowed in one range.
- **True** (code read): `scan.ts` evaluates `matchVersion` per exact
  instance; `not_affected` is a `not_applicable` entry with no category;
  `indeterminate` reaches `buildFinding`, which returns an `UNKNOWN`
  finding with `advisory_version_applicability_indeterminate`. No output
  schema change is needed.
- **True** (data read): the recorded OSV snapshot
  (`tests/validation/osv-snapshot.json`) and the provider fixtures carry
  `SEMVER` ranges for every `npm` entry; their `ECOSYSTEM` ranges are all
  for `Maven` / `RubyGems` entries, which the normalizer already ignores.
  Four `npm` bounds are prereleases (`4.0.0-beta.3`, `4.0.0-beta.0`,
  `2.0.0-alpha`).

## Task

### Problem

Version applicability declares an advisory out of range for an installed
version that is inside it: prereleases are stripped (AUD-05), commit
hashes and uninterpreted ecosystem strings are read as semver, an entry
with no bounds reads as "no version affected" (AUD-09), and unsorted
events are paired in array order (new).

### Why it matters

Soundness. A false `not_applicable` is a silent drop: no finding, and an
entry that says the advisory does not apply. It is the critical failure
direction. The reverse (a false `affected`) is a precision defect.
Defect class B (correct binding, wrong value semantics: the version
compared is not the version installed).

### What to do

1. **Tests first**, shown failing on the base:
   - `version-matching` unit tests: prerelease precedence both ways; a
     bound or installed version that is not strict semver is
     `indeterminate`; an empty range list is `indeterminate`; an
     uninterpretable range is `indeterminate`, but an interpretable range
     that covers the version still answers `affected`;
   - normalizer unit tests: `GIT`, `ECOSYSTEM`, an unknown and a missing
     range type, an entry with no ranges and no versions, a range with no
     `introduced`, and ambiguous ties are uninterpretable; unsorted events
     follow the specification's sorted walk;
   - a sweep that compares normalize-then-match with a literal
     transcription of OSV's evaluation pseudo-code (`semver` precedence),
     over generated event lists (permutations included) and versions with
     prereleases: every decided answer equals the specification's, and a
     well-formed SEMVER range is always decided;
   - end-to-end `runScanCommand` tests through the real `OsvProvider`,
     loud fixtures (`vuln-lib` exports the `danger` every rule targets,
     and the app calls it): AUD-05's prerelease is a finding, AUD-09's
     GIT range and empty entry are `UNKNOWN` findings with the
     applicability reason, the unsorted range is a finding; the reverse
     prerelease case is `not_applicable`; per exact instance, with two
     instances of different versions.
2. **The fix**: strict `semver.parse` everywhere, never `semver.coerce`;
   `VersionRange` gains an uninterpretable member (the reason it cannot be
   compared); the normalizer keeps `ranges[].type`, evaluates SEMVER
   events by OSV's sorted walk into disjoint intervals, and marks every
   other shape uninterpretable; `matchVersion` answers `indeterminate` for
   an empty list or an uninterpretable range that nothing else decides.
3. **Foundation invariant** `VT-INV-B-version-applicability`.
4. **Records**: FINDINGS (AUD-05, AUD-09 fixed; the new record), OPEN-DEBTS,
   REMEDIATION-PLAN § 5a "B-2 additions", backlog, progress, scorecard.

## Boundaries

### Do not touch

- The cache (B-3), inventory (B-4), exit codes and output wording (B-5),
  the HTML sentence AUD-16 names (D-1), the schema strictness of RWF-090
  (BL-059).
- `verdict.ts` and every proof family.
- `tests/validation/` expected verdicts and the D-09 known failures.
- another task's worktree (`rwf-046-require-binding-authority`).

### STOP conditions

- A validation or adversarial case changes verdict in a direction that is
  not explained by the corrected applicability of its own advisory.
- A proof differential that is not zero.
- A fix that needs an output schema change or a seventh uncertainty
  category.

## Acceptance criteria

- [ ] AUD-05: installed `2.0.0-rc.1` against `fixed: 2.0.0` is a finding;
      `not_applicable` on the base. The reverse case is `not_applicable`;
      a finding on the base.
- [ ] AUD-09: a GIT range and an entry with no ranges and no versions are
      each an `UNKNOWN` finding with
      `advisory_version_applicability_indeterminate`; `not_applicable` on
      the base. ECOSYSTEM and a missing type likewise.
- [ ] Unsorted SEMVER events are evaluated as OSV specifies; the measured
      false `not_applicable` is a finding.
- [ ] `semver.coerce` appears nowhere in `src/`.
- [ ] The specification sweep: every decided answer equals OSV's
      pseudo-code; well-formed SEMVER ranges are always decided.
- [ ] `VT-INV-B-version-applicability` is registered with named owners.
- [ ] Mutations each caught by a named test, including a sibling borrow.
- [ ] The differential: 0 proofs moved; every moved verdict explained by
      its advisory's corrected applicability; validation equals the D-09
      baseline case by case.
- [ ] Records updated; scorecard regenerated; every gate green.
- [ ] Independent audit `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: no proof
differential; the four prerelease bounds in the snapshot may widen an
advisory's range, which can only add findings; validation exactly the five
D-09 known failures (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`).

## Report

In the format of `AGENTS.md` § J.
