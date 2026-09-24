# remediation-design — invariant-level remediation design for the reproduced soundness findings

## Status

- **Status**: in-progress
- **Branch**: `remediation-design`
- **Base SHA**: `62b52b90cb5fead842534e1743519ca3da411945`
- **Commits**:
- **Superseded by**:

## Project context

Three read-only investigations, run against `62b52b9`, reproduced about 65
defects end to end against real Node, through the real scan pipeline
(`runScanCommand`) with loud fixtures and positive and negative controls:

- an independent audit, AUD-01 … AUD-16 (its report is not in the
  repository; only its one-line summaries were supplied to this task);
- comment-premise sweep round 1, FALSE items PRM-12 … PRM-36 (PRM-11 is
  RWF-047 on a new surface);
- comment-premise sweep round 2, PRM-101 … PRM-116, with PRM-60 … PRM-67
  settled FALSE.

None of them is registered in `tests/validation/FINDINGS.md` or
`docs/OPEN-DEBTS.md` yet; a later task does that.

Most of them are false `NOT_AFFECTED`, and they share one cause: when the
analyzer meets a construct it does not model, it treats it as "nothing
happens here" instead of failing closed. This task designs the fix at the
level of that cause, per fix lane, instead of per instance.

Governing documents: `docs/SOUNDNESS-CONTRACT.md` § 1–§ 4 (verdicts and
proof families), `docs/ARCHITECTURE.md` § 2 (priority order), § 6.1 (the six
uncertainty categories), § 13 (rules), `docs/OPEN-DEBTS.md` D-06 (RWF-002,
target-relevant completeness) and D-09 (validation baseline).

Premises to verify (AGENTS.md section D): the lane assignments, file names
and finding summaries in the prompt that produced this task; the claim
that the validation baseline is exactly five documented failures.

## Task

### Problem

About fifty reproduced false `NOT_AFFECTED` and three silent drops, spread
across the call graph, the export model, the loader-capability classifier,
the verdict assembly and intake. Fixing them one by one leaves the
unfound instances of the same cause in place.

### Why it matters

Soundness, the first priority. A false `NOT_AFFECTED` and a silently
dropped finding are the critical failures. Several fire on ordinary code
(timer and Promise callbacks, JSX, decorators, derived classes with no
constructor, `export *` barrels, `module.exports = {…}` followed by
`module.exports.x = …`, TypeScript projects using `module: commonjs`).
Defect classes A, B and C (AGENTS.md section F) are all represented.

### What to do

1. One ADR per invariant lane (A call graph, E export model, C capability
   flow and resolution, V verdict corroboration) under `docs/adr/`, next
   free numbers, existing ADR format. Each states: the invariant, precisely
   enough to be checked mechanically; its enforcement and a structural
   gate; the fail-closed default using an existing uncertainty category;
   modeled exceptions and why each is sound; the precision cost, measured
   with a throwaway prototype outside the repository where feasible,
   otherwise bounded with the exact measurement method; the certified
   behaviour it reopens and the reproductions that justify it; the
   interaction with the three proof families and RWF-002; an ordered list
   of branch-sized implementation tasks with acceptance stated as
   reproductions that flip and existing tests that change.
2. `docs/REMEDIATION-PLAN.md`: the finding matrix (every finding → lane →
   invariant or point fix → implementation task, none unmapped), the lane
   ordering with parallel-safety and file overlap, and lanes B and D as
   numbered point-fix tasks grouped into branch-sized units.
3. Assign each of the three tests that pin a false premise to an
   implementation task: `symbol-binder.test.ts` "ignores a trailing method
   chain…", `verdict.negative-proof.test.ts` "case 10b", and the VT-213
   "someUtterlyArbitraryMethodName" test in `call-graph.test.ts`.

## Boundaries

### Do not touch

Create only new files under `docs/adr/`, `docs/REMEDIATION-PLAN.md` and
this task file. Modify no existing file. In particular: `src/`, `tests/`,
`fixtures/`, `scripts/` (another session is changing the scorecard
tooling), `schemas/`, `README.md`, `tests/validation/FINDINGS.md`,
`docs/OPEN-DEBTS.md`, `docs/SCORECARD.md`. Measurement prototypes live
outside the repository and are never committed. Touch no worktree but this
task's own.

### STOP conditions

Report `NEEDS_DECISION` if an invariant requires a policy choice the
evidence cannot settle (for example, how much precision a lane may trade
for soundness). Report `STOPPED_ON_FINDING` if verification shows a
finding's reproduction does not hold at the base SHA.

## Acceptance criteria

- [ ] This task file committed first, marked done at the end with commit links
- [ ] One ADR per invariant lane, each covering the eight points above
- [ ] Each invariant mechanically checkable, with a structural gate
- [ ] Precision cost measured, or bounded with an exact measurement method
- [ ] Every reopened certified behaviour named and justified
- [ ] The three pinned tests each assigned to an implementation task
- [ ] `docs/REMEDIATION-PLAN.md` maps every finding; none unmapped
- [ ] Lane ordering states parallel-safety and file overlap
- [ ] Only permitted files created; no existing file modified
- [ ] Differentials zero; gates green; validation at the documented baseline
- [ ] Pushed; no PR; no merge; clean commit metadata

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Documentation only: the
graph, proof and verdict differentials must all be zero. Validation must
show exactly the documented known failures (OPEN-DEBTS D-09), with the same
verdicts.

## Report

In the format of `AGENTS.md` section J, plus: 11. DECISIONS FOR THE USER
(every policy choice the design needs, with options, recommendation and
cost) and 12. PREMISES (every claim in the prompt checked, and the result).
