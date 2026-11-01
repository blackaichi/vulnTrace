/**
 * The findings register's layout (task BL-119): one file per finding.
 *
 * Every finding is one file, `tests/validation/findings/<ID>.md`:
 *
 *   | ID | Package | Root cause | Impact | Status |
 *   |---|---|---|---|---|
 *   | RWF-047 | … | … | … | Open … |
 *
 *   ## RWF-047 — …            (the record's first section)
 *   …
 *   ## RWF-047 — CLASSIFIED … (any later section of the same record)
 *
 * The first three lines are the finding's status row, under the status
 * table's own header; it is the one part of the file edited in place, when
 * the status changes. Everything from the first `## <ID>` heading on is
 * append-only, as the single `FINDINGS.md` was. Every `##` heading in the
 * file carries the file's id. A section with no finding id (a methodology
 * note, a precision limit) is a note, one file under `findings/notes/`.
 *
 * ONE READER. `readFindingsRegisterText` reads the whole directory and
 * assembles the text the register's classifier has always read: a
 * `## Status` table of every file's row, then every file's sections. So
 * the classifier (`classifyFindingsRegister`, `scripts/scorecard-sources.mjs`)
 * keeps its designated field, its closed vocabulary, its tripwire and its
 * section/row check unchanged, and every reader of the register -- the
 * scorecard, the open-soundness-defect records, the binding-grammar
 * sweep -- reads the same assembled text.
 *
 * LOUD, NEVER LENIENT. A file whose name is not an id, whose first lines
 * are not the header, separator, a row and an empty line, whose row names
 * another id, or whose sections carry another id's heading, is an error
 * naming the file; so is a note carrying a finding's heading, and any
 * other file or directory in `findings/`. Nothing is skipped: a skipped
 * file is a finding in no count (`sectionRowProblems`'s history).
 *
 * `tests/validation/FINDINGS.md` is generated from the directory
 * (`renderFindingsIndex`) by `node scripts/generate-scorecard.mjs`, whose
 * `--check` fails when it is stale.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

export const FINDINGS_DIR = "tests/validation/findings";
export const FINDINGS_NOTES_DIR = `${FINDINGS_DIR}/notes`;
export const FINDINGS_INDEX = "tests/validation/FINDINGS.md";

/** A finding section's heading: `## RWF-049 — …`, `## AUD-01 — …`. */
export const SECTION_ID = /^## ([A-Z]+-\d+[a-z]?)\b/;

/** The status table's header and separator, as every record file carries them. */
export const STATUS_HEADER_LINE = "| ID | Package | Root cause | Impact | Status |";
export const STATUS_SEPARATOR_LINE = "|---|---|---|---|---|";

const RECORD_FILE = /^([A-Z]+-\d+[a-z]?)\.md$/;

/** The series in the order the status table lists them; others follow, by name. */
const SERIES_ORDER = ["RWF", "AUD", "PRM"];

/** A record file's text, from its status row and its sections' bytes. */
export function recordFileText(row, sections) {
  return `${STATUS_HEADER_LINE}\n${STATUS_SEPARATOR_LINE}\n${row}\n\n${sections.join("")}`;
}

/** Orders ids by series (`SERIES_ORDER`), then number, then suffix. */
export function compareFindingIds(a, b) {
  const parse = (id) => {
    const [, series, number, suffix] = /^([A-Z]+)-(\d+)([a-z]?)$/.exec(id);
    const rank = SERIES_ORDER.indexOf(series);
    return { rank: rank < 0 ? SERIES_ORDER.length : rank, series, number: Number(number), suffix };
  };
  const x = parse(a);
  const y = parse(b);
  return (
    x.rank - y.rank ||
    x.series.localeCompare(y.series) ||
    x.number - y.number ||
    x.suffix.localeCompare(y.suffix)
  );
}

function headingsOf(body) {
  return body.split("\n").filter((line) => line.startsWith("## "));
}

/**
 * One record file, parsed: `{ id, file, row, body, headings }`, or the
 * problems that make it no record. Pure, for the tests.
 */
export function parseRecordFile(file, text) {
  const problems = [];
  const id = RECORD_FILE.exec(file)?.[1];
  if (id === undefined) {
    return { problems: [`${file}: not a record file name (<ID>.md, e.g. RWF-047.md)`] };
  }
  const lines = text.split("\n");
  if (lines[0] !== STATUS_HEADER_LINE || lines[1] !== STATUS_SEPARATOR_LINE) {
    problems.push(
      `${file}: must begin with the status table's header and separator, ` +
        `exactly "${STATUS_HEADER_LINE}" and "${STATUS_SEPARATOR_LINE}"`,
    );
    return { problems };
  }
  const row = lines[2] ?? "";
  const rowId = /^\|\s*([^|\s]+)\s*\|/.exec(row)?.[1];
  if (rowId !== id) {
    problems.push(
      `${file}: its third line must be its own status row, "| ${id} | … |"; found ${JSON.stringify(row.slice(0, 60))}`,
    );
  }
  if (lines[3] !== "" || !(lines[4] ?? "").startsWith("## ")) {
    problems.push(`${file}: the status row must be followed by one empty line and then a "## ${id} — …" heading`);
  }
  const body = lines.slice(4).join("\n");
  const headings = headingsOf(body);
  for (const heading of headings) {
    const headingId = SECTION_ID.exec(heading)?.[1];
    if (headingId !== id) {
      problems.push(
        `${file}: every "##" heading must carry the file's id ${id}; found ${JSON.stringify(heading.slice(0, 80))}`,
      );
    }
  }
  return problems.length > 0 ? { problems } : { id, file, row, body, headings, problems };
}

