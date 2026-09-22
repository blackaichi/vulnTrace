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
