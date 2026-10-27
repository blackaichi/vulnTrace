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
   [`docs/tasks/TEMPLATE.md`](tasks/TEMPLATE.md), or from
   [`docs/tasks/TEMPLATE-SHORT.md`](tasks/TEMPLATE-SHORT.md) when the
   specification already lives in a plan row, an ADR section or a decision
   record; status `IN_PROGRESS`),
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

#### Where each fact is written (task `BL-116`)

Say a fact once, in the record that owns it. Anywhere else that needs it
links to that record instead of restating it. A task writes:

| Record | Gets, from a task | Does not get |
| --- | --- | --- |
| the task file | the task's own account: premises verified, measurements, the audit rounds and their findings, deviations, the commits | a copy of a finding's text |
| `tests/validation/FINDINGS.md` | a new record for a defect found; an appended status or correction note on an existing record | the task's measurements beyond what the record itself needs |
| an ADR | a proposed decision, a decision record, or a note when a decided section's premise or scope changes | a note saying only that a task implemented a decision (the backlog row and the task file say it) |
| `docs/OPEN-DEBTS.md` | a change in a debt's status (opened, narrowed, closed), in that debt's entry | a per-task log line |
| `docs/tasks/BACKLOG.md` | the row's status, and new rows for discovered work | the task's results |
| `docs/progress.md` | the "Current task", "Next" and "Recently discovered" sections; a "State" line only when the phase's state changes | a per-task paragraph |
| the pull request body | § 4's sections, linking the task file for detail | — |

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

**Findings come as reproductions** (task `BL-116`). The brief also asks
for this: a finding that claims a wrong verdict, a fabricated edge or a
silently dropped finding comes with a reproduction. The implementer must
be able to turn it into an oracle case without re-deriving it. It gives:

- the project's files;
- the ground-truth command;
- the marker real Node calls or does not call;
- the analyzer's answer on the branch, and on the base when the auditor
  ran it.

A finding without a reproduction is reported as unconfirmed, and the
implementer reproduces it before acting on it.

It returns `CERTIFIED` or `BLOCKED` with findings.

- `BLOCKED` on a soundness issue inside the task's scope: fix it,
  re-validate, re-audit, within the limit below.
- `BLOCKED` on something out of scope or needing a decision: set the task
  `BLOCKED`, report, and stop.
- The audit verdict and its findings go into the pull request body.

**Round 0: the case list, before the fix** (task `BL-116`). This applies
to a task with `Audit: required` that fixes a reproduced defect or adds a
rule. Once its failing-first cases and their controls are written and
fail on the base, and before the fix:

- give a fresh-context auditor the task file, the findings the task
  closes and the case list;
- ask only one question: which forms, routes or values of the same class
  do these cases miss?

It answers with reproductions (above). Those inside the task's scope
become cases before the fix; the others are registered as § 2 says.
Round 0 does not count toward the limit.

**At most two rounds** (project owner, 2026-10-27; task `BL-116`). A
round is one fresh-context audit of the branch and the fixes it asks for.
A round that ends without a verdict (cut short) is run again and does not
count. After the second round's fixes there is no third round, unless the
project owner asks for one. Every finding still open is then handled by
one of two rules:

- **Spilled: a defect that predates the change.** It is reproduced on the
  base commit as well as on the branch. It is registered as § 2 says:
  - a FINDINGS record;
  - an open-soundness-defect record (`src/testing/open-soundness-defect.ts`)
    when it is a live false `NOT_AFFECTED` or a silently dropped finding;
  - a backlog row, `P0` for those two (§ 2, item 5).

  The pull request's audit section lists each spilled finding with its
  row, and states the last round's verdict as it was (`BLOCKED`, with
  those findings). The task can then be `READY_FOR_REVIEW`.
- **Never spilled: a defect the change introduces.** It is reproduced on
  the branch and not on the base. Examples: a verdict wrongly moved into
  `NOT_AFFECTED`, a fabricated edge, a dropped finding, a weakened gate.
  It is fixed in the task, or the change that introduced it is
  withdrawn. If neither fits the task's scope, the task is `BLOCKED`
  (§ 7). A remediation can introduce the class it was closing
  (OPEN-DEBTS D-15).

The second round's fixes are not audited again. Each one comes with its
own failing-first case, and the pull request names them under "Needs
human review", so the owner can read them specifically.

Both rounds may find instances of one class: the same rule missing
another syntactic form, route or builtin. Then the spilled row says so,
and recommends a class-level design (a closed allow-list with a
fail-closed default, as in BL-110) instead of another instance fix.

