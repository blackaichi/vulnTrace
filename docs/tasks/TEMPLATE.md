# <ID> — <title>

<!--
Copy to docs/tasks/<ID>.md. Delete these comments.
Once work has started, do not rewrite this file: append a Corrections
section instead (see README.md).
-->

## Status

- **Status**: planned <!-- planned | in-progress | done | superseded -->
- **Branch**: <!-- branch name, once created -->
- **Base SHA**: <!-- main at branch creation -->
- **Commits**: <!-- filled in when done: the commits implementing this task -->
- **Superseded by**: <!-- only when superseded: the replacing task file -->

## Project context

<!--
What the reader needs to understand this task without the chat that
produced it: the phase, the relevant RWF / OPEN-DEBTS entries, and the
authoritative sections that govern it (by document and section, not
restated). Every factual claim here is a premise the agent will verify
(AGENTS.md section D). Say which claims are measured and which are assumed.
-->

## Task

### Problem

<!-- What is wrong or missing, concretely. A reproduction, if one exists. -->

### Why it matters

<!--
Which priority it serves (soundness > explainability > precision >
coverage > performance). Whether it can produce a false NOT_AFFECTED.
Which defect class (A/B/C, AGENTS.md section F) it belongs to.
-->

### What to do

<!-- The steps. Include tests-first when this is a reproduced soundness bug. -->

## Boundaries

### Do not touch

<!-- Files, directories, documents, branches and worktrees that are out of bounds. -->

### STOP conditions

<!--
Situations where the agent stops and reports STOPPED_ON_FINDING or
NEEDS_DECISION instead of guessing.
-->

## Acceptance criteria

<!-- Each one answerable yes/no, and checkable by an auditor from the branch. -->

- [ ] ...
- [ ] ...

## Gates

The full set in `AGENTS.md` section I, unrelaxed. List additions and
expected results specific to this task, for example the expected
differentials or the validation baseline (OPEN-DEBTS D-09).

## Report

In the format of `AGENTS.md` section J, in exactly that order. Add any
task-specific report items here.
