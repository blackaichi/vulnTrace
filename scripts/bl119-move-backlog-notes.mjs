/**
 * Task BL-119 — moves `docs/tasks/BACKLOG.md`'s long notes into task
 * files, and proves the move lost nothing.
 *
 *   node scripts/bl119-move-backlog-notes.mjs move
 *   node scripts/bl119-move-backlog-notes.mjs verify --base <ref>
 *
 * WHAT MOVES. The `Notes` cell of every row of § 1 (Queue) and § 3
 * (Completed) longer than `NOTE_LIMIT` characters (trimmed). § 2 maps
 * findings to rows and has no notes; it does not change.
 *
 * WHERE IT GOES. The row's task file: the one file in `docs/tasks/` named
 * `<ID>-<slug>.md` or `<ID>.md` (the id compared case-insensitively). The
 * note is appended under `## Backlog note`, verbatim. A row with no task
 * file gets one, `docs/tasks/<ID>.md`, holding its title and the note. Two
 * candidate files stop the move. The row's `Notes` cell becomes a link,
 * `[note](<file>#backlog-note)`; every other cell, and every other byte of
 * the file, is left as it was.
 *
 * WHAT `verify` PROVES, against `--base` (the commit before the move):
 * every row of § 1 and § 3 is still there, by id, with its id, title,
 * priority, dependencies, audit and source cells byte-identical (a status
 * that changed since is listed, not failed: the backlog's statuses move);
 * a short note is unchanged; a long note is a link to a file that holds
 * it, verbatim, under `## Backlog note`; and no line outside those rows
 * changed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NOTE_LIMIT } from "./records-limits.mjs";
import { ROOT } from "./scorecard-sources.mjs";

const BACKLOG = "docs/tasks/BACKLOG.md";
const TASKS = path.join(ROOT, "docs/tasks");
const MOVED_SECTIONS = new Set(["## 1. Queue", "## 3. Completed"]);
const DATE = "2026-11-01";

function fail(message) {
  process.stderr.write(`bl119-move-backlog-notes: ${message}\n`);
  process.exit(1);
}

/**
 * A table row's cells, raw (escapes kept), with the span of each in the
 * line, so a cell can be replaced without touching any other byte.
 */
function rawCells(line) {
  const bars = [];
  let inCode = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && line[index + 1] === "|") index += 1;
    else if (char === "`") inCode = !inCode;
    else if (char === "|" && !inCode) bars.push(index);
  }
  return bars.slice(0, -1).map((start, i) => ({
    start: start + 1,
    end: bars[i + 1],
    text: line.slice(start + 1, bars[i + 1]),
  }));
}

/** Every row of § 1 and § 3: `{ index, section, id, cells }`. */
function rows(lines) {
  const found = [];
  let section;
  lines.forEach((line, index) => {
    if (line.startsWith("## ")) section = line;
    if (!MOVED_SECTIONS.has(section) || !line.startsWith("|")) return;
    if (/^\|\s*-/.test(line)) return;
    const cells = rawCells(line);
    const id = cells[0]?.text.trim();
    if (id === "ID") return;
    if (cells.length !== 8) fail(`line ${index + 1}: ${cells.length} cells, not 8`);
    found.push({ index, section, id, cells });
  });
  const seen = new Set();
  for (const row of found) {
    if (seen.has(row.id)) fail(`${row.id}: two rows`);
    seen.add(row.id);
  }
  return found;
}

const NOTE_HEADING = "## Backlog note";
const noteSection = (note) =>
  `${NOTE_HEADING}\n\nMoved verbatim from this task's row in [\`BACKLOG.md\`](BACKLOG.md)\nby task \`BL-119\` (${DATE}); the row links here.\n\n${note}\n`;

function taskFileOf(id) {
  const lower = id.toLowerCase();
  const candidates = fs
    .readdirSync(TASKS)
    .filter((name) => {
      const n = name.toLowerCase();
      return n === `${lower}.md` || (n.startsWith(`${lower}-`) && n.endsWith(".md"));
    });
  if (candidates.length > 1) fail(`${id}: more than one task file: ${candidates.join(", ")}`);
  return candidates[0];
}

