# B-1 — Provider completeness

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: B-1
- **Branch**: b-1-provider-completeness
- **Base SHA**: a4961416f29b2984dbf6e4d8bfd1b7ce01a60259
- **Commits**:
  - `b226715` docs(tasks): B-1 task file — provider completeness
  - `945f9e8` test(B-1): provider completeness — PRM-65, AUD-10, AUD-11, AUD-14
  - `a1d0467` fix(B-1): every OSV advisory ends in a finding or an accounted entry
  - (this commit) docs(B-1): records — PRM-65, AUD-10, AUD-11, AUD-14 fixed, RWF-090, plan § 5a, debts, architecture, backlog, progress, scorecard
- **Superseded by**: —

## Project context

First task of lane B of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 13),
after [`C-1`](C-1-runtime-resolution-mode.md) (PR #90, merged
2026-10-09). It has no dependency; § 5 "Criticality" orders it here
because lane B's silent drops are critical failures under the contract.

The specification is REMEDIATION-PLAN § 7's B-1 row: files
`src/vulnerabilities/osv-provider.ts`, `osv-normalizer.ts`,
`src/cli/scan.ts`; "follow `page_token` (decision 5); a malformed or
id-less record becomes an `unreportedCandidates` entry (`undetermined`,
`analysis_precondition_unmet`) instead of a diagnostic or a failed report;
honour `withdrawn` (decision 10)". The project owner's decisions
(REMEDIATION-PLAN § 6.1): **5** — follow `page_token` until exhausted,
with a page cap that fails as a provider error; **10** — a new
`unreportedCandidates` disposition `withdrawn`, with an output schema
version bump.

Closes (`tests/validation/FINDINGS.md`): **PRM-65** (silent drop),
**AUD-10** (silent drop), **AUD-11** (scan abort), **AUD-14** (false
finding). Sources: `docs/audits/2026-09-premise-sweep-round-2.md` § 5
("PRM-65 FALSE"); `docs/audits/2026-09-independent-audit.md` § 4.

What binds B-1 from earlier tasks (REMEDIATION-PLAN § 5a): nothing on the
proof path. B-1 adds no proof and moves no proof family; it changes which
advisories reach the verdict layer and how the ones that cannot are
accounted.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **True** (code read): `OsvProvider.queryPackage` sends one
  `POST /v1/query` and returns `vulns`; its envelope schema does not read
  `next_page_token`, and no file under `src/` mentions `page_token`.
