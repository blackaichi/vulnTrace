# BL-120 — Agent tooling: project skills to start a task, finish it and launch an audit; a reusable options-measurement script; a check on commit subjects

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-120
- **Branch**: `bl-120-agent-tooling`
- **Base SHA**: `d54511e91ccae8bb1d6139fc1a7d3a225594ecc1` (BL-119's merge, PR #125)
- **Commits**:
  - `docs(tasks): BL-120 task file — agent tooling`
  - `build(BL-120): check the branch's commit subjects (AGENTS.md § H)`
  - `build(BL-120): measure-options — option patches measured against a base`
  - (this commit) `docs(BL-120): skills to start, finish and audit a task; records`
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

- [x] `.claude/skills/` holds three skills: start a task (WORKFLOW § 1.1),
      finish it (§ 1.6–§ 1.8 and § 5, with § 1.7's bookkeeping) and brief
      an independent audit (§ 1.5, round 0 and the rounds); each cites
      the sections it applies, and `node scripts/check-docs.mjs` reviews
      their paths and `npm run` names.
- [x] `node scripts/check-commit-subjects.mjs` checks every commit the
      branch adds against AGENTS.md § H's subject rule (length and shape),
      exits non-zero on a violation, and is unit-tested without git; the
      finish skill runs it before pushing.
- [x] `node scripts/measure-options.mjs` measures any number of option
      patches against a base, each in a detached worktree with
      `node_modules` copied, one after another, and reports per option:
      the oracle records flipped or drifted, the controls lost, the graph,
      proof and verdict differentials (verdicts into `NOT_AFFECTED`
      named), the suites' `NOT_AFFECTED` proofs lost by corpus, and,
      given a predicate, the files and packages flagged. Its comparison
      logic is unit-tested; one end-to-end run on a small patch is
      recorded below.
- [x] WORKFLOW.md points to the skills and the script where it describes
      the steps they carry out.
- [x] `node scripts/gates.mjs` passes in full, with the validation
      baseline unchanged.

## Gates and report

Tooling and documentation only: no analyzer change, so the graph, proof
and verdict differentials are expected to be zero.

## Account

### Premises, as verified

1. **True.** The four directories exist on `d54511e`. BL-094's
   `measure.sh` ran the oracle suite, the differential and a corpus walk
   per patch; BL-096's and BL-111's `census.mjs` counted files and
   packages; BL-111's `results.md` tabulates files and packages flagged,
   verdicts moved, validation proofs lost and controls lost; BL-114
   re-measured BL-111's patches.
2. **Partly false.** The fixed words of `openSoundnessDefectProblems`
   ("is now ADMISSIBLE", "the defect DRIFTED") do tell a flipped record
   from a drifted one and from a lost control, but vitest's JSON
   reporter does not carry them: a record is asserted as
   `expect(problems).toEqual([])`, and the report keeps only
   `expected [ Array(1) ] to deeply equal []`. Measured on BL-111's
   `B.patch`: the six RWF-156 records were classified as lost controls.
   The script therefore runs the oracle suite under its own reporter,
   `scripts/measure-options-reporter.mjs`, which keeps each failure's
   asserted value; no test was changed.
3. **True.** All 18 commits from `de8af14` (BL-116's first) to `d54511e`
   pass `node scripts/check-commit-subjects.mjs`, task by task
   (`--base`/`--head` per task); the longest is 71 code points. The
   earlier measurement with `awk` counted bytes (an em dash is three),
   which is why the policy counts code points. BL-096's three subjects
   (113 to 163 characters) fail it, as they should.
4. **True.** BL-119 is merged (PR #125).
5. **True.** `.gitignore` ignores only `.claude/worktrees/`;
   `.claude/settings.json` is already tracked.

### What was built

- **Skills** (`.claude/skills/`): `task-start` (WORKFLOW § 1.1),
  `task-finish` (§ 1.3–§ 1.8, § 5), `task-audit` (§ 1.5: round 0, the
  rounds' brief, after round 2). Each cites the sections it applies and
  defers to them. The audit skill says to launch a new agent, never a
  fork, since a fork inherits the implementation history. All three are
  in `check-docs.mjs`'s reviewed set (12 documents now).
- **Commit subjects**: `scripts/commit-subject-policy.mjs` (pure, with
  `src/testing/commit-subject-policy.test.ts`) and
  `scripts/check-commit-subjects.mjs` (`<base>..HEAD`, merges excluded).
  The scope is the task's ID, or `tasks` with a summary starting with the
  ID; one task per branch; the ten types history uses. It is run by the
  finish skill, not added to AGENTS.md § I's gates (earlier history is not
  rewritten, and no gate was asked for).
- **`scripts/measure-options.mjs`**, with its pure comparison in
  `scripts/measure-options-lib.mjs` (reusing `differential-lib.mjs`'s
  `summarize`) and its reporter; `src/testing/measure-options-lib.test.ts`
  drives both from synthetic reports, including the real message
  `openSoundnessDefectProblems` writes.
- **WORKFLOW.md** points to the skills in § 1.1, § 1.5 and § 1.7, and to
  the script in § 3.

### The end-to-end run

`node scripts/measure-options.mjs` on BL-111's `B.patch` against
`d54511e`, with the oracle file `tests/oracle/bl096-module-paths-read-only.test.ts`,
the cases `RWB-07, RWB-11a, RWB-11b, ADV2-085, ADV-001`, and BL-111's
census predicate over five packages (`semver`, `yaml`, `ajv`,
`picomatch`, `minimatch`). About 85 s per side.

| | base | `B` | BL-111's `results.md` for (B) |
| --- | ---: | ---: | --- |
| open records flipped | — | 6 | RWF-156's 6 records `UNKNOWN` |
| controls lost | — | 4 (the `sound.*` cases) | 4 BL-096 `sound.*` controls lost |
| verdicts changed (into `NOT_AFFECTED`) | — | 4 (0): `ADV2-085`, `RWB-07`, `RWB-11a`, `RWB-11b` | the same 4, 0 |
| proof differential | — | 4 | 4 findings |
| graph differential | — | 0 | 0 |
| `validation` `NOT_AFFECTED` proofs lost | — | 2 of 2 (`RWB-07`, `RWB-11b`) | 2 (the same) |
| census: files / packages flagged | unavailable | 85 of 315 / 4 of 5 | (other roots) |

The census is "unavailable" on the base because its build has no
`fileMayRedirectLoader`: the case the script reports instead of a zero.
The first run, before the reporter, reported the six records as lost
controls (premise 2). The flipped and lost rows above are from the
second run, oracle only; the rest from the first.

### Deviations

- Premise 2 (above): a reporter of the script's own, instead of vitest's
  JSON reporter.
- `check-commit-subjects.mjs` takes `--head`, so a merged task's range can
  be checked without a checkout.

### Audit

Not required (backlog: `Audit: no`; tooling and documentation only).

## Backlog note

Moved verbatim from this task's row in [`BACKLOG.md`](BACKLOG.md)
by task `BL-119` (2026-11-01); the row links here.

WORKFLOW § 1.1's start and § 1.7's finish bookkeeping and § 1.5's audit brief, as skills in `.claude/skills/`. One script that measures prototype patches the way BL-094, BL-096, BL-111 and BL-114 each did by hand: files and packages flagged, corpus verdicts moved, validation proofs lost, controls lost. The finish step checks AGENTS.md § H's 72-character subjects. Depends on BL-119's layout
