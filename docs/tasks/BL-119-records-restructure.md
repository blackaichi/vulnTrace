# BL-119 — Records: one file per finding with a generated index; BACKLOG notes into task files; a one-screen check on `progress.md`; OPEN-DEBTS D-17 summarized; a next-ID script

## Status

- **Status**: READY_FOR_REVIEW
- **Backlog ID**: BL-119
- **Branch**: `bl-119-records-restructure`
- **Base SHA**: `a3b174fa30ae3d9aee89815f5e9a43f387fc9640` (BL-118's merge, PR #124)
- **Commits**:
  - `docs(tasks): BL-119 task file — records restructure`
  - `docs(BL-119): findings register, one file per record; next-id`
  - `docs(BL-119): BACKLOG notes over 300 characters into task files`
  - `docs(BL-119): OPEN-DEBTS D-17 summarized; full record in its own file`
  - (this commit) `docs(BL-119): progress.md on one screen; records`
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

- [x] Every finding of the base's FINDINGS.md is in its own file under
      `tests/validation/findings/`, with its status row; the four
      non-finding sections are in files of their own. A committed script
      proves, against the base commit, that every section and every
      status row is preserved byte for byte and that nothing else of the
      base file is lost.
- [x] `tests/validation/FINDINGS.md` is generated (status table and
      index) by `node scripts/generate-scorecard.mjs`, and
      `node scripts/generate-scorecard.mjs --check` fails when it is
      stale.
- [x] Every reader of the register reads the new layout through one
      function: the scorecard, `open-soundness-defect.ts`, the
      binding-grammar test. The classifier's tests pass unchanged, and new
      tests make the layout's own failures loud (a file whose row names
      another ID, a file with no row, a heading of another ID).
- [x] The scorecard's § 8 counts are unchanged.
- [x] AGENTS.md § B, WORKFLOW § 2 and the tasks README describe the new
      layout.
- [x] `node scripts/next-id.mjs <series>` prints the next free ID of a
      finding series and of the backlog, and never one already used
      anywhere in the repository's records.
- [x] Every BACKLOG note over a stated length is in a task file, verbatim;
      its row links it; a test keeps notes under that length.
- [x] D-17's full text is in its own file, verbatim; OPEN-DEBTS keeps
      D-17's heading and a summary whose counts come from the register.
- [x] `docs/progress.md` fits one screen, and a test keeps it there; no
      fact is recorded only in the text removed from it.
- [x] `node scripts/gates.mjs` passes in full, with the validation
      baseline unchanged.

## Gates and report

Records and tooling only: no analyzer change, so the graph, proof and
verdict differentials are expected to be zero. The report adds the
losslessness check's output.

## Account

### Premises, as verified

1. **True.** On `a3b174f`, `FINDINGS.md` is 1,461,022 bytes, 24,801 lines.
2. **Drifted, direction true.** On `a3b174f`, BACKLOG.md is 174,733 bytes
   and its longest note 2,109 characters (BL-110). On `5c8bcc3`, the
   longest note measures 2,343 characters (BL-113), not 2,541; the row's
   own method is not recorded.
3. **Drifted, direction true.** `progress.md` is 587 lines on `a3b174f`,
   574 on `5c8bcc3` (not 551).
4. **True.** D-17 is 1,106 lines (OPEN-DEBTS lines 670–1775 on the base).
5. **Incomplete.** The scorecard reads the register
   (`readFindingsRegister`), and the docs-contract test reaches it only
   through `generate-scorecard.mjs --check`. Two more readers read
   `FINDINGS.md` directly: `src/testing/open-soundness-defect.ts`
   (`loadDefectRegisters`, which every open-soundness-defect record
   uses) and `tests/binding-grammar/binding-grammar.test.ts`. All of them
   now read through one function. `check-docs.mjs` does not read it.
6. **True.** 230 status rows and 230 ids with sections. 236 finding
   sections, because five ids have more than one (`RWF-032` three;
   `RWF-033`, `RWF-043`, `RWF-045`, `RWF-047` two: corrections and
   status updates, each headed with the id). Four sections carry no id
   (two benchmark notes, "Precision limit", "P0-Z remediation"); none is
   inside a code fence.

### The findings register

- **Layout.** `tests/validation/findings/<ID>.md`: the status table's
  header and separator, the finding's row, an empty line, then its
  sections in base order. `findings/notes/` holds the four sections that
  record no finding; `findings/README.md` holds the base's preamble and
  status prose verbatim, and the rules: the row is the one line edited in
  place, everything below it is append-only, every `##` heading carries
  the file's id.
- **One reader.** `readFindingsRegisterText`
  (`scripts/findings-register.mjs`) assembles the rows and sections into
  the text `classifyFindingsRegister` has always read. The classifier,
  its vocabulary, tripwire and section/row check are unchanged. A file
  the layout does not admit is an error naming it, never skipped.
- **The index.** `generate-scorecard.mjs` writes `FINDINGS.md` (the
  status table in id order, then an index of every record's sections and
  every note) and `--check`s it, so the existing gate keeps it current;
  AGENTS.md § I's label says so. 1.46 MB -> 146 KB.
