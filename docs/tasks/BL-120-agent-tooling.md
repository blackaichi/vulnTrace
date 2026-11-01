# BL-120 — Agent tooling: project skills to start a task, finish it and launch an audit; a reusable options-measurement script; a check on commit subjects

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-120
- **Branch**: `bl-120-agent-tooling`
- **Base SHA**: `d54511e91ccae8bb1d6139fc1a7d3a225594ecc1` (BL-119's merge, PR #125)
- **Commits**: <!-- filled in by the last commit (READY_FOR_REVIEW) -->
- **Superseded by**: —

## Specification

The row `BL-120` of [`BACKLOG.md`](BACKLOG.md) § 1, one of the improvement
tasks the project owner placed first on 2026-10-27 (task `BL-116`,
decision 3). Its note (the last section of this file) asks for three
things:

1. WORKFLOW § 1.1's start bookkeeping, § 1.7's finish bookkeeping and
   § 1.5's audit brief, as project skills in `.claude/skills/`;
2. one script that measures option prototypes (patches against a base)
   the way BL-094, BL-096, BL-111 and BL-114 each did by hand: files and
   packages flagged, corpus verdicts moved, validation proofs lost,
   controls lost;
3. the finish step checks AGENTS.md § H's 72-character commit subjects.

## Premises to verify (AGENTS.md § D)

Measured on the base, `d54511e`:

1. BL-094, BL-096, BL-111 and BL-114 each measured their options by hand,
   with per-task tooling under `scripts/bl094-escape-options/`,
   `scripts/bl096-module-paths-options/`,
   `scripts/bl111-loader-writes-options/` and
   `scripts/bl114-loader-inventory-releases/`, and report the four
   quantities the row names.
2. The open-soundness-defect records and the controls can be told apart
   from a vitest report alone, without per-task knowledge.
3. AGENTS.md § H's subject rule (at most 72 characters,
   `<type>(<task ID>): <summary>`) holds for every commit since it was
   made (task `BL-116`), and earlier history is not rewritten.
4. BL-119's layout (one file per finding, `next-id.mjs`, note files) is
   merged, so the skills can cite it.
5. Claude Code loads a project skill from `.claude/skills/<name>/SKILL.md`,
   and `.claude/skills/` is not git-ignored.

## Boundaries

Do not touch:

- analyzer code (`src/` outside `src/testing/`), any test's expected
  verdict, any gate's command or threshold, CI;
- the rules themselves: the skills apply AGENTS.md and WORKFLOW.md and
  cite them by section; they restate no rule and decide nothing the two
  documents do not;
- the per-task measurement directories of BL-094, BL-096, BL-111 and
  BL-114, which are records of what was measured then;
- the other improvement task's scope (BL-121's split).

STOP conditions:

- a step of the workflow that a skill cannot carry out without a
  decision the workflow leaves open (`NEEDS_DECISION`);
- a commit on `main` since BL-116 that breaks the subject rule, so the
  check would need a baseline the owner has not chosen
  (`NEEDS_DECISION`).

## Acceptance criteria

- [ ] `.claude/skills/` holds three skills: start a task (WORKFLOW § 1.1),
      finish it (§ 1.6–§ 1.8 and § 5, with § 1.7's bookkeeping) and brief
      an independent audit (§ 1.5, round 0 and the rounds); each cites
      the sections it applies, and `node scripts/check-docs.mjs` reviews
      their paths and `npm run` names.
- [ ] `node scripts/check-commit-subjects.mjs` checks every commit the
      branch adds against AGENTS.md § H's subject rule (length and shape),
      exits non-zero on a violation, and is unit-tested without git; the
      finish skill runs it before pushing.
- [ ] `node scripts/measure-options.mjs` measures any number of option
      patches against a base, each in a detached worktree with
      `node_modules` copied, one after another, and reports per option:
      the oracle records flipped or drifted, the controls lost, the graph,
      proof and verdict differentials (verdicts into `NOT_AFFECTED`
      named), the suites' `NOT_AFFECTED` proofs lost by corpus, and,
      given a predicate, the files and packages flagged. Its comparison
      logic is unit-tested; one end-to-end run on a small patch is
      recorded below.
- [ ] WORKFLOW.md points to the skills and the script where it describes
      the steps they carry out.
- [ ] `node scripts/gates.mjs` passes in full, with the validation
      baseline unchanged.

## Gates and report

Tooling and documentation only: no analyzer change, so the graph, proof
and verdict differentials are expected to be zero.

## Account

<!-- Filled in while working. -->

## Backlog note

Moved verbatim from this task's row in [`BACKLOG.md`](BACKLOG.md)
by task `BL-119` (2026-11-01); the row links here.

WORKFLOW § 1.1's start and § 1.7's finish bookkeeping and § 1.5's audit brief, as skills in `.claude/skills/`. One script that measures prototype patches the way BL-094, BL-096, BL-111 and BL-114 each did by hand: files and packages flagged, corpus verdicts moved, validation proofs lost, controls lost. The finish step checks AGENTS.md § H's 72-character subjects. Depends on BL-119's layout
