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
