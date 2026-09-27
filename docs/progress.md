# Progress

The state of the work, for a fresh session. One screen; not a transcript.
Updated by every task's last commit ([`WORKFLOW.md`](WORKFLOW.md) § 1.7).

**Last updated:** 2026-09-27, by `D-03`.

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
  README-notice record corrected) and D-03 (`npm test` and
  `npm run test:validation` are both fully offline — OPEN-DEBTS D-03,
  CLOSED). No lane is implemented yet.
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

`D-03` — isolate live OSV from `npm test` and `test:validation`
([task file](tasks/D-03-hermetic-osv-validation.md)): `READY_FOR_REVIEW`,
its pull request awaiting the project owner. `BL-001` (correct the false
"no README notice" record) merged as PR #75.

## Next

The order is [`tasks/BACKLOG.md`](tasks/BACKLOG.md) § 1. After `D-03`:
`BL-029` (differential tool), then lane A from `A-1`.

## Recently discovered

`RWF-054` (`AGENTS.md` claimed CI still runs on push to `main`; the
trigger was removed), `RWF-055` (39 backlog rows cite "Appendix A",
which exists nowhere in this repository — tracked as `BL-031`), `RWF-056`
(`tests/validation/README.md`'s known-failure count and citations were
stale) — all found and corrected by `D-03`. `BL-030` (promote
`test:validation` to a CI gate — needs a decision on how the five
OPEN-DEBTS D-09 known failures should read to CI). Still open from
earlier tasks: `BL-017`, `BL-018` (with finding RWF-052), `BL-029`;
`BL-004` (archived P0-Z and P0 closure probes, added by the project
owner).
