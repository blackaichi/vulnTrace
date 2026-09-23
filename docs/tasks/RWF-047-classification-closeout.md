# RWF-047-classification-closeout — close out the RWF-047 classification branch

## Status

- **Status**: in-progress
- **Branch**: `rwf-047-classification`
- **Base SHA**: `2e7aaaf4291474dd224c09316f963529863c1d33` (main after the
  AGENTS.md rewrite and `docs/tasks/` were merged)
- **Commits**:
- **Superseded by**:

## Project context

RWF-047 (`tests/validation/FINDINGS.md`): a member of a module object keeps
its static export attribution after the program writes to that member.
`const mod = require("pkg"); mod.run = patched; mod.run();` resolves to
`pkg#run`. `isMemberAssignedWithin` invalidates member writes on
object-literal receivers, but not on require-bound or ESM-default-bound
module objects.

The branch `rwf-047-classification` (originally based on `a40ce49`)
classified this as a class-B soundness defect (AGENTS.md section F),
reproduced both directions (false `AFFECTED`, and a false `NOT_AFFECTED`
carrying a complete Family C proof), established real-`node` ground truth
in `fixtures/require-member-write-ground-truth/`, opened
`docs/OPEN-DEBTS.md` D-16, stated that OPEN-DEBTS § 3 criterion 3 is false
on `main`, corrected hardcoded prose in `scripts/generate-scorecard.mjs`,
and reworded RWF-047's FINDINGS status row to avoid a scorecard classifier
defect. That classifier defect is a separate task.

Premises to verify (AGENTS.md section D):

- since `a40ce49`, `main` changed only a comment in `named-bindings.ts`,
  AGENTS.md, CLAUDE.md, `docs/tasks/` and one README.md row, and this
  branch touches none of them (assumed; verify at rebase);
- the branch's gates were green while its tests reproduce a false verdict
  (assumed; verify by running the tests).

## Task

### Problem

