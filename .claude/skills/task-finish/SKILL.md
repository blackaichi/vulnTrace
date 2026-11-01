---
name: task-finish
description: Finish a VulnTrace backlog task — WORKFLOW § 1.3 to § 1.8 and § 5 (full gate run, self-review, records, the last commit's bookkeeping, one commit per micro-task, the commit subject check, push, pull request, the AGENTS.md § J report, stop). Use when a task's work is done and it is ready for review.
---

# Finish a task (WORKFLOW § 1.3 to § 1.8, § 5)

Applies `docs/WORKFLOW.md` § 1.3–§ 1.8 and § 5, and `AGENTS.md` § H–§ J.
Those documents are the rules; this file is the order of the commands,
and decides nothing they leave open (task `BL-120`).

## 1. Records (WORKFLOW § 1.2, "Where each fact is written")

Each fact once, in the record that owns it:

- a defect found: a new file `tests/validation/findings/<ID>.md`, its ID
  from `node scripts/next-id.mjs RWF` (`tests/validation/findings/README.md`);
  an existing record gets an appended note and its status row updated;
- a debt's status change: its entry in `docs/OPEN-DEBTS.md`;
- discovered work: a backlog row, its ID from
  `node scripts/next-id.mjs BL`, a note over 300 characters in a note file
  (WORKFLOW § 2);
- then regenerate the scorecard and the findings index:
  `node scripts/generate-scorecard.mjs` (never hand-edit either).

## 2. The last micro-task's commit carries the bookkeeping (§ 1.7)

Not a commit of its own:

- the task file: `Status` `READY_FOR_REVIEW`, the commit list (subjects;
  the last one "(this commit)"), the acceptance criteria answered, and
  the "Account" (premises as verified, measurements, audit rounds,
  deviations);
- `docs/tasks/BACKLOG.md`: the row `READY_FOR_REVIEW`;
- `docs/progress.md`: "Current task", "Next", "Recently discovered"; a
  "State" line only when the phase's state changes; at most 60 lines
  (`src/testing/records-limits.test.ts`).

## 3. Commits (§ 1.6)

One commit per micro-task, the task file first; formatting, scorecard
regeneration, gate-driven fixes and trailer fixes are folded into the
micro-task they belong to. Squash or amend your own unpushed commits
(non-interactively: `git reset --soft`, `git commit --amend`, or
`git commit --fixup` and `GIT_SEQUENCE_EDITOR=: git rebase --autosquash`).
Every commit builds and type-checks.

```bash
node scripts/check-commit-subjects.mjs   # ≤ 72 characters, <type>(<ID>): <summary>
npm run validate:metadata                # the only trailer, no model names
```

## 4. Validate (§ 1.3, § 3) and self-review (§ 1.4)

The full gate set, once, on the final HEAD, unrelaxed:

```bash
node scripts/gates.mjs
```

It runs every `AGENTS.md` § I gate and then the differential. Quote its
summary. Compare `test:validation`'s failures with OPEN-DEBTS D-09's
baseline case by case and verdict by verdict (WORKFLOW § 3 names the
cases and the `RWB-09a` caveat). Report the graph, proof and verdict
differentials separately; a zero corpus differential is not evidence of
soundness. A suite that exits non-zero with every test passing is rerun
alone, and both runs are reported.

Then read the whole diff: `git diff main...HEAD` — unintended changes,
files out of scope, debug leftovers, weakened tests, comments whose
premise the change made false. A fix after the gate run means the gates
run again.

The run's results go in the pull request and the report, not in a new
commit, so the run stays the final HEAD's (the task file's criterion for
it is ticked in the last commit, as earlier tasks do).

## 5. Push and open the pull request (§ 1.8, § 4)

```bash
git status --short                       # clean
git push -u origin <branch>
gh pr create --base main --title "<ID>: <concise summary>" --body-file <body.md>
```

The body follows `.github/pull_request_template.md`: Summary, Why,
Validation, Independent audit (rounds, last verdict, spilled findings
with their rows, or "not required: <reason>"), Known limitations, Needs
human review, Newly discovered tasks. **Never merge.**

## 6. Report (§ 5), then stop

The `AGENTS.md` § J report, in its order: VERDICT; task completed (each
acceptance criterion yes or no); what changed; validation performed (each
gate and result, differentials, validation baseline); PR (link, number,
base SHA, branch, HEAD SHA, tree clean, pushed, not merged, commit list
with SHAs); anything requiring manual review; newly discovered tasks (or
exactly "No new tasks discovered."); current backlog summary (next three
to five `TODO`, anything `BLOCKED`, counts by status).

Then stop. The next task starts only after the owner confirms the merge.
