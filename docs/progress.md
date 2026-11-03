# Progress

The state of the work, for a fresh session: one screen, at most 60 lines
(`src/testing/records-limits.test.ts`; [`WORKFLOW.md`](WORKFLOW.md) § 6),
updated by every task's last commit. A task's own account is its task file.

**Last updated:** 2026-11-03, by `BL-129`.

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
Every `NOT_AFFECTED` assumes no change to the built-in prototypes (§ 1).

## Key decisions

- Soundness > explainability > precision > coverage > performance;
  `UNKNOWN` is first-class (ARCHITECTURE § 2, ADR 0002).
- Invariants: ADR 0008 (call graph, lane A), 0009 (export model, E), 0010
  (capability flow, C), 0011 (corroboration, V); the owner's decisions in
  REMEDIATION-PLAN § 6.1 and the ADRs' decision records. On 2026-10-27
  (`BL-116`): BL-111's option (C), the trust boundary (`BL-113`); at most
  two audit rounds (WORKFLOW § 1.5); `BL-116` to `BL-121` first.

## Current task

`BL-129` — the loader-touched members, end to end ([task file](tasks/BL-129-loader-member-tries.md)): `CANCELLED`. The end-to-end tries were stopped by a safety filter, as BL-128's were; the owner then chose (W-all) for BL-122, which covers those members by declaration.

## Next

BACKLOG § 1 is the order: `BL-126` (P0) implements the owner's decision on `BL-122`: (W-all), "a change" not narrowed, `NOT_AFFECTED` only (RWF-161/162/163; BL-126 records it in ADR 0010), then the rest.
`BL-107` awaits the owner's decision on O2e; `BL-078`, `BL-080` (P0),
`BL-082`, `BL-087` and `BL-090` need decisions. The P1 gaps
`BL-057` and `BL-058` (small, from C-1), `BL-048`, `BL-050`, and `BL-040`,
`BL-043` and `BL-051` (live family-A false `NOT_AFFECTED`s) are
candidates to reorder ahead of the rest of lane E.

## Recently discovered

From `BL-129`: `BL-131`. From `BL-128`: RWF-164 (fixed), `BL-129`.
