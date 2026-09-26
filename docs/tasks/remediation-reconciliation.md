# remediation-reconciliation — Reconcile the remediation records and record the project owner's decisions

## Status

- **Status**: done
- **Branch**: remediation-reconciliation
- **Base SHA**: 39e5477b4fbdbd918b209820e0a3a19c2fa1d438
- **Commits**:
  - `05b3f23` docs(tasks): add the remediation-reconciliation task file
  - `084d3f6` docs(REMEDIATION-PLAN): record the project owner's 12 decisions
  - `7a51b38` docs(FINDINGS): correct two lane mismatches against REMEDIATION-PLAN.md
  - `998c0a7` docs(REMEDIATION-PLAN): assign PRM-37/PRM-38, add RWF-050 as a task
  - `bd53b45` docs(REMEDIATION-PLAN): replace the two-slot schedule with one sequence
  - `e559663` docs(OPEN-DEBTS): D-17 points to the now-merged remediation plan and ADRs
  - (this commit) docs(tasks): mark remediation-reconciliation done

## Project context

Two branches were written in parallel and have both merged to `main`:
`remediation-design` (ADRs 0008–0011, `docs/REMEDIATION-PLAN.md`, twelve
open decisions in its § 6) and `record-soundness-audits` (the three audit
reports under `docs/audits/`, 67 findings registered in
`tests/validation/FINDINGS.md` as `AUD-01`…`AUD-16`, `PRM-12`…`PRM-38`,
`PRM-60`…`PRM-67`, `PRM-101`…`PRM-116`, plus `RWF-050`, and `OPEN-DEBTS.md`
`D-17`). Because they ran in parallel, their records disagree in places.
The project owner has made all 12 decisions in `REMEDIATION-PLAN.md` § 6.
This task makes the records consistent and records the decisions. It is
documentation only: no file under `src/`, `fixtures/`, `scripts/`,
`schemas/`, `docs/audits/`, or `README.md` is touched, and no fix is
implemented.

Authoritative sections: `AGENTS.md` § B (source-of-truth order), § C
(documents are claims to verify), § D (premise verification), § H (git
workflow), § J (report format); `docs/REMEDIATION-PLAN.md` (the matrix and
§ 6); ADRs 0008–0011; `docs/OPEN-DEBTS.md` D-17.

**Premise checked and found true:** `main` at `39e5477` contains
`docs/adr/0008`–`0011`, `docs/REMEDIATION-PLAN.md`, `docs/audits/`, and the
`AUD-`/`PRM-` sections in `FINDINGS.md`; `main == origin/main`; the tree is
clean apart from three untracked files at the repository root
(`2026-09-independent-audit.txt`, `2026-09-premise-sweep-round-1.txt`,
`2026-09-premise-sweep-round-2.txt`), which this task does not add or
delete.

**Premise checked and found false:** the task prompt's Step 2 named
"known differences" between `FINDINGS.md`'s `Fix lane` field and the
plan's `Lane` column as `PRM-14`, `PRM-15`, `PRM-23` and `PRM-108`. A
field-by-field comparison of all 68 registered `Fix lane` values against
`REMEDIATION-PLAN.md`'s `Lane` column (§ 2.1–2.3) found those four
**already agree**. The genuine mismatches, found by checking every
registered finding as instructed, are `PRM-20` (`FINDINGS.md`: lane C;
plan: lane A) and `PRM-24` (`FINDINGS.md`: lane A; plan: lane C). Acted on
the measured result, not the stated premise, per `AGENTS.md` § D; see the
report's DEVIATIONS section.

## Task

### Problem

`REMEDIATION-PLAN.md` § 6 lists 12 undecided policy questions.
`FINDINGS.md`'s `Fix lane` field was partly inferred and disagrees with
the plan's measured lane assignment on two findings. The plan's matrix
omits IDs for two round-1 mechanisms since assigned (`PRM-37`, `PRM-38`)
and omits `RWF-050` entirely. The plan's lane-ordering (§ 5) assumes two
concurrent implementation slots; the project owner now wants one task at a
time. `OPEN-DEBTS.md` `D-17` does not yet point to the plan or the ADRs
that answer the block it records.

### Why it matters

An implementer picking up the first task after this one needs one
authoritative, self-consistent record: which lane owns which finding,
what was decided, and in what order to work. A stale two-slot schedule or
a wrong lane pointer sends the next task down a path the project owner did
not choose.

### What to do

1. Record all 12 decisions in `REMEDIATION-PLAN.md` § 6, dated, with the
   decided text. Where a decision changes an ADR or a task, append a
   "Decision record" section to that ADR (its body unchanged) and update
   the affected task's acceptance criteria in the plan.
2. Reconcile every `Fix lane` field in `FINDINGS.md`'s `AUD-`/`PRM-`
   sections against the plan's `Lane` column; append a short correction,
   pointing to the plan, to every finding that actually disagrees.
3. Match the plan's two unnumbered round-1 items to `PRM-37`/`PRM-38`;
   add `RWF-050` to the plan as its own reproduce-first task; verify the
   finding-ID sets of the plan's matrix and `FINDINGS.md` match exactly.
4. Replace the plan's two-slot schedule with one ordered sequential list,
   keeping the two-slot text marked superseded; add the shared real-Node
   oracle harness as the first task; place the `RWF-050` reproduction
   task where its result could change a lane's scope soonest.
5. Append a pointer from `OPEN-DEBTS.md` `D-17` to the plan and the ADRs.

## Boundaries

### Do not touch

`src/`, `fixtures/`, `scripts/`, `schemas/`, `docs/audits/`, `README.md`,
`tests/` other than `tests/validation/FINDINGS.md` (appended corrections
only), `docs/adr/0008`–`0011` (appended "Decision record" sections only,
bodies unchanged), `docs/OPEN-DEBTS.md` (the `D-17` pointer only, appended),
any worktree but this branch's own. Fix nothing.

### STOP conditions

A decision contradicting an ADR's invariant in a way that makes it
unsound; ADR 0008's protocol rule being ambiguous (as opposed to simply
not covering a path) about a path in decision 1; the plan's matrix and
`FINDINGS.md` disagreeing about whether a finding exists at all. None of
these occurred; see the report.

## Acceptance criteria

- [x] Task file committed first and marked done at the end
- [x] All 12 decisions recorded in the plan's § 6 with date and decided text
- [x] Decision records appended to the affected ADRs; bodies unchanged
- [x] A-1 and the AUD-12 task (B-5) carry the updated acceptance criteria
- [x] ADR 0008's protocol-rule coverage reported path by path (decision 1)
- [x] Every genuine lane difference found and corrected by appended text
- [x] `PRM-37` and `PRM-38` used in the plan; `RWF-050` added as a
      reproduce-first task
- [x] Matrix and `FINDINGS.md` contain exactly the same finding IDs
- [x] Single sequential schedule, harness first, reasoning per task;
      two-slot schedule marked superseded
- [x] `D-17` points to the plan and ADRs
- [x] Only permitted files changed; differentials zero; gates green;
      validation at the five known failures
- [x] Pushed; no PR; no merge; clean commit metadata

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Documentation only: all
three analyzer differentials (graph, proof, verdict) must be zero.
Validation must land on exactly the five documented known failures
(`OPEN-DEBTS.md` D-09), compared case by case, same verdicts.

## Report

In the format of `AGENTS.md` section J, in exactly that order.
