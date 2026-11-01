# The findings register

Every finding VulnTrace's validation, audits and remediation tasks have
recorded, one file per finding (task `BL-119`, authorized by the project
owner on 2026-10-27). [`../FINDINGS.md`](../FINDINGS.md) is generated
from this directory: the status table, and an index of every record and
note. Do not edit it by hand.

## What this register is

A running log of every gap discovered by scanning real, npm-installed
packages against real CVEs/GHSAs (`tests/validation/`) — kept up to date
after every validation run, per the same discipline as the adversarial
suites: a disagreement between VulnTrace and an independently-researched
oracle is recorded here and the case is kept failing (`knownFailure: true`
in `cases/cases.json`), never silently fixed away or hidden.

Each entry is a candidate for a future remediation task, not yet
implemented. Nothing in this file changes analyzer behavior by itself.

## The layout

- **`<ID>.md`, one finding.** Its first three lines are its status row
  under the status table's own header and separator, then one empty
  line, then the record's sections. The row is the one part of the file
  edited in place, when the finding's status changes. Everything from
  the first `## <ID> — …` heading on is **append-only**, as the single
  `FINDINGS.md` was (AGENTS.md § B): a correction or a status update is
  a new section at the end of the file, never an edit of an earlier one.
  Every `##` heading in the file carries the file's own id, as the
  records' corrections always have (`## RWF-032 CORRECTION — …`,
  `## RWF-047 — CLASSIFIED: …`).
- **`notes/<slug>.md`, a section that records no finding**: a benchmark
  or methodology note, a precision limit, a remediation write-up. A note
  carries no finding heading.
- Nothing else. Any other file or directory here, a record whose first
  lines are not the header, the separator, its own row and an empty
  line, or a heading of another id, fails the scorecard generator,
  naming the file (`scripts/findings-register.mjs`). A file is never
  skipped: a skipped file would be a finding in no count.

Every reader of the register reads it through one function,
`readFindingsRegisterText` (`scripts/findings-register.mjs`), which
assembles the rows and sections into the text the classifier has always
read. The classifier, its vocabulary and its checks (below) are
unchanged by the move.

The records were moved verbatim from the single file at commit
`a3b174f`; `node scripts/bl119-split-findings.mjs verify` proves it,
byte for byte.

## Adding a record

1. `node scripts/next-id.mjs RWF` (or `PRM`, `AUD`) prints the next free
   id of the series.
2. Write `<ID>.md`: the header, the separator, the finding's row, an
   empty line, then `## <ID> — <title>` and the record, in the existing
   field format.
3. Run `node scripts/generate-scorecard.mjs`. It regenerates
   `../FINDINGS.md` and `docs/SCORECARD.md`, and its `--check` (a gate,
   AGENTS.md § I) fails while either is stale.

## Changing a status

Edit the `Status` cell of the row in the record's own file, append a
section saying what changed and on what evidence, and regenerate.

## How a status is read

The text below was written for the single file's `## Status` table, and
is kept verbatim. Since `BL-119`, "this table" and "a row here" mean the
table `../FINDINGS.md` generates from every record file's row, and the
rule is unchanged: one designated field, a closed vocabulary, a row for
every finding section and a section for every row.

**How this table is read.** `docs/SCORECARD.md` § 8 is generated from
this table by `readFindingsRegister` in `scripts/scorecard-sources.mjs`,
and it reads a finding's status from **one field only: the `Status`
column** (the fifth cell). Nothing else in a row, and no prose outside
this table, decides a status. The header must stay exactly
`| ID | Package | Root cause | Impact | Status |`; every row must have
five cells, and its ID must look like `RWF-047` or `AUD-01`.

The **status value** is the cell's leading phrase. Emphasis (`**`) is
stripped, and the value ends at the first `—`, `;`, `,`, `:`, `.` or
`(`. Whatever follows is commentary for the reader and is never
classified. The value must be one of these, case-insensitive, with a
hyphen counting as a space:

- **open**: `Open`, `Not fixed`
- **open in part**: `Open in part`, `Fixed in part`, `Partially fixed`,
  `Bypassed for unloaded packages` (RWF-002's value),
  `Fixed for variable bindings` (RWF-013's value)
- **fixed**: `Fixed`

"Open in part" is open: a finding that is only partly fixed is not fixed.
Any other value makes the scorecard generator **fail**, naming the row
and the value. A `Fixed` value whose own cell also says "not fixed",
"in part", "partially", "open", "remains" or "outstanding" fails too. To
record a new kind of status, add it to `FINDINGS_STATUS_VOCABULARY`
deliberately, in the category that cannot overstate closure. **Every
`## <ID>` finding section needs a row here, and every row a section.**
A mismatch either way fails the generator, naming the ID.