- **True** (OSV's documentation, `post-v1-query`, read 2026-10-09): a
  response with more results carries `next_page_token`; the next request
  repeats the query with a top-level `page_token`; the client continues
  "until the `next_page_token` is no longer included"; "in rare cases, the
  response might contain only the `next_page_token`" (no `vulns`).
- **True** (code read): `scan.ts` catches `normalizeOsvVulnerability`'s
  error and writes a diagnostic and a stderr line only; nothing reaches
  `unreportedCandidates`. The normalizer throws for two causes: a shape it
  does not accept (AUD-10's `introduced: 0`), and a record with no
  `affected` entry for the queried package (AUD-10's ecosystem `"NPM"`,
  the audit's "malformed **or unmatched**").
- **True** (code read; reproduced by this task's failing-first test):
  `OsvRecordSchema.id` is `z.string()` with no minimum; `result.schema.json`
  requires `findings[].vulnerability` to have `minLength: 1`, so one
  `id: ""` record fails output validation (exit 3) and the whole report is
  lost (AUD-11).
- **True** (code read): `OsvRecordSchema` has no `withdrawn`; zod strips
  it, and a withdrawn advisory is analyzed like a live one (AUD-14).
- **True** (OSV schema, read 2026-10-09): `withdrawn` is "an
  RFC3339-formatted timestamp in UTC (ending in "Z")" giving "the time the
  entry should be considered to have been withdrawn"; absent means not
  withdrawn; `id` is required.
- **Gap in scope** (code read): `createCachingProvider` caches
  `queryPackage`'s whole answer under a key of tool version and query
  only, with no expiry (AUD-06, B-3). A cache written before this fix may
  hold a first page only, and would keep serving it after the fix: the
  fix would not reach any user with a warm cache. Closing PRM-65 needs the
  cache key to distinguish a paginated answer from a pre-pagination one.
  Included here (WORKFLOW § 2, "required to complete the current task");
  B-3 keeps the cache's location, validation and expiry.

## Task

### Problem

Four ways an advisory OSV returned for an installed package never becomes
either a finding or an accounted no-finding entry:

1. **PRM-65.** Only the first page of a paginated answer is read; an
   advisory on page 2 is never seen.
2. **AUD-10.** A record the normalizer cannot use is a diagnostic only.
3. **AUD-11.** A record with an empty `id` normalizes, then fails output
   validation and discards the whole report, real `AFFECTED` findings
   included.
4. **AUD-14.** A withdrawn advisory is analyzed as a live one.

### Why it matters

Soundness: (1) and (2) are silent drops, a finding the contract requires
that never appears, and (3) loses every finding of the scan. (4) is a
false finding in the other direction (precision), decided by the owner as
an accounted disposition rather than a silent drop. None can produce a
`NOT_AFFECTED` verdict directly; each can make a scan's output read as
more complete than it is.

### What to do

1. **Tests first**, shown failing on the base:
   - provider unit tests with a paging `fetchImpl`: every page is
     followed, with `page_token` at the top level of the repeated query; a
     token-only page; the page cap and a repeated token fail as
     `OsvResponseError`; a non-string or empty token fails as one;
   - normalizer unit tests: an empty `id` is rejected; `withdrawn` is
     carried; a `withdrawn` that is not an RFC 3339 UTC timestamp is
     rejected;
   - end-to-end `runScanCommand` tests (the real `OsvProvider`, a stubbed
     `fetch`, loud fixtures exporting every name a rule binds): PRM-65's
     page-2 advisory is a finding; AUD-10's two shapes are
     `undetermined` / `analysis_precondition_unmet` entries per exact
     instance; AUD-11's empty id leaves the scan's real `AFFECTED`
     finding standing with exit 1, and the record accounted; AUD-14's
     withdrawn advisory is no finding and a `withdrawn` entry per
     instance, with the same record not withdrawn (control) and
     withdrawn in the future both `AFFECTED`;
   - the cache key distinguishes the paginated answer format.
2. **The fix**: pagination with a page cap in `osv-provider.ts`; `id`
   non-empty and `withdrawn` in `osv-normalizer.ts` and the
   `Vulnerability` domain type; in `scan.ts`, an unusable record becomes
   an `unreportedCandidates` entry per applicable instance (reason
   `advisory_record_malformed`, a subtype of `analysis_precondition_unmet`
   — no seventh category), a withdrawn advisory a `withdrawn` entry per
   instance (reason `advisory_withdrawn`, no category, like
   `not_applicable`); the cache key's format marker; the schema
   (`0.6` → `0.7`), the HTML report's disposition label.
3. **Foundation invariant** `VT-INV-B-provider-completeness`.
4. **Records**: FINDINGS (four entries fixed), OPEN-DEBTS, ARCHITECTURE
   § 6.2 (the disposition table), REMEDIATION-PLAN § 5a "B-1 additions",
   backlog, progress, scorecard.

## Boundaries

### Do not touch

- The cache's location, validation and expiry (B-3); exit codes and the
  `--cve` semantics beyond what a malformed record needs (B-5); version
  matching (B-2); inventory (B-4).
- `verdict.ts` and every proof family.
- `tests/validation/` expected verdicts and the D-09 known failures.
- another task's worktree (`rwf-046-require-binding-authority`).

### STOP conditions

- Any verdict moves in the differential (B-1 changes intake, not
  analysis; the recorded snapshot has no paginated, withdrawn or empty-id
  record).
- A validation case changes verdict.
- Honouring `withdrawn` would need a judgement the owner's decision 10
  does not make (for example a withdrawn advisory that a rule still
  names).

## Acceptance criteria

- [ ] PRM-65: an advisory on page 2 is a finding; no finding on the base.
- [ ] The provider fails as `OsvResponseError` past the page cap, on a
      repeated token and on a malformed token.
- [ ] AUD-10: a malformed and an unmatched record each give one
      `undetermined` entry per applicable instance, category
      `analysis_precondition_unmet`; none on the base.
- [ ] AUD-11: with one `id: ""` record, the scan exits 1 with its real
      `AFFECTED` finding, and the record is accounted; exit 3 on the base.
- [ ] AUD-14: a withdrawn advisory gives no finding and a `withdrawn`
      entry per instance with no category; `AFFECTED` on the base; the
      not-withdrawn and future-withdrawn controls stay `AFFECTED`.
- [ ] A pre-B-1 cache entry is never reused.
- [ ] Schema version `0.7`; the schema accepts the new disposition and
      reasons and still rejects a `withdrawn` entry with a category;
      additivity holds.
- [ ] `VT-INV-B-provider-completeness` is registered with named owners.
- [ ] The differential: 0 verdicts, 0 proofs moved; validation equals the
      D-09 baseline case by case.
- [ ] Records updated; scorecard regenerated; every gate green.
- [ ] Independent audit `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: no verdict or proof
differential; validation exactly the five D-09 known failures (`RWB-03`,
`RWB-05`, `RWB-09b`, `VAL-002`, `VAL-003`).

## Report

In the format of `AGENTS.md` § J.

## Corrections (appended during the task)

- **Choices decision 10 does not make**, each taken in the fail-closed
  direction and recorded in FINDINGS AUD-14's status update: a
  `withdrawn` time still in the future is not a withdrawal yet (the
  advisory is analyzed); a `withdrawn` the normalizer cannot read makes
  the record unusable (`advisory_record_malformed`), neither withdrawn
  nor live; a live copy of an id displaces a withdrawn copy. None of them
  is a STOP condition: none needs a judgement about a rule or a verdict.
- **`--cve` and unusable records** (code read): `--cve` filtered a usable
  advisory by its id and aliases; an unusable record has none it can be
  trusted for. Taken: filtered out only when both are readable and
  neither names the filter. B-5 keeps the rest of `--cve`.
- **The acceptance criterion "still rejects a `withdrawn` entry with a
  category"** assumed the schema enforced "category if and only if
  undetermined". It does not, for any disposition (measured with the
  production schema and Ajv): registered as RWF-090 (`BL-059`). B-1
  enforces it for `withdrawn`, which no earlier result could carry, so
  the change stays additive.
- **The SOUNDNESS-CONTRACT examples** carry the schema version; they are
  compared byte for byte with fresh scans (`src/testing/docs-contract.test.ts`),
  so `0.6` → `0.7` there too.
- **Backlog § 2** lacked rows for C-1's RWF-085, RWF-086 and RWF-089
  (the table asks the registering task to add them); added by B-1.
- **Independent audit: CERTIFIED**, with non-blocking findings fixed on
  the branch (a `null` record crashing the identity reader; tests for a
  later page's failure and for cross-query de-duplication; the
  invariant's "exactly one" wording) and notes recorded in
  REMEDIATION-PLAN § 5a, "B-1 additions". The full verdict is in the pull
  request.
- **Acceptance criteria**, answered: every box above is yes. The
  `withdrawn`-with-a-category criterion holds for `withdrawn`; the same
  rule for the other dispositions is RWF-090.
