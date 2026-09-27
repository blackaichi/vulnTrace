# Workflow: one task at a time, one pull request per task

How the implementation agent moves through
[`docs/tasks/BACKLOG.md`](tasks/BACKLOG.md). Added by task
[`task-0-workflow-bootstrap`](tasks/task-0-workflow-bootstrap.md), from
the project owner's workflow prompt (its Parts 3–9), adapted to this
repository's paths and commands.

[`AGENTS.md`](../AGENTS.md) stays authoritative for soundness, testing,
validation, records, git and gates. This file adds the loop around them.
Where the two disagree, `AGENTS.md` wins and this file is the one to fix.

The rules this workflow never relaxes, whatever a task seems to need:
premise verification (AGENTS.md § D, including claims in prompts, task
files and code comments); failing-first tests for a reproduced soundness
bug; loud fixtures; never pinning a wrong verdict as expected; graph,
proof and verdict differentials reported separately; a zero corpus
differential is not evidence of soundness; no relaxed thresholds or
skipped tests; fail closed to `UNKNOWN`.

## 1. The per-task loop

### 1.1 Start

1. Confirm the previous task's pull request is merged:
   `gh pr view <n> --json state,mergedAt`.
2. `git fetch origin --prune`; fast-forward `main`; the tree is clean and
   `main` equals `origin/main`. Record the base SHA.
3. Remove the previous task's worktree (if one was used) and its local
   branch: `git worktree remove <path>`, `git branch -D <branch>`, after
   checking that `git cherry main <branch>` lists no `+` commit.
4. **Reassess before choosing.** What did the last task teach? Is there
   review feedback, a newly discovered task, a changed dependency, a
   failing test, or an assumption that no longer holds? Take the next task
   from the backlog's § 1 order, but do not follow it blindly; a change of
   order is proposed to the project owner with its reason.
5. **Announce** in three to five lines: the task, why it is next, the
   recommended model and effort (design- or audit-heavy work: the most
   capable model at high effort; routine implementation: a standard
   model), and whether an independent audit is required (the backlog's
   Audit column). If the project owner asked to approve each start, wait.
6. Create the branch `<task-id-lowercase>-<short-slug>` from merged
   `main`.
7. **First commit (bookkeeping and specification):** the task file (from
   [`docs/tasks/TEMPLATE.md`](tasks/TEMPLATE.md), status `IN_PROGRESS`),
   the task's backlog row set to `IN_PROGRESS`, and the previous task's
   row set to `MERGED`. `main` changes only through pull requests, so the
   previous task's merge is recorded here.

### 1.2 Implement

- Do the task completely, within its scope (§ 2).
- For a reproduced soundness bug, write the reproduction first with the
  real-Node oracle harness (`src/testing/oracle/`, suite `tests/oracle/`,
  `npm run test:oracle`): a loud fixture, both controls, real-Node ground
  truth. Show it failing on the base commit before the fix.
- If the task closes a finding pinned as an open-soundness-defect record
  (`src/testing/open-soundness-defect.ts`), the fix must flip that record,
  and the task deletes it as the record demands and asserts the correct
  result instead.
- Update the records as AGENTS.md requires: `tests/validation/FINDINGS.md`
  (append, never rewrite), `docs/OPEN-DEBTS.md`, ADR decision records;
  regenerate the scorecard with `node scripts/generate-scorecard.mjs`
  (never hand-edit it).

### 1.3 Validate

Run § 3. Fix what the change broke. Never relax a gate.

### 1.4 Self-review

Read the full diff (`git diff main...HEAD`) for unintended changes, files
outside scope, debug leftovers, weakened tests, and comments whose premise
the change made false.

### 1.5 Independent audit

When the backlog row says `Audit: required`, launch a subagent with a
fresh context and no implementation history. Give it only the task file,
the relevant ADR and plan sections, the findings the task closes, and the
diff. Instruct it to try to break the change, not to rerun the tests:

- the exact authority source of every new or changed attribution;
- the three defect classes (AGENTS.md § F): A wrong binding identity,
  B wrong runtime-value semantics, C multi-valued provenance collapsed;
- fail-closed to `UNKNOWN`; can the change manufacture a negative proof?
- `PackageInstance` identity (a sibling borrow, not merely a lost edge);
- the differentials, the mutations, the performance structure;
- whether the documentation overclaims.

It returns `CERTIFIED` or `BLOCKED` with findings.

- `BLOCKED` on a soundness issue inside the task's scope: fix it,
  re-validate, re-audit.
- `BLOCKED` on something out of scope or needing a decision: set the task
  `BLOCKED`, report, and stop.
- The audit verdict and its findings go into the pull request body.

### 1.6 Commits

AGENTS.md § H: the task file first, then one commit per micro-task.
Formatting, scorecard regeneration, gate-driven fixes and trailer fixes
are folded into the micro-task they belong to; squash or amend your own
unpushed commits before pushing. Typically three to six commits. Every
commit builds and type-checks.

### 1.7 Last commit

Sets the backlog row and the task file to `READY_FOR_REVIEW`, records the
commits in the task file, and updates [`docs/progress.md`](progress.md).
It is part of the last micro-task's commit, not a commit of its own.

### 1.8 Push, open the pull request, report, stop

`git push -u origin <branch>`, then `gh pr create --base main` with the
body of § 4 (the template is
[`.github/pull_request_template.md`](../.github/pull_request_template.md)).
Give the end-of-task report (§ 5) and stop.

**Never:** merge a pull request; start the next task before the project
owner confirms the merge; make unrelated improvements; run two tasks at
once.