A green test that reproduces a false verdict either asserts correct
behaviour (a), asserts the correct verdict with the wrong result recorded
as a known disagreement (b), or asserts the wrong verdict as its expected
outcome (c). (c) violates AGENTS.md section G ("never pin a wrong verdict
as a test's expected outcome") and would have to be inverted by the fix.

### Why it matters

Soundness. RWF-047 reaches a false `NOT_AFFECTED`. A test that pins the
wrong verdict makes the defect's presence part of the green gate, so the
record of the defect reads as a specification of it.

### What to do

1. Preconditions: fetch, fast-forward `main`, record SHAs, check that
   `main` has the AGENTS.md rewrite and `docs/tasks/`, check the worktree
   lock state. If the branch is checked out in a locked worktree, work in
   a new worktree detached at `origin/rwf-047-classification` and push
   with `git push origin HEAD:rwf-047-classification`.
2. Rebase the branch onto current `main`, keeping every commit.
3. Commit this task file first, `in-progress`.
4. Inventory every test the branch added or changed and classify it
   (a)/(b)/(c).
5. For each (c): assert the correct verdict, record the exact observed
   wrong result (verdict, proof family, target) separately, fail if the
   observation changes in any way (fixed or drifted), reference RWF-047
   and D-16. Prefer an existing repository mechanism
   (`tests/adversarial/`). No bare `test.fails` / `it.fails`. Not through
   `tests/binding-grammar/disagreements.ts`.
6. Verify FINDINGS (class B, both directions), D-16, and § 3 criterion 3
   stated plainly. If any test was restructured, say in the RWF-047
   record how its reproductions are pinned, in place with a pointer.

## Boundaries

### Do not touch

- any file under `src/` (no production change of any kind);
- the RWF-047 fix;
- `scripts/scorecard-sources.mjs`, and the RWF-047 status-row rewording;
- `tests/binding-grammar/`, or its guard;
- RWF-044, RWF-006, RWF-001, RWF-048, RWF-049, VT-217;
- any locked worktree.

### STOP conditions

- the rebase conflicts in a way that needs a semantic choice;
- a reproduction test cannot be restructured without a production change;
- any differential moves.

## Acceptance criteria

- [ ] Branch rebased onto current main; all original commits preserved
- [ ] Task file committed first (in-progress) and marked done at the end
- [ ] Every test added by the branch inventoried and classified (a)/(b)/(c)
- [ ] No test asserts a wrong verdict as its expected outcome
- [ ] Every known-failing reproduction fails if the defect is fixed OR
      drifts, and references RWF-047 and D-16
- [ ] `tests/binding-grammar/` untouched; its guard unchanged
- [ ] FINDINGS.md, D-16 and § 3 criterion 3 state the classification
      plainly and match the tests
- [ ] No file under `src/` changed
- [ ] All three differentials zero; all gates green; validation at exactly
      the five documented failures
- [ ] Pushed; no PR; no merge; no forbidden commit metadata

## Gates

The full set in `AGENTS.md` section I, unrelaxed. Graph, proof and verdict
differentials all zero against current `main` (tests and docs only).
`npm run test:validation` at exactly the five documented failures with
identical verdicts: RWB-03, RWB-05, RWB-09b, VAL-002, VAL-003. Regenerate
the scorecard if the test-file count moves.

## Report

In the format of `AGENTS.md` section J. Item 2 additionally names the
branch SHA before and after, and the worktree method used. Item 4 carries
the inventory table and, for each restructured test, before and after and
proof that it fails when the observation changes.

## Corrections

### 2026-09-23 — the boundaries enclose both files that need restructuring

**What was wrong.** The rebase premise held: the branch touches none of the
paths `main` changed since `a40ce49`. But the task is self-contradictory as
written: step 5 of "What to do" requires restructuring every case (c) test,
while "Do not touch" places `src/` and `tests/binding-grammar/` out of
bounds, and both of the branch's own reproduction test files live there.
Measured (`git diff --stat origin/main HEAD`):

- `src/analysis/verdict.require-member-write-authority.integration.test.ts`
  (verdict level, 8 tests), and
- `tests/binding-grammar/require-member-write.test.ts` (graph level, 14
  tests).

The rebase itself was clean (no conflicts; `git range-diff` shows every
commit patch-identical).

**What was measured instead.** Both files are green on the rebased branch
and both contain case (c) assertions: `expected` is defined as "what the
analyzer does TODAY", and the wrong results are asserted directly (for
example `expect(outcome.verdict).toBe("AFFECTED")` over an export `node`
never enters, and `toBe("NOT_AFFECTED")` with `family` `"C"` over an export
`node` executes). Restructuring them requires editing a file under `src/`
and a file under `tests/binding-grammar/`. That is outside this task's
boundaries, so per AGENTS.md section D, step 5 of "What to do" was not
executed and the task stopped with `NEEDS_DECISION`. The report carries the
full inventory.

### 2026-09-23 — boundary amended by user decision

The "no file under `src/`" boundary was meant as "no production code". This
repository co-locates tests under `src/`, so the literal boundary forbade
the very edit step 5 requires. By user decision the boundaries are amended
as follows, and the task resumes from step 5:

- **May edit, test-only:**
  `src/analysis/verdict.require-member-write-authority.integration.test.ts`,
  and `tests/binding-grammar/require-member-write.test.ts`, which is
  **moved** out of `tests/binding-grammar/` next to the integration test.
  The binding-grammar suite's contract is that a wrong `EXACT` fails
  unconditionally, so a record of a known wrong `EXACT` must not live
  inside that suite.
- **Still must not change:** any non-test file under `src/`;
  `tests/binding-grammar/` `disagreements.ts`, `matrix.ts`, `harness.ts`,
  `guard.ts`, `guard.test.ts`, `binding-grammar.test.ts`, or the guard's
  behaviour; `scripts/scorecard-sources.mjs` or the RWF-047 status-row
  rewording; any locked worktree. Generated files may be regenerated,
  never hand-edited.
- **Added:** a separate open-soundness-defect record mechanism (not shared
  with `disagreements.ts`) holding `admissible`, `expected`, `observed`,
  `rwf` and `debt` per case, with a self-test of its four rejection cases.
  Expected outcomes: step 1 (false `AFFECTED`) admissible
  `{UNKNOWN, NOT_AFFECTED}`, expected `UNKNOWN`; step 2 (false
  `NOT_AFFECTED`) admissible `{UNKNOWN, AFFECTED}`, expected `UNKNOWN`;
  graph rows W1–W6 and W8 admissible a refusal or an `EXACT` to the real
  declaration of the written value, expected a refusal, no reason code
  pinned.
