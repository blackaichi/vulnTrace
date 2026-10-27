# BL-116 — Record the project owner's decisions of 2026-10-27 and amend the workflow

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-116
- **Branch**: `bl-116-owner-decisions-workflow`
- **Base SHA**: `5c8bcc3c3a94616ab7a8190b60ea5722cc85677d` (BL-114's merge, PR #121)
- **Commits**: <!-- filled in by the last commit -->
- **Superseded by**: —

## Project context

On 2026-10-27 the project owner asked why each task takes about an hour,
for a review of the workflow, the tests, the documentation and the code,
and for proposals. The review measured the repository on `5c8bcc3` and
proposed a sequence of tasks. The owner accepted every recommendation and
answered four questions:

1. **BL-111: option (C), the trust boundary, is accepted** (ADR 0010,
   "Proposed decision — BL-111" and "Note — task BL-114").
2. **At most two independent-audit rounds per task.** A finding left after
   the second round is registered and gets a backlog row instead of being
   fixed inside the task.
3. **Order: the improvement tasks come first.** BL-116 to BL-121, then
   BL-113 under decision 1, then the soundness queue.
4. **Authorized:**
   - split `tests/validation/FINDINGS.md` into one file per record (BL-119);
   - a local on-disk cache of real-Node oracle results, with CI uncached
     (BL-117);
   - move `docs/tasks/BACKLOG.md`'s notes into task files (BL-119);
   - remove stale worktrees. This was done at this task's start
     (WORKFLOW § 1.1 step 3): the four worktrees of merged tasks under
     `.claude/worktrees/` and their local branches, and eight detached
     worktrees left in other jobs' temporary folders. Each was checked
     first: every commit and every uncommitted file in them is on `main`.

This task records those decisions and applies the ones that are rules of
the workflow. BL-117 to BL-121 are the others, one task each.

### Premises (AGENTS.md § D)

Measured by the review on `5c8bcc3`, from the repository and GitHub:

- **Audit rounds.** BL-081 and BL-091 ran ten rounds each; BL-084,
  BL-095 and BL-099 five; BL-074 and BL-096 four (their task files).
  Nothing bounds the rounds: WORKFLOW § 1.5 says "fix it, re-validate,
  re-audit".
- **Backlog growth.** 55 rows were added from 2026-10-10 (`BL-060`) to
  2026-10-27 (`BL-115`), against 33 pull requests merged since
  2026-10-09. Findings went from RWF-100 (2026-10-13) to RWF-160
  (2026-10-27).
- **A task's pull request** (the 16 before this one): `src/` is typically
  200 to 400 added lines; tests about 1,000; records 450 to 700, spread
  over the task file, FINDINGS.md, an ADR, OPEN-DEBTS.md, progress.md,
  BACKLOG.md and the scorecard.
- **Commit subjects** of recent tasks run to 150–250 characters.

Re-verified by this task before relying on them:

- the ADR 0010 sections above exist with the wording quoted in the
  decision record;
- WORKFLOW § 1.5's current text;
- no gate parses the parts this task edits. `src/testing/gates-lib.test.ts`
  reads AGENTS.md § I's gate table only. `scripts/check-docs.mjs` checks
  that cited paths and `npm run` scripts exist.

## Task

### Problem

Each task takes about an hour or more, and the backlog grows faster than
tasks close it. Part of the cost is the process:

- the audit loop has no bound;
- a task restates the same facts in six documents;
- the full task template is written even when the specification already
  lives in a plan row or a decision record;
- commit subjects are paragraphs.

Separately, decision 1 has no decision record yet. A fresh session would
still read ADR 0010's BL-111 section as pending.

### Why it matters

This is process, not analyzer behaviour; no verdict moves. It serves
soundness indirectly. A bounded audit loop with a registered spill-over
keeps every finding visible (nothing pinned as a wrong verdict, nothing
dropped), and still lets a fix that closes reproduced defects reach
review. The rule that a defect the change itself introduces is never
spilled keeps OPEN-DEBTS D-15's lesson: a remediation can introduce the
class it was closing.

### What to do

1. **Decision record.** Append "Decision record — BL-111" to ADR 0010, in
   the format of "Decision record — BL-096". It states:
   - what is accepted;
   - why, from the recorded measurements;
   - what it leaves undecided;
   - what BL-113 implements.

   Nothing in `src/`, SOUNDNESS-CONTRACT.md or FINDINGS.md changes here.
   BL-113 amends the contract, adds the disclosure and moves RWF-156,
   RWF-158 and RWF-160 to the documented limitation.
2. **WORKFLOW § 1.5.** At most two audit rounds, and the spill-over rule.
   A defect the change introduces is never spilled. Round 0 audits the case
   list before the fix. Findings come as reproductions.
3. **WORKFLOW § 1.2.** "Where each fact is written": say it once, link it
   everywhere else.
4. **AGENTS.md § H.** A commit subject is at most 72 characters.
5. **`docs/tasks/TEMPLATE-SHORT.md`**, for a task whose specification
   already lives in a plan row, an ADR section or a decision record.
   `docs/tasks/README.md` and WORKFLOW § 1.1 point to it.
6. **`.github/pull_request_template.md`.** The audit section names the
   rounds run and the findings spilled.
7. **Records.**
   - BACKLOG.md: BL-114 is `MERGED`; rows BL-117 to BL-121 go first in § 1
     after BL-116 (decision 3), and BL-113 moves after them, restated
     under decision 1.
   - `docs/progress.md`.

## Boundaries

### Do not touch

- `src/`, `tests/`, `scripts/`, `fixtures/`, `.github/workflows/`.
- `docs/SOUNDNESS-CONTRACT.md`, `tests/validation/FINDINGS.md` and
  `docs/OPEN-DEBTS.md`. BL-113 and BL-119 own those changes.
- AGENTS.md § I's gate table, which `gates-lib.test.ts` parses.
- Any earlier section of ADR 0010 (append only) and any earlier task file.

### STOP conditions

- An answer of the owner's, as recorded, contradicts an authoritative
  document in a way an appended section cannot reconcile
  (`NEEDS_DECISION`).
- A gate fails for a reason a documentation change cannot explain
  (`STOPPED_ON_FINDING`).

## Acceptance criteria

- [ ] ADR 0010 ends with "Decision record — BL-111", appended. It states
  (C) as accepted, its scope, what it leaves undecided, and BL-113's
  implementation. No earlier section changed.
- [ ] WORKFLOW § 1.5 states the two-round limit, the spill-over rule, the
  never-spilled rule, round 0, and findings as reproductions.
- [ ] WORKFLOW § 1.2 says where each fact is written.
- [ ] AGENTS.md § H states the 72-character subject rule, and this task's
  own commits meet it.
- [ ] `docs/tasks/TEMPLATE-SHORT.md` exists, and `docs/tasks/README.md`
  and WORKFLOW § 1.1 refer to it.
- [ ] The pull request template's audit section asks for the rounds run
  and the spilled findings.
- [ ] BACKLOG.md: BL-114 is `MERGED`; BL-116 to BL-121 come first in § 1
  in the decided order; BL-113 follows them and depends on BL-116.
- [ ] No file under `src/`, `tests/`, `scripts/`, `fixtures/` or
  `.github/workflows/` changed.
- [ ] The full gate set passes. `test:validation` fails on exactly the
  documented known failures.

## Gates

The full set in AGENTS.md § I, through `node scripts/gates.mjs`. Expected:

- no analyzer change, so all three differentials are zero;
- `test:validation` fails on exactly OPEN-DEBTS D-09's six cases. The
  runner reports `RWB-09a` as unexpected, as WORKFLOW § 3 documents
  (RWF-119).

Audit: not required (documentation only, BACKLOG.md's Audit column).

## Report

In the format of AGENTS.md § J.
