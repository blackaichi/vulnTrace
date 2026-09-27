# Task files

A task file is the **specification** a coding agent executes, and the
specification an auditor checks the implementation against. It lives in the
repository, so the question "what was this branch asked to do?" has an
answer that does not depend on a chat transcript.

Standing rules that apply to every task (source-of-truth order, soundness
rules, git workflow, gates, report format) are in
[`AGENTS.md`](../../AGENTS.md). A task file does not restate them. It
states what is specific to one task.

## Naming

One file per task, named `<ID>.md`, where the ID is the task's own
identifier. For example: `RWF-047-fix.md`.
Use the RWF, VT or phase identifier the task is tracked under, plus a short
suffix when one identifier has several tasks.

Start from [`TEMPLATE.md`](TEMPLATE.md).

## Workflow

1. Write the task file with `Status: planned`.
2. On the task's branch (created from merged `main`, per `AGENTS.md`
   section H), the task file is the **first commit**. Set
   `Status: in-progress` in that commit.
3. The work follows, in logical commits.
4. When the work is done, a final commit on the same branch sets
   `Status: done` and records the branch and the commits that implement
   the task.

Because the task file comes first on the branch, the diff of every later
commit can be read against the specification it was written to meet.

## Status field

| Status | Meaning |
| --- | --- |
| `planned` | written, not started |
| `in-progress` | committed on its branch; work under way |
| `done` | executed; links to the branch and its commits |
| `superseded` | replaced by another task; links to the replacement |

## Once executed, a task file is not rewritten

A task file records what was asked. After work has started against it, its
original text stays as written, even if it turns out to be wrong. If it
contained a false premise, an impossible criterion or a changed decision,
append a dated **Corrections** section at the end. Say what was wrong, what
was measured instead, and where the deviation is reported. This is the
same append-only discipline as `tests/validation/FINDINGS.md`.

## History

The MVP was built from 30 task files in `docs/history/tasks/`
(`NNN-slug.md`: Goal, Read first, Acceptance Criteria, Constraints,
Completion report). That folder is a frozen archive. Its README calls it
"not active guidance", and `npm run validate:history` requires it to hold
exactly those 30 files. New task files go here instead. The format is
adapted from the MVP one: acceptance criteria and the completion report
are kept, and a status, project context, explicit boundaries and STOP
conditions are added.

## The backlog and the workflow (added 2026-09-27)

Added by task [`task-0-workflow-bootstrap`](task-0-workflow-bootstrap.md).
The sections above are unchanged and still apply; this section adds to
them.

**The backlog.** [`BACKLOG.md`](BACKLOG.md) is the single source of truth
for task **order** and **status**. It lists every known task, including
the completed ones, and points to the specification of each: a
remediation task's row in `docs/REMEDIATION-PLAN.md` and its ADR, or the
task's own file here. It copies no specification.

**Statuses.** New task files and the backlog use these statuses. The
four in the table above are the legacy vocabulary; an old task file keeps
its own and is not rewritten.

| Status | Meaning | Legacy equivalent |
| --- | --- | --- |
| `TODO` | known, not started | `planned` |
| `IN_PROGRESS` | its branch exists; work under way. One task at a time | `in-progress` |
| `BLOCKED` | started, and stopped on something outside its scope or awaiting a decision | — |
| `READY_FOR_REVIEW` | its pull request is open, awaiting the project owner | — |
| `MERGED` | its pull request is merged | `done`, once its PR is merged |
| `CANCELLED` | will not be done, or replaced by another task (link it) | `superseded` |

**Bookkeeping rule.** A task's first commit is its task file (status
`IN_PROGRESS`) together with its backlog row set to `IN_PROGRESS` and the
previous task's row set to `MERGED`. `main` changes only through pull
requests, so the previous task's merge is recorded by the next task. The
task's last micro-task commit sets its row and its task file to
`READY_FOR_REVIEW` and updates `docs/progress.md`. Rows are never
deleted.

**Discovered work.** Work found while doing a task that the task does not
require gets a backlog row (priority, dependencies, and the source
"discovered in" plus the task's ID), rather than being folded in. A
discovered defect is also registered in `tests/validation/FINDINGS.md`.
The full rule is in [`docs/WORKFLOW.md`](../WORKFLOW.md) § 2; the rest of
the loop is in the same file.