## 2. Scope and discovered work

Each task is independently understandable and reviewable. No speculative
refactoring; no unrelated work combined.

When something is discovered while working (a bug, a missing requirement,
an architectural problem, a missing test, a security issue, an edge case,
a needed refactor, a dependency or a prerequisite):

1. Decide whether it is **required** to complete the current task.
2. If it is required and keeps the task coherent and reasonably scoped,
   include it and say so in the pull request.
3. Otherwise add a backlog row: a clear title and description, why it was
   created, its priority and dependencies, and the source "discovered in
   `<task ID>`". If it changes the order of existing tasks, update their
   dependencies.
4. If it is a **defect** (the analyzer is wrong, a record is false, a
   guarantee is not enforced), also register it in
   `tests/validation/FINDINGS.md`: a status-table row and a `##` section,
   with the next free ID of the fitting series and the existing field
   format. A finding records what is wrong; a backlog row records the work
   to fix it.
5. A defect that could produce a false `NOT_AFFECTED` or a silently
   dropped finding is at least `P1`, and is stated prominently in the
   report.
6. Every discovery is listed in the report's "Newly discovered tasks".

## 3. Validation

The gate list is `AGENTS.md` § I. Take it from there, from `package.json`
and from `.github/workflows/ci.yml`, and re-check it each time; do not
invent commands. As of task `task-0-workflow-bootstrap`:

```bash
npm test
npm run test:foundation
npm run test:adversarial
npm run test:performance
npm run test:binding-grammar
npm run test:oracle
npm run test:validation      # local only: live OSV (OPEN-DEBTS D-03)
npm run typecheck
npm run lint
npm run format
npm run build
npm run validate:history
npm run validate:metadata
node scripts/generate-scorecard.mjs --check
node scripts/check-docs.mjs
```

- `npm run test:validation` queries the live OSV API and is not run in
  CI. Run it locally for any task that can move a verdict. The documented
  baseline is exactly five known failures, `RWB-03`, `RWB-05`, `RWB-09b`,
  `VAL-002` and `VAL-003` (OPEN-DEBTS D-09), compared case by case and
  verdict by verdict. Any change to that set is explained.
- `npm test` also reaches the network (OPEN-DEBTS D-03). A network
  failure is reported as one, never as a pass.
- For an analyzer change, report the graph, proof and verdict
  differentials separately. There is no shared differential tool yet
  (backlog `BL-029`); until there is, use the method in
  `docs/REMEDIATION-PLAN.md` § 9 (the validation and adversarial runners'
  `ID EXPECTED ACTUAL RESULT` tables diffed case by case, plus a finding
  dump by case, advisory and instance) and the per-task corpus scripts
  under `scripts/` as recent task files and `FINDINGS.md` do.
- If a suite exits non-zero with every test passing (a known vitest
  worker timeout under load), rerun it alone and report both runs.
- Report exactly what was run and the result of each.

## 4. Pull requests

Title: `<task ID>: <concise summary>`. Body sections, in order:

1. **Summary** — what changed.
2. **Why** — the reason; the findings or debts closed.
3. **Validation** — every gate run and its result; the differentials; the
   validation baseline.
4. **Independent audit** — the verdict and findings, or "not required:
   `<reason>`".
5. **Known limitations**.
6. **Needs human review** — anything the project owner should look at
   specifically, including "consider an external review" for the riskiest
   changes.
7. **Newly discovered tasks**.

Keep it easy to review: a small diff and a clear commit list.

**Review comments.** Read them (`gh pr view <n> --comments`; inline review
comments with `gh api repos/{owner}/{repo}/pulls/<n>/comments`). Address
them in the same pull request when appropriate, re-run validation, push,
and report what changed, what did not, and why. Do not start other work.

After the project owner confirms the merge, verify it with `gh`, then
begin § 1.1 for the next task.

## 5. End-of-task report (then stop)

```text
VERDICT: READY_FOR_REVIEW | BLOCKED | NEEDS_DECISION
1. Task completed — ID and title; each acceptance criterion
   answered yes or no
2. What changed — files and behaviour ("none" for docs/tooling)
3. Validation performed — each gate and result; differentials;
   validation baseline
4. PR — link and number
5. Anything requiring manual review — including audit findings and any
   deviation from the task spec, with the reason
6. Newly discovered tasks — each with ID, reason, priority, dependency;
   or exactly: "No new tasks discovered."
7. Current backlog summary — next 3–5 TODO tasks in order, anything
   BLOCKED, counts by status
```

## 6. `docs/progress.md`

One screen. The current objective; the implementation state in a few
lines (pointing to `docs/SCORECARD.md` and `docs/OPEN-DEBTS.md` for
numbers instead of copying them); the key architectural decisions
(pointing to the ADRs); the known limitations; the current task; the
important outstanding work; recently discovered tasks. Not a transcript.
The repository, git history, the pull requests, the backlog and this file
together let a fresh session resume without the project owner
re-explaining anything.

## 7. When to stop and ask

Stop and ask the project owner (verdict `NEEDS_DECISION`) rather than
guess when:

- a product or architectural decision is required: a precision-versus-
  soundness trade-off, an exit-code or output-schema change beyond what is
  already decided, an allowlist admission that is not clear-cut under the
  recorded ruling (ADR 0008, "Decision record — allowlist admission
  ruling"), an ADR amendment, or anything that reopens previously
  certified behaviour;
- a task's premise proves false in a way that changes its scope;
- an independent audit blocks for reasons outside the task's scope;
- the git state is unexpected (unrelated changes, diverged branches).

Do not ask for information the repository can give.
