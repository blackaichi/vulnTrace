# B-3 — OSV cache

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: B-3
- **Branch**: b-3-osv-cache
- **Base SHA**: c90b96694b55bdda3930959bdbe3d4fc15d0d13b
- **Commits**:
  - `00efc30` docs(tasks): B-3 task file — OSV cache
  - `a56489c` test(B-3): OSV cache — AUD-06, AUD-07, PRM-35
  - `329c88c` fix(B-3): the OSV cache is the user's, validated, expiring, and never fatal
  - (this commit) docs(B-3): records — AUD-06, AUD-07, PRM-35 fixed, plan § 5a, debts, readme, architecture, backlog, progress, scorecard
- **Superseded by**: —

## Project context

Third task of lane B of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 15),
after [`B-2`](B-2-version-applicability.md) (PR #92, merged 2026-10-10).
It has no dependency.

The specification is REMEDIATION-PLAN § 7's B-3 row (files
`src/cache/osv-cache.ts`, `src/cli/scan.ts`; "decision 8; a cache write
failure is a diagnostic, never exit 4") and § 6.1 decision 8, accepted as
recommended: the cache moves out of the scanned tree (for example
`$XDG_CACHE_HOME`), every entry is validated against the provider schema,
and entries expire (default 24 hours, configurable).

Closes (`tests/validation/FINDINGS.md`): **AUD-06** (silent drop: no
expiry), **AUD-07** (silent drop: a cache inside the scanned tree is
trusted unvalidated) and **PRM-35** (scan abort: a cache write failure
exits 4). Sources: `docs/audits/2026-09-independent-audit.md` § 4 and
`docs/audits/2026-09-premise-sweep-round-1.md` § 4.

What binds B-3 from earlier tasks (REMEDIATION-PLAN § 5a, "What B-1
binds", "What B-2 binds"): the cache stores whole paginated answers; a
change to the stored answer's shape changes `CACHED_ANSWER_FORMAT`; an
advisory the provider returns ends in a finding or an
`unreportedCandidates` entry per exact instance. B-3 adds no proof, moves
no proof family and changes no verdict rule: it changes which answer the
scan reads (a live one instead of a stale, planted or malformed cached
one).

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

Code read at the base:

- **True** (AUD-07): `scan.ts` defaults the cache to
  `<projectRoot>/.vulntrace-cache/osv`. `FileOsvCacheStore.get` returns
  `JSON.parse(...) as RawVulnerability[]` with no shape check; its comment's
  premise ("its shape is entirely controlled by VulnTrace itself") is
  false, since the directory belongs to the scanned project. The key is
  `sha256` of public inputs (format marker, tool version, ecosystem, name,
  version), so a project can plant an entry under the exact key.
- **True** (AUD-06): an entry records no fetch time and nothing expires it.
- **True** (PRM-35): only `get` is guarded; `set` calls `mkdirSync` and
  `writeFileSync` unguarded, inside the provider call that `scan.ts` maps
  to "vulnerability provider failure" and exit 4.
- **True**: `Diagnostic.source` is a free string in both the type and
  `schemas/result.schema.json`, so a `cache` diagnostic needs no output
  schema change.
- **True**: every corpus suite (validation, both adversarial corpora, the
  Foundation corpus, the differential collector, the snapshot recorder)
  scans with `noCache: true`, so the corpus differential cannot reach the
  cache; B-3's behaviour is measured by its own tests.
- **Measured, not assumed, during the task**: that no test run writes to
  the user's real cache directory once the default moves there.

**Observation that shapes the fix.** Validation alone cannot close
AUD-07: a planted `[]` is a well-formed answer ("zero advisories") under
the provider schema. What closes it is that the scanned project cannot
write where the cache is read. So the location must hold even when
`XDG_CACHE_HOME` or the home directory lies inside the scanned project:
then the scan runs uncached, with a diagnostic.

## Task

### Problem

A stale, planted or malformed cache entry is served as the provider's
answer, and a cache write failure aborts the scan as a provider failure.

### Why it matters

Soundness. A served `[]` (stale or planted) is a silent drop: no finding,
no `unreportedCandidates` entry, no diagnostic, zero provider queries. A
wrong-shaped entry crashes or misleads the scan. PRM-35 is a wrong exit
code and a false diagnosis. Defect class B (the answer the analyzer
assumes is the provider's is not).

### What to do

1. **Tests first**, shown failing on the base:
   - end-to-end `runScanCommand`: an answer cached more than the TTL ago is
     re-queried and its new advisory found (AUD-06, fake clock); an
     answer planted at the base's default in-project location under the
     exact key is not read, and nothing is written into the project
     (AUD-07); a malformed entry under the exact key is a miss, re-queried
     (AUD-07); a cache directory that cannot be written leaves the exit
     code of the uncached scan and adds one `cache` diagnostic (PRM-35);
     a cache directory resolving inside the scanned project is refused,
     with a diagnostic;
   - unit tests of the store: the envelope, the TTL boundary, a future
     fetch time, a key or format mismatch, the provider schema, the
     atomic write; of the default location (XDG absolute, relative,
     unset; Windows); of the containment check (symlinked project).
2. **The fix**:
   - a stored entry is an envelope `{format, key, fetchedAt, vulns}`,
     strictly validated, `vulns` with the provider's own schema
     (exported from `osv-provider.ts`); anything else is a miss;
   - expiry: `vulnerabilities.cache.ttlHours` (positive, default 24); an
     entry older than that, or stamped in the future, is a miss;
   - `CACHED_ANSWER_FORMAT` changes (the stored shape changed);
   - the default directory is the user cache directory
     (`$XDG_CACHE_HOME` when absolute, else `%LOCALAPPDATA%` on Windows,
     else `~/.cache`) `/vulntrace/osv`; a directory resolving inside the
     scanned project is refused (the scan runs uncached, with a `cache`
     diagnostic); the same check applies to the test-only `cacheDir`;
   - a write failure is caught, reported once per scan as a `cache`
     diagnostic (and on stderr), never exit 4; writes are atomic
     (temporary file, then rename).
3. **Records**: FINDINGS (AUD-06, AUD-07, PRM-35 fixed; any new record),
   OPEN-DEBTS, REMEDIATION-PLAN § 5a "B-3 additions", README and
   ARCHITECTURE's cache sentences, backlog, progress, scorecard.

## Boundaries

### Do not touch

- Inventory (B-4), exit codes and output wording (B-5), the HTML report
  and README disclosure sentences AUD-16 names beyond the cache location
  this task moves (D-1), RWF-090's schema strictness (BL-059).
- `verdict.ts`, the normalizer, version matching, and every proof family.
- `tests/validation/` expected verdicts and the D-09 known failures.
- another task's worktree (`rwf-046-require-binding-authority`).

### STOP conditions

- A corpus verdict, proof or graph moves (the corpora run uncached).
- A fix that needs an output schema change or a seventh uncertainty
  category.
- A test run writes into the developer's real cache directory and cannot
  be isolated without changing a gate.

## Acceptance criteria

- [ ] AUD-06: an answer cached more than `ttlHours` ago is re-queried; on
      the base it is served forever.
- [ ] AUD-07: an entry planted in the scanned project is never read, and
      the scan writes nothing into the project; a cache directory inside
      the project is refused with a diagnostic; a malformed entry is a
      miss.
- [ ] PRM-35: a cache write failure gives the uncached scan's exit code
      plus one `cache` diagnostic; exit 4 on the base.
- [ ] Every stored entry is validated with the provider schema; the TTL
      is configurable and documented.
- [ ] No test run writes to the developer's real cache directory.
- [ ] Mutations each caught by a named test.
- [ ] The differential: 0 graph, 0 proof, 0 verdict; validation equals
      the D-09 baseline case by case.
- [ ] Records updated; scorecard regenerated; every gate green.
- [ ] Independent audit `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: no differential
(the corpora scan uncached); validation exactly the five D-09 known
failures (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`).

## Report

In the format of `AGENTS.md` § J.

## Corrections (appended during the task)

- **Choices § 7's row does not make**, each in the fail-closed direction:
  - with no absolute user cache directory the scan runs uncached;
  - a dangling link, or a project root that cannot be resolved, counts as
    "inside the project";
  - the scanned project's config cannot set the cache location;
  - after the audit (below), `ttlHours` is capped at its default, 24. The
    project's config may shorten the expiry, never lengthen it. A value
    above 24 is an invalid configuration (exit 2), not clamped. Decision 8
    says "configurable" without saying by whom: this is flagged for the
    project owner in the pull request.
- **A test changed, not weakened**: `src/cli/scan.integration.test.ts`
  scans uncached. It was the one test that wrote into the default cache,
  which is now the developer's own. Measured with a sentinel
  `XDG_CACHE_HOME` over `npm test` and every other gate: no file was
  written there.
- **A comment premise corrected**: `src/cli/scan-cache.test.ts` named the
  base's in-project default.
- **Foundation invariant** `VT-INV-B-cache-authority` was added, as B-1
  and B-2 did for lane B. Not named in § 7's row.
- **Independent audit: BLOCKED, then CERTIFIED.**
  - Finding 1 (blocking): `ttlHours: 1e308` passed `.finite()` in hours
    and became `Infinity` in milliseconds, so an entry never expired, and
    the scanned project sets it. Fixed by the cap and a constructor guard,
    with tests.
  - Finding 3: the cache path reached the JSON output; it is now on
    stderr only.
  - Finding 4: the example config omitted `%LOCALAPPDATA%`.
  - Re-audited `CERTIFIED`. Recorded, not changed (finding 2): on a
    case-insensitive mount under Linux, a cache directory the user points
    into the project with different letter case is not recognised as
    inside it.
- **Gates**: the first performance run failed both wall-clock guards
  (6214 ms of 5000, 20674 ms of 20000), while the audit's test runs loaded
  the machine. Run alone: 3280 ms, 11577 ms and 4073 ms, all passing; no
  threshold changed.
- **Acceptance criteria**, answered: every box above is yes. The
  differential moved nothing (0 graph, 0 proof, 0 verdict over 139
  cases): every corpus suite scans uncached. Validation equals the D-09
  baseline (`RWB-03`, `RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`, each
  with the same verdict on base and head).