function move() {
  const file = path.join(ROOT, BACKLOG);
  const lines = fs.readFileSync(file, "utf-8").split("\n");
  let appended = 0;
  let created = 0;
  for (const row of rows(lines)) {
    const note = row.cells[7].text.trim();
    if (note.length <= NOTE_LIMIT) continue;
    let target = taskFileOf(row.id);
    if (target === undefined) {
      target = `${row.id}.md`;
      const title = row.cells[1].text.trim();
      fs.writeFileSync(
        path.join(TASKS, target),
        `# ${row.id} — ${title}\n\n` +
          "This file holds the row's note, moved from\n" +
          "[`BACKLOG.md`](BACKLOG.md), which keeps the task's order and status.\n" +
          "When the task starts, its task file is written here (README.md,\n" +
          '"Naming").\n\n' +
          noteSection(note),
      );
      created += 1;
    } else {
      const existing = fs.readFileSync(path.join(TASKS, target), "utf-8");
      if (existing.includes(`\n${NOTE_HEADING}\n`)) fail(`${target}: already has a backlog note`);
      const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      fs.writeFileSync(path.join(TASKS, target), `${existing}${separator}${noteSection(note)}`);
      appended += 1;
    }
    const cell = row.cells[7];
    const line = lines[row.index];
    lines[row.index] = `${line.slice(0, cell.start)} [note](${target}#backlog-note) ${line.slice(cell.end)}`;
  }
  fs.writeFileSync(file, lines.join("\n"));
  process.stdout.write(
    `moved ${appended + created} notes over ${NOTE_LIMIT} characters: ` +
      `${appended} appended to existing task files, ${created} in new ones\n`,
  );
}

function verify(base) {
  const before = execFileSync("git", ["show", `${base}:${BACKLOG}`], {
    cwd: ROOT,
    encoding: "utf-8",
  }).split("\n");
  const after = fs.readFileSync(path.join(ROOT, BACKLOG), "utf-8").split("\n");
  const problems = [];
  const statusChanges = [];
  const afterRows = new Map(rows(after).map((row) => [row.id, row]));
  const beforeRows = rows(before);
  let moved = 0;
  const STATUS = 2;
  const NOTES = 7;
  for (const old of beforeRows) {
    const now = afterRows.get(old.id);
    if (now === undefined) {
      problems.push(`${old.id}: row missing`);
      continue;
    }
    afterRows.delete(old.id);
    old.cells.forEach((cell, i) => {
      if (i === NOTES) return;
      if (cell.text === now.cells[i].text) return;
      if (i === STATUS) statusChanges.push(`${old.id}: ${cell.text.trim()} -> ${now.cells[i].text.trim()}`);
      else problems.push(`${old.id}: cell ${i} changed`);
    });
    const note = old.cells[NOTES].text.trim();
    const nowNote = now.cells[NOTES].text.trim();
    if (note.length <= NOTE_LIMIT) {
      if (old.cells[NOTES].text !== now.cells[NOTES].text) problems.push(`${old.id}: a short note changed`);
      continue;
    }
    const link = /^\[note\]\(([^)#]+)#backlog-note\)$/.exec(nowNote);
    if (link === null) {
      problems.push(`${old.id}: a long note is not a link to its task file`);
      continue;
    }
    const target = path.join(TASKS, link[1]);
    const text = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "";
    const at = text.indexOf(`\n${NOTE_HEADING}\n`);
    if (at < 0 || !text.slice(at).includes(`\n\n${note}\n`)) {
      problems.push(`${old.id}: ${link[1]} does not hold the note verbatim under "${NOTE_HEADING}"`);
      continue;
    }
    moved += 1;
  }
  for (const id of afterRows.keys()) statusChanges.push(`${id}: a row added since the base`);
  // Every line outside the rows is unchanged.
  const rowLines = (lines) => new Set(rows(lines).map((row) => row.index));
  const outside = (lines) => lines.filter((_, index) => !rowLines(lines).has(index));
  if (outside(before).join("\n") !== outside(after).join("\n")) {
    problems.push("a line outside the rows of § 1 and § 3 changed");
  }
  if (problems.length > 0) fail(`${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
  process.stdout.write(
    [
      `verified against ${base}:`,
      `  ${beforeRows.length} rows of § 1 and § 3, every one present, its other cells byte-identical`,
      `  ${moved} notes over ${NOTE_LIMIT} characters, each verbatim in the task file its row links`,
      `  ${beforeRows.length - moved} shorter notes unchanged; every line outside the rows unchanged`,
      ...statusChanges.map((change) => `  (status, not a problem) ${change}`),
      "",
    ].join("\n"),
  );
}

const mode = process.argv[2];
const baseFlag = process.argv.indexOf("--base");
if (mode === "move") move();
else if (mode === "verify" && baseFlag > 0) verify(process.argv[baseFlag + 1]);
else fail("usage: node scripts/bl119-move-backlog-notes.mjs move | verify --base <ref>");
