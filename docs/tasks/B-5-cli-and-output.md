# B-5 — CLI and output

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: B-5
- **Branch**: b-5-cli-and-output
- **Base SHA**: 5d41db897642c5b87446ae816a2905d2e8548d3f
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

Fifth task of lane B of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 17),
after [`B-4`](B-4-inventory-identity-drops.md) (PR #94, merged
2026-10-11). It has no dependency.

The specification is REMEDIATION-PLAN § 7's B-5 row (files
`src/cli/run.ts`, `scan.ts`, `html-report.ts`), which carries § 6.1
**decision 3** (decided 2026-09-26) verbatim:

> exit 0 only when nothing is `AFFECTED` and every candidate is decided;
> exit 1 when at least one candidate is `AFFECTED`; a new, distinct exit
> code when nothing is `AFFECTED` but at least one candidate is undecided
> (any `UNKNOWN` finding, or an indeterminate unreported candidate); a
> flag restores the lenient exit-0-whenever-nothing-AFFECTED behaviour;
> the JSON output always carries a summary of counts by verdict and
> disposition; existing error exit codes keep their meaning; reject an
> empty `--cve`, and report when a filter matched nothing; compute the "no
> advisory discovered" condition from the unfiltered set; the HTML summary
> falls back to the first `unknownReasons` entry.

Closes (`tests/validation/FINDINGS.md`): **AUD-12** (an all-`UNKNOWN`
scan exits 0), **PRM-36** (`--cve` false reason), **PRM-110** (HTML "no
reason recorded"), **PRM-111** (`--cve ""` silently filters everything).
Sources: `docs/audits/2026-09-independent-audit.md` § 4 (AUD-12),
`docs/audits/2026-09-premise-sweep-round-1.md` § 4 (PRM-36),
`docs/audits/2026-09-premise-sweep-round-2.md` § 3–4 (PRM-110, PRM-111).

What binds B-5 from earlier tasks (REMEDIATION-PLAN § 5a):

- B-1: decision 3 counts `advisory_record_malformed` (disposition
  `undetermined`) as undecided; whether `withdrawn` counts as decided "is
  for B-5 to settle against decision 3's wording".
- B-2: an `indeterminate` applicability is an `UNKNOWN` finding, so it is
  undecided.
- B-3: a cache diagnostic is not a provider failure and never changes the
  exit code.
- B-4: every B-4 entry counts as undecided; PRM-36's condition (the
  unfiltered set) is still B-5's.

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **True** (AUD-12): `runScanCommand` ends with
  `findings.some(AFFECTED) ? 1 : 0`; an all-`UNKNOWN` scan exits 0 and the
  output has no summary field.
- **True** (PRM-111): `run.ts` rejects only a non-string `--cve`;
  `--cve ""` and `--cve=` reach the scan as a filter that matches nothing.
- **True, with a wording error in the record** (PRM-110): `summaryOf`
  (`html-report.ts`) returns `evidence.reasons[0]` and nothing else. It
  never reads `unknownReasons` at all (the FINDINGS title says it "reads
  only the first `unknownReasons` entry", which is not what the code
  does; the body describes the code correctly).
