# Progress

The state of the work, for a fresh session: one screen, at most 60 lines
(`src/testing/records-limits.test.ts`; [`WORKFLOW.md`](WORKFLOW.md) § 6),
updated by every task's last commit. A task's own account is its task file.

**Last updated:** 2026-11-03, by `BL-126`.

## Objective

Close the soundness remediation — every reproduced false `NOT_AFFECTED`,
silent drop and fabricated edge in [`OPEN-DEBTS.md`](OPEN-DEBTS.md) D-16
and D-17 — through [`REMEDIATION-PLAN.md`](REMEDIATION-PLAN.md)'s lanes,
one task at a time. Then capability work (P1-B) resumes (OPEN-DEBTS § 4).

## State

- Merged: the MVP, Foundation F1–F7, P1-A1..A5, P1-B1..B3b; the
  remediation's design (ADRs 0008–0011, REMEDIATION-PLAN § 6.1) and its
  instruments (oracle harness, `scripts/differential.mjs`, `gates.mjs`).
- Remediation: lanes V and B, A-1..A-6, C-1, E-1 and E-2 are merged, with
  the point fixes marked `MERGED` in the backlog. Still to do: E-3..E-5,
  C-2..C-5, D-1, A-7. What binds them: REMEDIATION-PLAN § 5a's additions.
- Open findings, in their own words: [`SCORECARD.md`](SCORECARD.md) § 8,
  generated from the register (`tests/validation/findings/`); each one's
  closing row: BACKLOG § 2. Debts: OPEN-DEBTS § 1.

## Known limitations

**Until the remediation closes, treat every `NOT_AFFECTED` as `UNKNOWN`.**
OPEN-DEBTS § 3 criterion 3 is false on `main` (D-16, D-17); the README says
so. `npm run test:validation` is local only: D-09's cases fail by design.
Every `NOT_AFFECTED` assumes no change to any built-in object (§ 1).

## Key decisions

- Soundness > explainability > precision > coverage > performance;
  `UNKNOWN` is first-class (ARCHITECTURE § 2, ADR 0002).
- Invariants: ADR 0008 (call graph, lane A), 0009 (export model, E), 0010
  (capability flow, C), 0011 (corroboration, V); the owner's decisions in
  REMEDIATION-PLAN § 6.1 and the ADRs' decision records. On 2026-10-27
  (`BL-116`): BL-111's option (C), the trust boundary (`BL-113`); at most
  two audit rounds (WORKFLOW § 1.5); `BL-116` to `BL-121` first; on
  2026-11-03, BL-122's (W-all) (`BL-126`).

## Current task

`BL-126` — the trust boundary over every built-in object ([task file](tasks/BL-126-trust-boundary-all-builtins.md)): `READY_FOR_REVIEW`; no analyzer rule changed. RWF-161/162/163 are documented limitations; the audit spilled RWF-165 (`BL-132`, P0).

## Next

BACKLOG § 1 is the order: `BL-132` (P0, RWF-165), then the rest; `BL-123`, `BL-127` and `BL-131` follow from the decision.
`BL-107` awaits the owner's decision on O2e; `BL-078`, `BL-080` (P0),
`BL-082`, `BL-087` and `BL-090` need decisions. The P1 gaps `BL-057`,
`BL-058`, `BL-048`, `BL-050`, `BL-040`, `BL-043` and `BL-051` are
candidates to reorder ahead of the rest of lane E.

## Recently discovered

From `BL-126`: RWF-165, `BL-132`. From `BL-129`: `BL-131`. From `BL-128`: RWF-164 (fixed), `BL-129`.
