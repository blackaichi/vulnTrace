/**
 * The size limits two records keep (task BL-119,
 * `scripts/records-limits.mjs`), so neither grows back into what that
 * task cut down.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  NOTE_LIMIT,
  PROGRESS_MAX_LINES,
} from "../../scripts/records-limits.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const TASKS = path.join(ROOT, "docs", "tasks");

/** A table row's cells, trimmed; `|` inside code or escaped does not split. */
function cells(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let inCode = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && line[index + 1] === "|") {
      current += "\\|";
      index += 1;
    } else if (char === "`") {
      inCode = !inCode;
      current += char;
    } else if (char === "|" && !inCode) {
      out.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  return out.slice(1);
}

/** The rows of BACKLOG.md's § 1 and § 3: `{ id, notes }`. */
function backlogRows(): { id: string; notes: string }[] {
  const rows: { id: string; notes: string }[] = [];
  let section = "";
  for (const line of readFileSync(
    path.join(TASKS, "BACKLOG.md"),
    "utf-8",
  ).split("\n")) {
    if (line.startsWith("## ")) section = line;
    if (section !== "## 1. Queue" && section !== "## 3. Completed") continue;
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const row = cells(line);
    if (row[0] === "ID") continue;
    rows.push({ id: row[0] ?? "", notes: row[7] ?? "" });
  }
  return rows;
}

describe("docs/tasks/BACKLOG.md's notes", () => {
  const rows = backlogRows();

  it("reads every row of § 1 and § 3", () => {
    expect(rows.length).toBeGreaterThan(200);
  });

  it(`are at most ${NOTE_LIMIT} characters; a longer note is in the task's file`, () => {
    const long = rows
      .filter((row) => row.notes.length > NOTE_LIMIT)
      .map((row) => `${row.id} (${row.notes.length})`);
    expect(
      long,
      'move each into its task file (docs/tasks/README.md, "Naming")',
    ).toEqual([]);
  });

  it("link only to a task file that holds the note", () => {
    for (const row of rows) {
      for (const [, file] of row.notes.matchAll(
        /\[note\]\(([^)#]+)#backlog-note\)/g,
      )) {
        const target = path.join(TASKS, file ?? "");
        expect(existsSync(target), `${row.id}: ${file} does not exist`).toBe(
          true,
        );
        expect(
          readFileSync(target, "utf-8"),
          `${row.id}: ${file} has no "## Backlog note" section`,
        ).toMatch(/^## Backlog note$/m);
      }
    }
  });
});

describe("docs/progress.md", () => {
  it(`fits one screen: at most ${PROGRESS_MAX_LINES} lines (WORKFLOW § 6)`, () => {
    const text = readFileSync(path.join(ROOT, "docs", "progress.md"), "utf-8");
    const lines = text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    expect(
      lines,
      "progress.md is the state, not a transcript: link the task file, the " +
        "register or the backlog instead of restating them",
    ).toBeLessThanOrEqual(PROGRESS_MAX_LINES);
  });
});
