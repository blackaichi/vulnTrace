/**
 * Task BL-119 — moves `tests/validation/FINDINGS.md` into one file per
 * record, and proves the move lost nothing.
 *
 *   node scripts/bl119-split-findings.mjs split  [--base <ref>]
 *   node scripts/bl119-split-findings.mjs verify [--base <ref>]
 *
 * The base defaults to BL-119's base commit, the last commit at which
 * `FINDINGS.md` was the hand-written register. Both modes read the base's
 * `FINDINGS.md` with `git show`, never the working tree's.
 *
 * HOW THE BASE FILE IS CUT. By bytes, not by lines: a section is every
 * byte from the start of a line beginning `## ` to the start of the next
 * such line (or the end of the file). The base file is therefore exactly
 * its preamble followed by its sections, in order, and `verify` asserts
 * that first. A section's id is read with the register's own pattern
 * (`SECTION_ID` in `scripts/findings-register.mjs`).
 *
 * WHERE EACH PART GOES.
 *
 * - A finding's sections (every section whose heading carries its id, in
 *   their order in the base file) go to `findings/<ID>.md`, after the
 *   status-table block: the table's header line, its separator line, the
 *   finding's own row (verbatim), and one empty line.
 * - Each section whose heading carries no id is a note, and goes to
 *   `findings/notes/<slug>.md`, by the fixed list `NOTES` below. A heading
 *   the list does not name stops the split.
 * - The `## Status` section's prose, and the preamble below the title, go
 *   into `findings/README.md` verbatim, under headings of their own. What
 *   follows the table in that section is a thematic break and empty lines;
 *   `verify` asserts that it is nothing else.
 *
 * WHAT `verify` PROVES, against the base:
 *
 * 1. the base file is its preamble plus its sections, byte for byte;
 * 2. every finding section's bytes are in its record file, in base order,
 *    and the record file is exactly the status block plus those sections:
 *    no byte added, none lost;
 * 3. every status-table row of the base is in exactly one record file,
 *    verbatim, and every record file's row is a base row;
 * 4. every note section is its note file, byte for byte;
 * 5. the preamble's text and the status section's prose are in
 *    `findings/README.md`, verbatim;
 * 6. no other file is under `findings/`.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  FINDINGS_DIR,
  FINDINGS_NOTES_DIR,
  SECTION_ID,
  STATUS_HEADER_LINE,
  STATUS_SEPARATOR_LINE,
  recordFileText,
} from "./findings-register.mjs";
import { ROOT } from "./scorecard-sources.mjs";

const DEFAULT_BASE = "a3b174fa30ae3d9aee89815f5e9a43f387fc9640";

/** Each note's heading prefix, and the file it moves to. */
const NOTES = [
  ["## Benchmark design note (not a VulnTrace defect)", "benchmark-design-note-rwb-09b.md"],
  ["## Benchmark methodology note — VT-303", "benchmark-methodology-note-vt-303.md"],
  ["## Precision limit — reachability does not prune", "precision-limit-abrupt-evaluation.md"],
  ["## P0-Z remediation — ", "p0-z-remediation.md"],
];

const README_PREAMBLE_HEADING = "## What this register is";
const README_STATUS_HEADING = "## How a status is read";

function fail(message) {
  process.stderr.write(`bl119-split-findings: ${message}\n`);
  process.exit(1);
}

function baseText(base) {
  return execFileSync(
    "git",
    ["show", `${base}:tests/validation/FINDINGS.md`],
    { cwd: ROOT, encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 },
  );
}

/** The base file, cut into its preamble and its sections (see the header). */
function cut(text) {
  const starts = [];
  if (text.startsWith("## ")) starts.push(0);
  for (let at = text.indexOf("\n## "); at >= 0; at = text.indexOf("\n## ", at + 1)) {
    starts.push(at + 1);
  }
  const preamble = text.slice(0, starts[0]);
  const sections = starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] : text.length;
    const bytes = text.slice(start, end);
    const heading = bytes.slice(0, bytes.indexOf("\n"));
    return { bytes, heading, id: SECTION_ID.exec(heading)?.[1] };
  });
  if (preamble + sections.map((s) => s.bytes).join("") !== text) {
    fail("the base file is not its preamble plus its sections");
  }
  return { preamble, sections };
}

/** The `## Status` section, cut into prose, table rows and what follows. */
function cutStatus(section) {
  const lines = section.bytes.split("\n");
  const header = lines.indexOf(STATUS_HEADER_LINE);
  if (header < 0 || lines[header + 1] !== STATUS_SEPARATOR_LINE) {
    fail("the status section has no table with the expected header");
  }
  let end = header + 2;
  while (end < lines.length && lines[end].startsWith("|")) end += 1;
  const prose = lines.slice(1, header).join("\n");
  const rows = lines.slice(header + 2, end);
  const tail = lines.slice(end).join("\n");
  if (!/^[\s-]*$/.test(tail) || tail.replace(/\s/g, "") !== "---") {
    fail(`the status section's tail is not a thematic break: ${JSON.stringify(tail)}`);
  }
  return { prose: prose.trim(), rows };
}

function rowId(row) {
  return /^\|\s*([^|\s]+)\s*\|/.exec(row)?.[1];
}

