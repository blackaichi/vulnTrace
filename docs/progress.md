# Progress

The state of the work, for a fresh session. One screen; not a transcript.
Updated by every task's last commit ([`WORKFLOW.md`](WORKFLOW.md) § 1.7).

**Last updated:** 2026-09-28, by `A-1`.

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
  cases — usage in [`WORKFLOW.md`](WORKFLOW.md) § 3).
- Lane A has started. `A-1` made every invocation site of a walked file
  yield an account (ADR 0008 invariant A1: a census of every
  `ts.SyntaxKind`, a handler table, `InvocationAccount`), fixed
  tagged templates, decorators and implicit `super` (PRM-37, PRM-115,
  PRM-19), and found and fixed RWF-057 (a `vm` tag). The no-edge branches
  still taken without a proof are named in `UNPROVEN_NO_EDGE_LEDGER`
  (`src/domain/graph.ts`) with the task that removes each (A-3, A-5).
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

`A-1` — `InvocationAccount`, syntax-kind census, handler table; tagged
templates, decorators, implicit `super`
([task file](tasks/A-1-invocation-account.md)): `READY_FOR_REVIEW`, its
pull request awaiting the project owner. `BL-029` merged as PR #77.

## Next

The order is [`tasks/BACKLOG.md`](tasks/BACKLOG.md) § 1. After `A-1`:
`A-2`, the `possible` edge kind, bound by the rule `A-1` wrote into
[`SOUNDNESS-CONTRACT.md`](SOUNDNESS-CONTRACT.md) § 1 and § 3 and by the
`affected-path-resolved-edges-only` invariant, whose owner test it must
extend.

## Recently discovered

From `A-1`: `BL-037` (**P1**, RWF-061: a `vm.Script` reached through a
subclass or factory is a family-A false `NOT_AFFECTED`), `BL-038` (**P1**,
RWF-062: `new A()` resolves to a constructor overload signature), RWF-060 (**P1**,
an implicit constructor forwarding a callback into an ambient or builtin
base; added to A-3's acceptance), `BL-036` (RWF-059, an instance field
initializer's calls attributed to the class-definition owner), `BL-034`
(resolve an explicit `super(...)` through the base authority —
precision) and `BL-035` (RWF-058, a call inside a member decorator's
expression is attributed to the member). From
`BL-029`: `BL-032` (the suites' finding selector is written out
four times, the tool's suite view included) and `BL-033` (vitest's
`Timeout calling "onTaskUpdate"` looks duration-bound, not load-bound;
verify and remove it from the suites). Still open from earlier tasks:
`BL-030` (promote `test:validation` to a CI gate — needs a decision),
`BL-031` (the 39 "Appendix A" citations, RWF-055), `BL-017`, `BL-018`
(with finding RWF-052), `BL-004` (archived P0-Z and P0 closure probes,
added by the project owner).
