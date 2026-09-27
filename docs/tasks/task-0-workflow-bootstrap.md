# task-0-workflow-bootstrap — bootstrap the task-by-task workflow

## Status

- **Status**: READY_FOR_REVIEW <!-- TODO | IN_PROGRESS | BLOCKED | READY_FOR_REVIEW | MERGED | CANCELLED -->
- **Backlog ID**: `TASK-0`
- **Branch**: `task-0-workflow-bootstrap`
- **Base SHA**: `7004a05` (main after "docs: close RWF-051, record CI vs.
  local-only gates, mark task done")
- **Commits**:
  - `599f1f1` — this task file, `IN_PROGRESS`
  - `a93b89e` — `.claude/settings.json`: the allowed attribution trailer
    only
  - `8c0c768` — `docs/tasks/BACKLOG.md`; finding RWF-052 (OPEN-DEBTS D-14
    is stale); scorecard regenerated
  - `b82dcc3` — `docs/WORKFLOW.md`, `AGENTS.md` § B/D/H/J/L, `CLAUDE.md`,
    `docs/tasks/README.md` and `TEMPLATE.md`, `REMEDIATION-PLAN.md` § 10,
    the pull request template, `docs/progress.md`; backlog row BL-029
  - the commit appending ADR 0008's allowlist admission ruling and A-3's
    criteria for it, and setting this task `READY_FOR_REVIEW`
- **Superseded by**:

## Project context

VulnTrace has been built task by task, with a task file per task since
the Foundation block (`docs/tasks/README.md`), standing rules in
`AGENTS.md`, and the remediation schedule in `docs/REMEDIATION-PLAN.md`
§ 5a. What it lacks is one place that records the ORDER and STATUS of
every known task, including the work that lives only in the findings
register, the debt register, or the project owner's planning notes; and
a workflow in which the implementation agent opens the pull request and
stops for review. This task adds both, as documentation and tooling only.

The task prompt (the project owner's "task-by-task workflow" prompt,
Parts 1–9 and Appendices A–B) is the source of this file's scope. Every
factual claim in it was checked (AGENTS.md § D). Measured before this
file was written:

- **`AGENTS.md` § H says the agent never creates a PR.** True at the base
  SHA. The prompt says its own rule wins and this task removes the
  conflict. It does, in `AGENTS.md` § H.
- **`validate:metadata` requires exactly
  `Co-Authored-By: Claude <noreply@anthropic.com>`.** True:
  `scripts/validate-commit-metadata.mjs` names it as the only allowed
  attribution. The harness this task ran under did ask for a model-named
  co-author line, as the prompt warned.
- **The Claude Code setting that controls the automatic trailer.** Found
  in Claude Code's settings reference ("Git and attribution"):
  `attribution.commit`, `attribution.pr` and `attribution.sessionUrl`
  (`includeCoAuthoredBy` is deprecated). The form `attribution: false`
  needs Claude Code v2.1.281 or later and makes an older version skip the
  whole settings file, so the object form is used.
- **H-0, A-0 and task 1b "gate enforcement" are done; A-1 is next.**
  True: PRs #70, #71 and #72 are merged, and each task file says done.
- **"The README status notice: until the soundness remediation closes,
  treat NOT_AFFECTED as UNKNOWN" (Part 8).** **False.** `README.md` has
  no such notice. Its Status section says Foundation is closed and does
  not mention D-17. `docs/progress.md` states the limitation from
  OPEN-DEBTS D-17 directly instead of pointing to a notice that does not
  exist, and adding the notice is a backlog task.
- **Appendix A: `util.inspect` / `console.*` "invoke only
  `[util.inspect.custom]`".** **False when the first argument is a
  format string.** Measured with `util.format` on Node v22.11.0: `%s`,
  `%d`, `%i` and `%f` coerce the argument (`Symbol.toPrimitive`); `%j`
  runs `toJSON`, getters and Proxy `ownKeys`; only a bare object, `%o`
  and `%O` run `util.inspect.custom` alone. Recorded in that backlog
  row's notes.
- **Appendix A: the comment-premise sweeps did not read
  `module-model.ts` ~2240–2395 and `source-index.ts` 1–94.** True, per
  `docs/audits/2026-09-premise-sweep-round-2.md` § 9, with two
  qualifications: the line numbers are as of `62b52b9`, and § 9 also
  lists partially read regions (`module-resolver.ts`, `run.ts`,
  `osv-provider.ts` 1–111).
- **Appendix B, item 1 (allowlist admission ruling).** Its example was
  measured on Node v22.11.0: `JSON.parse`'s first argument fires only
  `toString`, `Symbol.toPrimitive` and Proxy `get` traps, and throws for
  every other probe kind. Its statement that the H-0 probe reports a
  throw as user code ran is true (`src/testing/oracle/builtin-probe.ts`
  records `THREW:` in `fired` and reports `ranUserCode: fired.length >
  0`).

## Task

### Problem

Task order and status are spread across the remediation plan, the
findings register, the debt register, task files and planning notes that
are not in the repository. No document says what is next after the
remediation schedule, and a fresh session cannot resume the work without
the project owner re-explaining it.

### Why it matters

Explainability of the project's own process, not analyzer behaviour. A
task that is recorded nowhere is a task nobody does; a soundness defect
recorded only in a register row with no task is the same.

### What to do

1. Inspect and report the repository state (branch, worktrees, untracked
   files, `gh`, CI gates, commit trailer) before changing anything; clean
   up only what the project owner approves.
2. Configure the project's Claude Code attribution so commits carry only
   the allowed trailer (`.claude/settings.json`).
3. Inventory every known task: the plan's § 5a schedule, every open
   finding without a task, every open OPEN-DEBTS item,
   `docs/DEFINITION-OF-DONE.md`, `remediation/v0.2/REMEDIATION-TASKS.md`,
   the README, Appendix A, and anything clearly unfinished. De-duplicate
   and keep existing IDs.
4. Create `docs/tasks/BACKLOG.md` (order, status, priority,
   dependencies, audit requirement, source, notes). Completed tasks are
   listed as MERGED.
5. Append the workflow conventions: `docs/tasks/README.md` (statuses,
   the backlog's role, the bookkeeping rule, the discovered-work rule),
   `docs/REMEDIATION-PLAN.md` (order and status now tracked in the
   backlog), `AGENTS.md` (§ H: the agent opens the PR and never merges;
   the bookkeeping rule; § J: the new end-of-task report; a pointer to
   `docs/WORKFLOW.md`).
6. Create `docs/WORKFLOW.md` (the prompt's Parts 3–9, adapted to the
   repository's real paths and commands), and make `CLAUDE.md` import it.
7. Create `docs/progress.md` and `.github/pull_request_template.md`.
8. Record Appendix B item 1 in ADR 0008 as an appended "Decision record —
   allowlist admission ruling", and add it to A-3's acceptance in the
   plan.
9. Register any defect discovered while doing this in
   `tests/validation/FINDINGS.md`, with a backlog task for its fix.

## Boundaries

### Do not touch

- Any file under `src/`, `tests/` (except `tests/validation/FINDINGS.md`,
  append-only), `scripts/`, `schemas/` or `.github/workflows/`.
- The text of any executed task file, ADR body or earlier decision
  record: append only.
- The worktree `rwf-046-require-binding-authority` (its content check
  failed; left alone as instructed) and the local branches the owner did
  not include in the cleanup.

### STOP conditions

- A gate fails for a reason this task did not cause.
- A document this task must append to contradicts the prompt in a way
  that changes a soundness rule (report `NEEDS_DECISION`).
- The allowlist admission ruling conflicts with an accepted condition in
  a way that cannot be recorded as a refinement.

## Acceptance criteria

- [x] `docs/tasks/BACKLOG.md` exists, lists every remediation task in
      § 5a order, every open finding and open debt either as its own row
      or mapped to the row that closes it, every Appendix A item (or its
      mapping to an existing task), and the completed tasks as MERGED.
- [x] Exactly one row is IN_PROGRESS (this task) until the last commit,
      which sets it to READY_FOR_REVIEW.
- [x] `docs/tasks/README.md`, `docs/REMEDIATION-PLAN.md` and `AGENTS.md`
      carry the conventions of step 5, appended without rewriting
      history.
- [x] `docs/WORKFLOW.md` exists and `CLAUDE.md` imports it alongside
      `AGENTS.md`.
- [x] `docs/progress.md` and `.github/pull_request_template.md` exist.
- [x] ADR 0008 carries the dated allowlist admission ruling, and A-3's
      acceptance in `docs/REMEDIATION-PLAN.md` includes it.
- [x] `.claude/settings.json` sets `attribution.commit` to the allowed
      trailer, and every commit on this branch passes
      `npm run validate:metadata`.
- [x] Every gate in `AGENTS.md` § I passes, or its failure is reported.

## Gates

The full set in `AGENTS.md` § I. No analyzer file changes, so graph,
proof and verdict differentials are zero by construction; the validation
suite is run anyway and compared with OPEN-DEBTS D-09's five known
failures.

## Report

The end-of-task report of `docs/WORKFLOW.md` (the prompt's Part 7).