- **Proof of the move.** `node scripts/bl119-split-findings.mjs verify`
  (against `a3b174f`): the base file is its preamble plus 241 sections,
  byte for byte; 230 record files are each exactly their row plus their
  236 sections (1,311,097 bytes); 230 rows, each in one file, verbatim;
  the 4 notes byte-identical; the preamble and the status prose in the
  README verbatim.
- **§ 8 unchanged.** Classified on the base and on the branch: open 59,
  open in part 12, fixed 159, the same ids with the same Status cells in
  each. Only the order of the ids in § 8 changed, since the table is now
  in id order (series `RWF`, `AUD`, `PRM`, as the base table listed
  them).
- **`next-id`.** One past the highest of the register's ids and every
  mention of the series in the repository's markdown. Code is not
  scanned: its tests use synthetic ids (`RWF-900`, `D-99`). On this
  branch: `RWF-161`, `PRM-119`, `AUD-17`, `BL-122`, `D-18`.

### BACKLOG notes

`NOTE_LIMIT` is 300 characters (`scripts/records-limits.mjs`). 96 of 244
notes of § 1 and § 3 were longer: 30 were appended to their task files,
66 went into new note files (`docs/tasks/<ID>.md`); none had two
candidate files. `node scripts/bl119-move-backlog-notes.mjs verify --base
<the commit before>`: every row present, its other cells byte-identical,
each long note verbatim in the file its row links, every other line
unchanged. BACKLOG.md 175 KB -> 123 KB. § 2 is a finding-to-row map with
no notes, and is unchanged. BL-119's own note was over the limit too, and
is at the end of this file.

### D-17

Moved verbatim to `docs/open-debts/D-17.md` (heading identical, lines
before and after the span unchanged, checked against the base);
`check-docs.mjs` reviews it as it reviews OPEN-DEBTS. The summary's two
lists come from the register, not from the prose: the audits' own open
findings are the register's open `AUD`/`PRM` rows, and the family's
further findings are the record's running list as its notes left it:
the list BL-105's note states, then RWF-151 added by BL-094 and removed
by BL-109, RWF-154 to RWF-157 added by BL-096, RWF-136 and RWF-154
removed by BL-110, RWF-158 and RWF-160 added by BL-114. Each of the 24 is
open or open in part in the register.
`src/testing/open-debts-summary.test.ts` keeps both true. The summary's
first draft said "lanes A, V and B are merged"; A-7 is not, and it was
corrected before commit. OPEN-DEBTS.md 1,890 -> 849 lines.

### progress.md

587 -> 59 lines; `PROGRESS_MAX_LINES` is 60. Before cutting, every one of
the 245 ids the old file named was checked to be registered (a record, a
backlog row or a debt), and seven distinctive claims of its "Recently
discovered" section were each found in a finding record or a task file.
The "State" history and the discovery recaps restated task files, which
WORKFLOW § 1.2 says to link instead.

### Mutations

Each was applied, caught by the named test, and reverted:

| Mutation | Caught by |
| --- | --- |
| the reader skips every `PRM-` file | `findings-register.test.ts`, "reads every file in the directory: none is skipped" (and "is what FINDINGS.md was generated from") |
| a heading of another id admitted | "is refused when a section carries another id's heading" |
| a row of another id admitted | "is refused when its row names another id" |
| one byte of `RWF-047.md` changed | `bl119-split-findings.mjs verify` |
| a long note put back in its row | `records-limits.test.ts`, "are at most 300 characters" |
| a fixed `PRM-12` listed open in D-17 | `open-debts-summary.test.ts`, "names exactly the audits' own findings" |
| a fixed `RWF-151` listed in D-17's family | "names only findings of the family the register still holds open" |
| `progress.md` padded past 60 lines | `records-limits.test.ts`, "fits one screen" |

### Deviations and inclusions

- The many citations of `FINDINGS.md` as the register's name (code
  comments, error messages, other documents) are kept: the generated
  index resolves each id to its file. Only the documents that tell an
  agent how to write a record changed (AGENTS.md § B, § K; WORKFLOW
  § 1.2, § 2; the tasks README).
- The status table is generated in id order, not the base's insertion
  order.
- Included, as required by moving notes out: WORKFLOW § 1.1 step 7 and
  § 2 item 3 and the tasks README ("Naming") say where a long note goes
  and how a note file becomes the task file. The limits are checked by a
  test, so the two records do not grow back.
- Not acted on: `progress.md`'s former "Next" put `BL-115`, `BL-107` and
  others right after `BL-113`, while BACKLOG § 1's rows after `BL-113` are
  `BL-068`, `BL-069` and on. The order is the owner's; the new "Next"
  defers to § 1 and names only the rows both agree on.

### Audit

Not required (backlog: `Audit: no`; records and tooling only).

## Backlog note

Moved verbatim from this task's row in [`BACKLOG.md`](BACKLOG.md)
by task `BL-119` (2026-11-01); the row links here.

Authorized by the owner: every FINDINGS record moved verbatim into its own file, append-only per file, with the index and status table generated (the scorecard and the docs-contract tests read it); AGENTS.md § B's wording updated to match. Measured on `5c8bcc3`: FINDINGS.md 1.46 MB (about 365k tokens, more than one context window holds); BACKLOG.md 172 KB, with notes up to 2,541 characters on one line; `progress.md` 551 lines against WORKFLOW § 6's one screen; D-17 about 1,100 lines