/** Every part of the base, keyed by where it goes. */
function plan(text) {
  const { preamble, sections } = cut(text);
  const status = sections.filter((s) => s.heading === "## Status");
  if (status.length !== 1) fail(`expected one '## Status' section, found ${status.length}`);
  const { prose, rows } = cutStatus(status[0]);

  const rowById = new Map();
  for (const row of rows) {
    const id = rowId(row);
    if (id === undefined || rowById.has(id)) fail(`a status row with no id or a duplicate: ${row}`);
    rowById.set(id, row);
  }

  const records = new Map();
  const notes = new Map();
  for (const section of sections) {
    if (section === status[0]) continue;
    if (section.id !== undefined) {
      const sectionsOfId = records.get(section.id) ?? [];
      sectionsOfId.push(section.bytes);
      records.set(section.id, sectionsOfId);
      continue;
    }
    const note = NOTES.find(([prefix]) => section.heading.startsWith(prefix));
    if (note === undefined) fail(`a heading with no id and no note file: ${section.heading}`);
    if (notes.has(note[1])) fail(`two sections for one note file: ${note[1]}`);
    notes.set(note[1], section.bytes);
  }
  if (notes.size !== NOTES.length) fail("a listed note was not found in the base");

  for (const id of records.keys()) if (!rowById.has(id)) fail(`${id}: a section with no status row`);
  for (const id of rowById.keys()) if (!records.has(id)) fail(`${id}: a status row with no section`);

  const titleEnd = preamble.indexOf("\n");
  const preambleText = preamble.slice(titleEnd + 1).trim();
  return { records, rowById, notes, preambleText, prose };
}

function expectedRecordFiles(planned) {
  return new Map(
    [...planned.records].map(([id, bytes]) => [
      `${id}.md`,
      recordFileText(planned.rowById.get(id), bytes),
    ]),
  );
}

function split(planned) {
  const dir = path.join(ROOT, FINDINGS_DIR);
  const notesDir = path.join(ROOT, FINDINGS_NOTES_DIR);
  fs.mkdirSync(notesDir, { recursive: true });
  for (const [name, text] of expectedRecordFiles(planned)) {
    fs.writeFileSync(path.join(dir, name), text);
  }
  for (const [name, text] of planned.notes) {
    fs.writeFileSync(path.join(notesDir, name), text);
  }
  process.stdout.write(
    `wrote ${planned.records.size} record files and ${planned.notes.size} notes under ${FINDINGS_DIR}/\n` +
      "README.md is written by hand; `verify` checks that it carries the preamble and the status prose.\n",
  );
}

function verify(planned) {
  const dir = path.join(ROOT, FINDINGS_DIR);
  const notesDir = path.join(ROOT, FINDINGS_NOTES_DIR);
  const problems = [];

  const expected = expectedRecordFiles(planned);
  const present = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "README.md")
    .map((entry) => entry.name);
  for (const name of present) {
    if (!expected.has(name)) problems.push(`${name}: a file the base has no record for`);
  }
  let sectionBytes = 0;
  for (const [name, text] of expected) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) {
      problems.push(`${name}: missing`);
      continue;
    }
    if (fs.readFileSync(file, "utf-8") !== text) {
      problems.push(`${name}: differs from the base's row and sections`);
    }
    sectionBytes += planned.records.get(name.slice(0, -3)).join("").length;
  }
  const dirs = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (dirs.join() !== "notes") problems.push(`unexpected directories: ${dirs.join(", ")}`);

  const notePresent = fs.readdirSync(notesDir);
  for (const name of notePresent) {
    if (!planned.notes.has(name)) problems.push(`notes/${name}: not a base note`);
  }
  for (const [name, text] of planned.notes) {
    const file = path.join(notesDir, name);
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf-8") !== text) {
      problems.push(`notes/${name}: missing or not byte-identical`);
    }
  }

  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf-8");
  // Each is a whole block of the README, under its own heading.
  const block = (heading, text) => {
    const at = readme.indexOf(`${heading}\n`);
    return at >= 0 && readme.indexOf(`\n\n${text}\n`, at) >= 0;
  };
  if (!block(README_PREAMBLE_HEADING, planned.preambleText)) {
    problems.push("README.md: the base preamble is not there verbatim");
  }
  if (!block(README_STATUS_HEADING, planned.prose)) {
    problems.push("README.md: the base status prose is not there verbatim");
  }

  if (problems.length > 0) fail(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  const sectionCount = [...planned.records.values()].reduce((n, s) => n + s.length, 0);
  process.stdout.write(
    [
      `verified against ${planned.base}:`,
      `  base FINDINGS.md = preamble + ${sectionCount + planned.notes.size + 1} sections, byte for byte`,
      `  ${planned.records.size} record files: each exactly its status row + its ${sectionCount} sections (${sectionBytes} bytes)`,
      `  ${planned.rowById.size} status rows, each in exactly one record file, verbatim`,
      `  ${planned.notes.size} notes, byte-identical`,
      "  preamble and status prose in findings/README.md, verbatim",
      "",
    ].join("\n"),
  );
}

const mode = process.argv[2];
const baseFlag = process.argv.indexOf("--base");
const base = baseFlag > 0 ? process.argv[baseFlag + 1] : DEFAULT_BASE;
const planned = { ...plan(baseText(base)), base };
if (mode === "split") split(planned);
else if (mode === "verify") verify(planned);
else fail("usage: node scripts/bl119-split-findings.mjs split|verify [--base <ref>]");
