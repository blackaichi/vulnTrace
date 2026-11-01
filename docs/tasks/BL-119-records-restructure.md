# BL-119 — Records: one file per finding with a generated index; BACKLOG notes into task files; a one-screen check on `progress.md`; OPEN-DEBTS D-17 summarized; a next-ID script

## Status

- **Status**: IN_PROGRESS
- **Backlog ID**: BL-119
- **Branch**: `bl-119-records-restructure`
- **Base SHA**: `a3b174fa30ae3d9aee89815f5e9a43f387fc9640` (BL-118's merge, PR #124)
- **Commits**: filled in by the last commit
- **Superseded by**: —

## Specification

The row `BL-119` of [`BACKLOG.md`](BACKLOG.md) § 1, decided by the project
owner on 2026-10-27 (task `BL-116`, decision 4: "split
`tests/validation/FINDINGS.md` into one file per record" and "move
`docs/tasks/BACKLOG.md`'s notes into task files" are authorized). It asks
for five things:

1. every FINDINGS record moved verbatim into its own file, append-only per
   file, with the index and the status table generated, and every reader
   of the register (the scorecard, the docs-contract tests) reading the
   new layout; AGENTS.md § B's wording updated to match;
2. BACKLOG.md's long notes moved into task files;
3. a check that `docs/progress.md` fits one screen (WORKFLOW § 6);
4. OPEN-DEBTS D-17 summarized;
5. a script that prints the next free ID of a series.

The project owner confirmed on 2026-11-01, before this task started,
these three defaults:

- a record file per finding, carrying its own status row, and
  `FINDINGS.md` generated as the index and status table, kept current by
  an existing gate;
- D-17's full text moved verbatim to a file of its own, OPEN-DEBTS
  keeping a summary that links it;
- long notes moved into task files, with a new `TODO` task file where a
  row has none.

## Premises to verify (AGENTS.md § D)

Measured by the row on `5c8bcc3`; re-measured on the base, `a3b174f`:

1. `tests/validation/FINDINGS.md` is 1.46 MB, more than one context window
   holds.
2. BACKLOG.md is 172 KB, with notes up to 2,541 characters on one line.
3. `docs/progress.md` is 551 lines, against WORKFLOW § 6's one screen.
4. D-17 is about 1,100 lines.
5. The scorecard and the docs-contract tests read FINDINGS.md; no other
   reader needs to change.
6. Every status row has a `##` section and every section a row (the
   classifier's own check), so each record file can carry exactly its own
   row.

## Boundaries

Do not touch:

- any record's text. A record moves verbatim: the bytes of each `##`
  section and each status row are preserved, checked by a script against
  the base commit;
- the classifier's semantics: the designated `Status` field, the closed
  vocabulary, the contradicted-`Fixed` tripwire, the section/row check
  (`scripts/scorecard-sources.mjs`, RWF-047 § 6). They are applied to the
  new layout unchanged;
- analyzer code (`src/` outside `src/testing/`), any test's expected
  verdict, any gate's command or threshold;
- the other improvement tasks' scope (BL-120's skills and options script;
  BL-121's split).

STOP conditions:

- a record that cannot be moved verbatim into one file (its text
  interleaves two IDs, or a heading belongs to no record), when no
  layout keeps it whole (`NEEDS_DECISION`);
- a summary of D-17 that cannot state the debt's current status without a
  judgement the register does not make (`NEEDS_DECISION`);
- a fact recorded only in a long note or in `progress.md` that would be
  lost by the move (`STOPPED_ON_FINDING`).

## Acceptance criteria

- [ ] Every finding of the base's FINDINGS.md is in its own file under
      `tests/validation/findings/`, with its status row; the four
      non-finding sections are in files of their own. A committed script
      proves, against the base commit, that every section and every
      status row is preserved byte for byte and that nothing else of the
      base file is lost.
- [ ] `tests/validation/FINDINGS.md` is generated (status table and
      index) by `node scripts/generate-scorecard.mjs`, and
      `node scripts/generate-scorecard.mjs --check` fails when it is
      stale.
- [ ] Every reader of the register reads the new layout through one
      function: the scorecard, `open-soundness-defect.ts`, the
      binding-grammar test. The classifier's tests pass unchanged, and new
      tests make the layout's own failures loud (a file whose row names
      another ID, a file with no row, a heading of another ID).
- [ ] The scorecard's § 8 counts are unchanged.
- [ ] AGENTS.md § B, WORKFLOW § 2 and the tasks README describe the new
      layout.
- [ ] `node scripts/next-id.mjs <series>` prints the next free ID of a
      finding series and of the backlog, and never one already used
      anywhere in the repository's records.
- [ ] Every BACKLOG note over a stated length is in a task file, verbatim;
      its row links it; a test keeps notes under that length.
- [ ] D-17's full text is in its own file, verbatim; OPEN-DEBTS keeps
      D-17's heading and a summary whose counts come from the register.
- [ ] `docs/progress.md` fits one screen, and a test keeps it there; no
      fact is recorded only in the text removed from it.
- [ ] `node scripts/gates.mjs` passes in full, with the validation
      baseline unchanged.

## Gates and report

Records and tooling only: no analyzer change, so the graph, proof and
verdict differentials are expected to be zero. The report adds the
losslessness check's output.

## Account

Filled in while working.

## Backlog note

Moved verbatim from this task's row in [`BACKLOG.md`](BACKLOG.md)
by task `BL-119` (2026-11-01); the row links here.

Authorized by the owner: every FINDINGS record moved verbatim into its own file, append-only per file, with the index and status table generated (the scorecard and the docs-contract tests read it); AGENTS.md § B's wording updated to match. Measured on `5c8bcc3`: FINDINGS.md 1.46 MB (about 365k tokens, more than one context window holds); BACKLOG.md 172 KB, with notes up to 2,541 characters on one line; `progress.md` 551 lines against WORKFLOW § 6's one screen; D-17 about 1,100 lines