- **Partly false today** (PRM-36): the recorded false sentence ("no
  advisory was discovered for any sibling instance") no longer exists.
  B-4 rewrote the `installed_version_unavailable` detail: a versionless
  instance is now queried itself, and the detail says no advisory
  "matching `<id>`" was returned. That sentence is true, but it is still
  computed from the filtered set: it cannot say that advisories *were*
  returned for the name and were filtered out by `--cve`, which is the
  fact the reader needs. To be measured end to end on the audit's own
  fixture shape before the fix.
- **True**: exit codes 2 (usage), 3 (analysis failure) and 4 (provider
  failure) are in use (`run.ts`, `scan.ts`; `README.md` "Exit codes");
  5 is free.
- **True**: no corpus suite (validation, adversarial v1/v2, oracle)
  asserts an exit code; the differential tool records it but compares
  verdicts and proofs. Changing the exit code cannot move a corpus
  verdict.

## Task

### Problem

1. A CI gate cannot tell "nothing vulnerable" from "nothing decided":
   both exit 0, and the JSON output has no summary (AUD-12).
2. `--cve ""` silently filters out every advisory and exits 0 (PRM-111).
3. A `--cve` filter that matches nothing says so nowhere.
4. The versionless instance's "no advisory" detail is computed from the
   filtered set (PRM-36).
5. The HTML overview reads "no reason recorded" for an `UNKNOWN` whose
   reason is only in `unknownReasons` (PRM-110).

### Why it matters

Explainability and the silent-drop rule. None of these moves a verdict;
each lets a reader (or a CI gate) take an undecided scan for a clean one.
PRM-111 is recorded as a silent drop.

### What to do

1. **Tests first**, shown failing on the base: end to end through
   `runScanCommand` (exit codes for each outcome, both modes, both
   formats; the summary; the filter that matched nothing; PRM-36 on the
   audit's fixture shape), `runCli` (empty and blank `--cve`, a valued
   `--lenient-exit`, the flag's wiring), and the HTML overview (PRM-110,
   on a real scan's output).
2. **The fix**:
   - A pure `summarizeScan(findings, unreportedCandidates)` →
     `{ findings: {AFFECTED, NOT_AFFECTED, UNKNOWN}, unreportedCandidates:
     {not_applicable, undetermined, withdrawn}, outcome }` with
     `outcome` ∈ `affected | undecided | decided`, and a pure
     `exitCodeFor(summary, lenient)`. The output's new `summary` field is
     computed from the very arrays it is emitted next to; the exit code
     is computed from the summary, never separately.
   - Exit codes: `0` decided, `1` affected, **`5` undecided** (new);
     `--lenient-exit` maps undecided to `0`. 2, 3 and 4 unchanged.
   - Output schema `0.8`: `summary`, additive (not `required`, so every
     archived result still validates, as F3's fields were), always
     emitted by the producer.
   - `run.ts`: reject an empty or whitespace-only `--cve`; reject a
     `--lenient-exit` given a value.
   - `scan.ts`: when `--cve` is set and no advisory returned for any
     installed package matches it, a `vulnerabilities` diagnostic and a
     stderr line say so. The versionless "no advisory" detail is computed
     from the unfiltered set and names how many advisories the filter
     removed.
   - `html-report.ts`: `summaryOf` falls back to the first
     `unknownReasons` entry.
3. **Records**: FINDINGS (four fixed), OPEN-DEBTS, REMEDIATION-PLAN § 5a
   "B-5 additions", README exit codes, ARCHITECTURE where it states exit
   codes, the Foundation invariant, backlog, progress, scorecard.

### Decision B-5 settles (delegated by B-1's § 5a note)

**`withdrawn` counts as decided.** Decision 3 defines *undecided*
exhaustively ("any `UNKNOWN` finding, or any unreported candidate whose
disposition is indeterminate"); the only indeterminate disposition is
`undetermined`. `withdrawn` is, like `not_applicable`, a certain statement
with no uncertainty category (B-1, decision 10): the provider says the
advisory is void. Counting it as undecided would make a retracted
advisory fail a CI gate forever, with nothing anyone could do to decide
it. Flagged for the project owner in the pull request.

## Boundaries

### Do not touch

- Verdict rules, proof families, the normalizer, version matching, the
  cache, inventory.
- Disclosure wording (D-1: README / HTML sentences beyond the summary
  fallback), RWF-090's schema strictness (BL-059), BL-060.
- `tests/validation/` expected verdicts and the D-09 known failures.
- `docs/SDD.md` (historical; its exit-code table is not rewritten).
- Another task's worktree (`rwf-046-require-binding-authority`).

### STOP conditions

- Any corpus verdict or proof moves.
- A fix needs a new uncertainty category, a new disposition or a
  non-additive schema change.
- Decision 3's wording does not settle a case (beyond `withdrawn`, settled
  above): stop with `NEEDS_DECISION`.

## Acceptance criteria

- [ ] AUD-12: an all-`UNKNOWN` scan exits 5; an undetermined-only scan
      exits 5; a scan with an `AFFECTED` exits 1; a decided scan
      (`NOT_AFFECTED`, `not_applicable`, `withdrawn`) exits 0;
      `--lenient-exit` maps 5 to 0 and nothing else; HTML and JSON give the
      same code. On the base the undecided cases exit 0.
- [ ] Every scan's JSON carries `summary`, equal to the counts of its own
      arrays; schema `0.8` accepts it and still accepts a pre-0.8 result.
- [ ] PRM-111: `--cve ""`, `--cve=` and a blank `--cve` exit 2.
- [ ] A `--cve` filter that matches nothing is a diagnostic and a stderr
      line.
- [ ] PRM-36: on the audit's fixture shape, the versionless instance's
      detail says the name's advisories were returned and filtered out by
      `--cve`; "no advisory was returned" is said only when none was.
- [ ] PRM-110: the overview of an `UNKNOWN` with only `unknownReasons`
      shows its first reason, not "no reason recorded".
- [ ] Error exit codes 2, 3, 4 unchanged; a cache diagnostic never
      changes the exit code.
- [ ] Mutations each caught by a named test.
- [ ] Differentials reported (graph, proof, verdict): expected 0 / 0 / 0;
      validation equals the D-09 baseline case by case.
- [ ] Records updated; scorecard regenerated; every gate green.
- [ ] Independent audit `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed. Expected: no corpus movement;
validation exactly the five D-09 known failures (`RWB-03`, `RWB-05`,
`RWB-09b`, `VAL-002`, `VAL-003`).

## Report

In the format of `AGENTS.md` § J.