**Re-validating between audit rounds** (task `BL-089`). After a fix
between rounds, re-run only the suites the fix can affect, and the fast
gates: `node scripts/gates.mjs --only <names>` (§ 3), which labels such a
run PARTIAL. The full gate set of § 3 runs once, on the final HEAD,
before the pull request, and that run's results are the ones the report
and the pull request quote.

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
npm run test:validation      # local only: see below (OPEN-DEBTS D-03, CLOSED)
npm run typecheck
npm run lint
npm run format
npm run build
npm run validate:history
npm run validate:metadata
node scripts/generate-scorecard.mjs --check
node scripts/check-docs.mjs
```

**The recommended way to run this set locally** is one command (task
`BL-089`):

```bash
node scripts/gates.mjs                       # the whole set, then the differential
node scripts/gates.mjs --only lint,test:oracle   # a PARTIAL run (§ 1.5)
```

It runs the same gates with the same commands, in three phases, and
prints a summary of every gate's exit code, duration, test files and
tests (full output in a log per gate; the script's header documents
every option):

1. **The fast gates** — typecheck, lint, format, the scorecard check,
   check-docs, build, `validate:history`, `validate:metadata` —
   concurrently, stopping at the first failure.
2. **The test suites**, one after another (never concurrently: the
   performance guards measure wall clock), every suite with its
   `package.json` script's own vitest arguments. Each test file runs
   exactly once: `test:foundation` is a deliberate subset of `npm test`
   (CI runs both, unchanged), so after the foundation run `npm test` runs
   with those files excluded, and before any suite starts the runner
   checks, from vitest's own file lists, that no file is in two suites and
   that the two halves are exactly `npm test`'s files. `test:validation`
   passes only when exactly the cases `cases.json` marks `knownFailure`
   fail (see the next point); each failure's assertion is printed for the
   verdict-by-verdict comparison.
3. **The differential** (below), its base side cached.

Run the commands one by one only to investigate one gate; quote the
runner's summary in the report.

- `npm run test:validation` is fully offline since task `D-03` (it
  replays a recorded snapshot of real OSV answers, OPEN-DEBTS D-03,
  CLOSED) but is still not run in CI: the cases OPEN-DEBTS D-09 lists are
  deliberately kept failing and the suite exits non-zero by design. Run
  it locally for any task that can move a verdict. The documented
  baseline is D-09's table of known failures — six since task `BL-075`:
  `RWB-03`, `RWB-05`, `RWB-09a`, `RWB-09b`, `VAL-002` and `VAL-003`
  (`RWB-07` was one from task A-3a to task A-4) — compared case by case
  and verdict by verdict. Any change to that set is explained. `RWB-09a`
  is not marked `knownFailure` in `tests/validation/cases/cases.json`
  while the project owner's decision on it is pending (D-09), so the
  suite's own summary and `scripts/gates.mjs`, which reads those marks,
  report it as an unexpected failure until then (RWF-119).
- `npm test` is also fully offline since `D-03`.
- For an analyzer change, report the graph, proof and verdict
  differentials separately, with the shared tool (task `BL-029`):

  ```bash
  node scripts/differential.mjs            # base: git merge-base HEAD main
  node scripts/differential.mjs --base <ref> --corpus adversarial-v1 --case ADV-001
  ```

  It scans every case of the validation and both adversarial corpora
  twice — with the base commit's analyzer and with this working tree's —
  over the same corpus (this tree's fixtures, oracles and OSV snapshot),
  and reports the three differentials by case, advisory and exact package
  instance, plus each case's expected, base and head verdicts under the
  suites' own selectors. A graph not observed, a case not measured and a
  case on one side only are listed as such, never counted as unchanged.
  Put its summary table in the report, and the verdict and proof lines
  that moved. `scripts/differential.mjs`'s header documents the options
  and exactly what each side contains. The base side is cached (task
  `BL-089`): a later run whose base commit and every other input the base
  side reads are byte-identical reuses it, and the report says so; any
  change to those inputs collects it again, and `--no-cache` always does.
  The head side is never cached. Task-specific questions the
  corpora do not reach still need their own measurement (a per-task
  corpus script under `scripts/`, as recent task files and `FINDINGS.md`
  do).
- If a suite exits non-zero with every test passing (a known vitest
  worker timeout under load), rerun it alone and report both runs.
- Report exactly what was run and the result of each.

## 4. Pull requests

Title: `<task ID>: <concise summary>`. Body sections, in order:

1. **Summary** — what changed.
2. **Why** — the reason; the findings or debts closed.
3. **Validation** — every gate run and its result; the differentials; the
   validation baseline.
4. **Independent audit** — the rounds run (round 0 and at most two,
   § 1.5), the last verdict and its findings, and each spilled finding
   with its backlog row; or "not required: `<reason>`".
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
