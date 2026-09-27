# Progress

The state of the work, for a fresh session. One screen; not a transcript.
Updated by every task's last commit ([`WORKFLOW.md`](WORKFLOW.md) § 1.7).

**Last updated:** 2026-09-28, by `BL-029`.

## Objective

Close the soundness remediation: every reproduced false `NOT_AFFECTED`,
silent drop and fabricated edge in
[`OPEN-DEBTS.md`](OPEN-DEBTS.md) D-16 and D-17, through the four
structural invariants and two point-fix lanes of
[`REMEDIATION-PLAN.md`](REMEDIATION-PLAN.md), one task at a time. Only
then does capability work (P1-B) resume (OPEN-DEBTS § 4).

## State

- MVP, Foundation (F1–F7), P1-A1..A5 and P1-B1..B3b are merged.
- The remediation is designed (ADRs 0008–0011, the plan's § 6.1
  decisions) and its preparatory tasks are merged: H-0 (real-Node oracle
  harness), A-0 (ADR 0008 coverage reproduction, Amendment A-0 accepted),
  gate enforcement (every hermetic gate runs in CI), BL-001 (a false
  README-notice record corrected), D-03 (`npm test` and
  `npm run test:validation` are both fully offline — OPEN-DEBTS D-03,
  CLOSED) and BL-029 (`node scripts/differential.mjs`: the graph, proof
  and verdict differentials, base against head, over all 139 corpus
  cases — usage in [`WORKFLOW.md`](WORKFLOW.md) § 3). No lane is
  implemented yet.
- Numbers: [`SCORECARD.md`](SCORECARD.md) (measured, generated) and
  [`OPEN-DEBTS.md`](OPEN-DEBTS.md) (debts, P1-B entry criteria).

## Known limitations

**Until the remediation closes, treat every `NOT_AFFECTED` as `UNKNOWN`.**
OPEN-DEBTS § 3 criterion 3 is false on `main`: D-16 and D-17 record
dozens of reproduced paths to a false `NOT_AFFECTED` or a silently
dropped finding. The README says this (`README.md:80-88`, since
`ae82d33`); its `## Status` section now points there too (`BL-001`,
`tests/validation/FINDINGS.md` RWF-053 — an earlier version of this line
said the notice did not exist, which was false).
`npm run test:validation` is hermetic since `D-03` (replays a recorded
OSV snapshot) but is still not run in CI: five of its cases are
deliberately kept failing (OPEN-DEBTS D-09) and the suite exits non-zero
by design regardless of network access (backlog `BL-030`).

## Key decisions

- Soundness > explainability > precision > coverage > performance;
  `UNKNOWN` is first-class (ARCHITECTURE § 2, ADR 0002).
- Remediation invariants: ADR 0008 (call graph, lane A), 0009 (export
  model, E), 0010 (capability flow and resolution, C), 0011 (negative-proof
  corroboration, V). The owner's decisions: REMEDIATION-PLAN § 6.1 and the
  decision records appended to ADR 0008.
- One task at a time; the agent opens the pull request and never merges
  (AGENTS.md § H, [`WORKFLOW.md`](WORKFLOW.md)).

## Current task

`BL-029` — shared graph, proof and verdict differential tool
([task file](tasks/BL-029-differential-tool.md)): `READY_FOR_REVIEW`, its
pull request awaiting the project owner. `D-03` merged as PR #76.

## Next

The order is [`tasks/BACKLOG.md`](tasks/BACKLOG.md) § 1. After `BL-029`:
lane A from `A-1`, which is the first task to report its differentials
with the tool.

## Recently discovered

From `BL-029`: `BL-032` (the suites' finding selector is written out
four times, the tool's suite view included) and `BL-033` (vitest's
`Timeout calling "onTaskUpdate"` looks duration-bound, not load-bound;
verify and remove it from the suites). Still open from earlier tasks:
`BL-030` (promote `test:validation` to a CI gate — needs a decision),
`BL-031` (the 39 "Appendix A" citations, RWF-055), `BL-017`, `BL-018`
(with finding RWF-052), `BL-004` (archived P0-Z and P0 closure probes,
added by the project owner).
