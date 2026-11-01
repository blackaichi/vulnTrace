---
name: task-start
description: Start the next VulnTrace backlog task — WORKFLOW § 1.1 step by step (confirm the previous PR merged, sync main, remove the previous worktree, choose and announce the task, branch in a new worktree, first commit with the task file and backlog bookkeeping). Use when asked to continue the backlog or start a task.
---

# Start a task (WORKFLOW § 1.1)

Applies `docs/WORKFLOW.md` § 1.1 and `AGENTS.md` § H. Those documents are
the rules; this file is the order of the commands, and decides nothing
they leave open. Where they disagree with this file, they win, and this
file is the one to fix (task `BL-120`).

## 1. Read the state

- `docs/progress.md`: "Current task" names the previous task and its
  status.
- `docs/tasks/BACKLOG.md` § 1: the order. The next task is the first
  `TODO` row whose `Depends on` tasks are all `MERGED`, unless the
  project owner reordered.

## 2. Confirm the previous task is merged; sync `main`

```bash
gh pr list --state all --limit 5 --json number,title,state,mergedAt,headRefName
git fetch origin --prune
git checkout main && git merge --ff-only origin/main
git status --short                       # must print nothing
git rev-parse main origin/main           # must be equal: the base SHA
```

The previous task's pull request must be `MERGED`. If it is not, or the
tree is not clean, or `main` has diverged: stop and ask
(WORKFLOW § 7, "the git state is unexpected").

## 3. Remove the previous task's worktree and branch

Only the previous task's own (AGENTS.md § H); never another task's.

```bash
git worktree list
git cherry main <previous-branch>        # every line must start with "-"
git -C <its worktree> status --short     # must print nothing
git worktree remove <its worktree>       # a locked one needs: -f -f
git branch -D <previous-branch>
```

A `+` line or an uncommitted file is work not on `main`: stop and ask.

## 4. Reassess, then announce

Reassess before choosing (WORKFLOW § 1.1 step 4): review feedback, a new
discovery, a changed dependency, a failing test, an assumption that no
longer holds. A change of order is proposed to the owner, not made.

Read the task's specification: its row's `Notes` link (a note file
`docs/tasks/<ID>.md` or a task file), and the plan row or ADR section it
names. Verify its premises against the code before relying on them
(AGENTS.md § C, § D).

Announce in three to five lines: the task, why it is next, the
recommended model and effort (design- or audit-heavy: the most capable
model at high effort; routine implementation: a standard model), and
whether an independent audit is required (the row's `Audit` column).
**Stop** if the owner asked to approve each start, or if the model or
effort should change first.

## 5. Branch, in a new worktree

```bash
git worktree add -b <id-lowercase>-<slug> .claude/worktrees/<id-lowercase>-<slug> origin/main
cp -a <main checkout>/node_modules .claude/worktrees/<id-lowercase>-<slug>/node_modules
```

Copy `node_modules`, never symlink it: a symlink makes
`tests/validation/hermeticity.test.ts` fail spuriously. Work only inside
that worktree from here on.

## 6. The first commit: task file and bookkeeping

1. The task file, status `IN_PROGRESS`, from `docs/tasks/TEMPLATE.md`, or
   from `docs/tasks/TEMPLATE-SHORT.md` when the specification already
   lives in a plan row, an ADR section or a decision record. When the row
   links a note file `docs/tasks/<ID>.md`, `git mv` it to
   `docs/tasks/<ID>-<slug>.md` and write the task file above its
   `## Backlog note` section, which stays last and unchanged
   (`docs/tasks/README.md`, "Naming").
2. `docs/tasks/BACKLOG.md`: this task's row `IN_PROGRESS`, its links
   following the rename; the previous task's row `MERGED`.
3. Check, then commit:

```bash
node scripts/check-docs.mjs
npx vitest run src/testing/records-limits.test.ts
git commit                               # docs(tasks): <ID> task file — <summary>
node scripts/check-commit-subjects.mjs   # AGENTS.md § H's subject rule
```

The subject is at most 72 characters; the only trailer is
`Co-Authored-By: Claude <noreply@anthropic.com>` (AGENTS.md § H).

Then implement (WORKFLOW § 1.2). The audit is the `task-audit` skill; the
finish is the `task-finish` skill.