/** One note file, parsed: `{ file, body, headings }`, or its problems. */
export function parseNoteFile(file, text) {
  const problems = [];
  if (!file.endsWith(".md")) problems.push(`notes/${file}: not a markdown file`);
  if (!text.startsWith("## ")) problems.push(`notes/${file}: must begin with a "## " heading`);
  const headings = headingsOf(text);
  for (const heading of headings) {
    if (SECTION_ID.test(heading)) {
      problems.push(
        `notes/${file}: carries a finding heading ${JSON.stringify(heading.slice(0, 80))}; ` +
          "a finding is a file of its own, findings/<ID>.md, with its status row",
      );
    }
  }
  return problems.length > 0 ? { problems } : { file, body: text, headings, problems };
}

/**
 * Every record and note under `findings/`, in id order. Throws, naming
 * every problem, when the directory holds anything that is not a record,
 * a note, `README.md` or `notes/`.
 */
export function readFindingRecords(root = ROOT) {
  const dir = path.join(root, FINDINGS_DIR);
  const problems = [];
  const records = [];
  const notes = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name === "notes") continue;
    if (entry.isFile() && entry.name === "README.md") continue;
    if (!entry.isFile()) {
      problems.push(`${entry.name}: not a record file, README.md or notes/`);
      continue;
    }
    const parsed = parseRecordFile(entry.name, fs.readFileSync(path.join(dir, entry.name), "utf-8"));
    if (parsed.problems.length > 0) problems.push(...parsed.problems);
    else records.push(parsed);
  }
  const notesDir = path.join(root, FINDINGS_NOTES_DIR);
  for (const entry of fs.existsSync(notesDir) ? fs.readdirSync(notesDir, { withFileTypes: true }) : []) {
    if (!entry.isFile()) {
      problems.push(`notes/${entry.name}: not a note file`);
      continue;
    }
    const parsed = parseNoteFile(entry.name, fs.readFileSync(path.join(notesDir, entry.name), "utf-8"));
    if (parsed.problems.length > 0) problems.push(...parsed.problems);
    else notes.push(parsed);
  }
  if (problems.length > 0) {
    throw new Error(
      `${FINDINGS_DIR}: ${problems.length} layout problem(s) ` +
        "(scripts/findings-register.mjs). Never skip a file -- fix it:\n" +
        problems.map((problem) => `  ${problem}`).join("\n"),
    );
  }
  records.sort((a, b) => compareFindingIds(a.id, b.id));
  notes.sort((a, b) => a.file.localeCompare(b.file));
  return { records, notes };
}

const withNewline = (text) => (text.endsWith("\n") ? text : `${text}\n`);

/**
 * The register as one text, in the form the classifier reads: a
 * `## Status` table of every record's row, then every record's sections,
 * then every note. Pure, for the tests.
 */
export function assembleFindingsRegister({ records, notes }) {
  return [
    "## Status\n\n",
    `${STATUS_HEADER_LINE}\n${STATUS_SEPARATOR_LINE}\n`,
    ...records.map((record) => `${record.row}\n`),
    "\n",
    ...records.map((record) => withNewline(record.body)),
    ...notes.map((note) => withNewline(note.body)),
  ].join("");
}

/** The committed register, assembled (`assembleFindingsRegister`). */
export function readFindingsRegisterText(root = ROOT) {
  return assembleFindingsRegister(readFindingRecords(root));
}

const linkText = (heading) => heading.slice(3).trim();

/** `tests/validation/FINDINGS.md`, generated: the status table and the index. */
export function renderFindingsIndex({ records, notes }) {
  const lines = [
    "# Real-World Validation Findings",
    "",
    "<!-- GENERATED by `node scripts/generate-scorecard.mjs` from",
    "     tests/validation/findings/. Do not edit this file: edit the",
    "     record's own file, then regenerate. -->",
    "",
    "This file is generated (task `BL-119`). Each finding is one file in",
    "[`findings/`](findings/): its status row, then its sections, which are",
    "append-only. What the register is, how a status is read, and how to",
    "add a record or change a status: [`findings/README.md`](findings/README.md).",
    "",
    "## Status",
    "",
    "Every record's status row, in id order. A status is read from the",
    "`Status` column only, through a closed vocabulary",
    "([`findings/README.md`](findings/README.md), \"How a status is read\").",
    "",
    STATUS_HEADER_LINE,
    STATUS_SEPARATOR_LINE,
    ...records.map((record) => record.row),
    "",
    "## Index",
    "",
    "### Findings",
    "",
  ];
  for (const record of records) {
    const [first, ...rest] = record.headings;
    lines.push(`- [\`${record.id}\`](findings/${record.file}): ${linkText(first)}`);
    for (const heading of rest) lines.push(`  - ${linkText(heading)}`);
  }
  lines.push("", "### Notes", "", "Sections that record no finding.", "");
  for (const note of notes) {
    for (const heading of note.headings) {
      lines.push(`- [${linkText(heading)}](findings/notes/${note.file})`);
    }
  }
  return `${lines.join("\n")}\n`;
}
