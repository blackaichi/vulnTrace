# B-6 — Rule/package mismatch reason

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: B-6
- **Branch**: b-6-rule-package-mismatch-reason
- **Base SHA**: 6707a00a8cffdd0547530e0b1db907f28597fb1d
- **Commits**: (filled in by the last commit)
- **Superseded by**: —

## Project context

Sixth and last task of lane B of the soundness remediation
([`docs/REMEDIATION-PLAN.md`](../REMEDIATION-PLAN.md) § 5a order 18),
after [`B-5`](B-5-cli-and-output.md) (PR #95, merged 2026-10-11). Its
hard dependency is lane V, because it edits `src/analysis/verdict.ts`
(plan § 5.1); V-1..V-4 are merged.

The specification is REMEDIATION-PLAN § 7's B-6 row: files
`src/analysis/verdict.ts`; acceptance "the reason names the mismatch, not
a family-B-shaped absence". Closes **AUD-15**
(`tests/validation/FINDINGS.md`; source
`docs/audits/2026-09-independent-audit.md` § 4 "AUD-15", fix suggestion
§ 7: compare the finding's package name with the rule's before instance
matching; the other package gets an `UNKNOWN` of the
`no_vulnerable_symbol_rule` kind, "the rule has no target for this
package").

### Premises, checked against `main` at the base SHA (`AGENTS.md` § D)

- **True**: a rule's `package.name` is never read. `rule-loader.ts` keeps
  it (`package: { name }`); `findRuleForVulnerability` (`src/cli/scan.ts`)
  selects a rule by advisory id or alias only; `buildFinding`
  (`verdict.ts`) takes the rule and never compares it with `packageName`.
- **True, measured**: one advisory affecting `vuln-lib` and `other-lib`,
  a rule whose `package.name` and only target are `vuln-lib#danger`, an
  app calling `vuln-lib.safe` and `other-lib.danger`. The `other-lib`
  finding is `UNKNOWN`, which is sound.
- **False, measured**: the audit's reason. AUD-15 records
  `package_instance_absence_*` / "was never traversed". Lane V and F2
  have since changed the path: on `main` the `other-lib` finding carries
  `vulnerable_target_unresolved` and the prose `could not resolve module
  "vuln-lib": … the authoritative public entry of package instance
  …/other-lib could not be resolved`. The reason text is still wrong in
  the same way (the true cause, that the rule names another package, is
  never stated and the rule's module is resolved against the wrong
  instance), but it is a different token than the finding records. The
  finding's prose is corrected in this task's records, not rewritten
  (FINDINGS is append-only).

## Task

### Problem

A rule belongs to one package (`package.name`), but it is attached to an
advisory, and an advisory can affect several packages. The rule is
applied to every package's finding. For a package the rule does not name,
its targets are resolved against that package's instance, fail to
resolve, and the `UNKNOWN` says something false about resolution.

### Why it matters

Explainability (a false reason), not soundness: the verdict is already
`UNKNOWN`. It is not a false `NOT_AFFECTED`. Defect class: none of A/B/C.
The change only ever withdraws toward `UNKNOWN`, never toward a proof.

### What to do

1. Failing-first tests (`src/cli/`, end to end through `runScanCommand`):
   the two-package repro above, asserting the other package's reason is a
   rule/package mismatch and does not say the module could not be
   resolved; a matching-rule control (the named package keeps its
   verdict); an npm-alias and a scoped-package control. Show them failing
   on the base commit.
2. In `buildFinding`, after the no-rule branch and before reachability,
   compare the rule's `package.name` with the finding's `packageName`. A
   mismatch is `UNKNOWN` with a new reason subtype
   `rule_package_mismatch`, in the existing category
   `analysis_precondition_unmet` (no seventh category), with prose naming
   both names. Register it wherever reason tokens are registered.
3. Differentials (`scripts/differential.mjs`) reported separately. A
   corpus rule whose `package.name` differs from its finding's package
   would move a verdict to `UNKNOWN`: list each and decide whether the
   rule or the analyzer is wrong.
4. Records: FINDINGS (append the correction and the status), OPEN-DEBTS,
   REMEDIATION-PLAN § 5a "B-6 additions", backlog, `progress.md`, the
   scorecard (regenerated).

## Boundaries

### Do not touch

Another task's worktree (`rwf-046-require-binding-authority`); the
`b-5-cli-and-output` branch checked out in the project owner's primary
checkout; proof-family logic in `verdict.ts` beyond the one new branch;
the rule schema and `rules validate` (a validate-time check of
`package.name` against the rule's target modules is not in the plan's
B-6 row; if wanted it is a discovered task).

### STOP conditions

- A corpus case moves to `UNKNOWN` and the rule is the correct one
  (a legitimate rule whose `package.name` is not the finding's package
  name): `NEEDS_DECISION`.
- Any path from this change to a `NOT_AFFECTED` that was not reached
  before: `STOPPED_ON_FINDING`.

## Acceptance criteria

- [ ] The two-package repro's `other-lib` finding is `UNKNOWN` with
      `rule_package_mismatch`, whose prose names the rule's package and
      the finding's package, and no resolution failure.
- [ ] The named package's finding is unchanged.
- [ ] `rule_package_mismatch` belongs to `analysis_precondition_unmet`;
      the number of categories is still six.
- [ ] The tests failed on the base commit and pass after.
- [ ] Verdict, proof and graph differentials reported separately; no
      `NOT_AFFECTED` is created.
- [ ] Every gate of `AGENTS.md` § I passes; validation equals the D-09
      baseline.
- [ ] Independent audit `CERTIFIED`.

## Gates

The full set in `AGENTS.md` § I, unrelaxed.

## Report

In the format of `AGENTS.md` section J (`docs/WORKFLOW.md` § 5).
