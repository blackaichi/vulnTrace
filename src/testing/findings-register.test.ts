/**
 * The findings register's one-file-per-record layout (task BL-119).
 *
 * The classifier's own cases are `findings-status.test.ts`, unchanged by
 * the move. These are the layout's: every way a record file can stop being
 * read as the finding it is named for must fail loudly and name the file,
 * because a file the reader skipped would be a finding in no count -- the
 * register's equivalent of a silently dropped finding.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  FINDINGS_DIR,
  FINDINGS_INDEX,
  STATUS_HEADER_LINE,
  STATUS_SEPARATOR_LINE,
  assembleFindingsRegister,
  compareFindingIds,
  parseNoteFile,
  parseRecordFile,
  readFindingRecords,
  readFindingsRegisterText,
  recordFileText,
  renderFindingsIndex,
} from "../../scripts/findings-register.mjs";
import {
  classifyFindingsRegister,
  readFindingsRegister,
} from "../../scripts/scorecard-sources.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));

const row = (id: string, status = "Open") =>
  `| ${id} | \`pkg\` | a root cause | an impact | ${status} |`;
const record = (
  id: string,
  status = "Open",
  body = `## ${id} — a finding\n\ntext\n`,
) => recordFileText(row(id, status), [body]);

const problemsOf = (parsed: { readonly problems: readonly string[] }) =>
  parsed.problems.join("\n");

describe("a record file", () => {
  it("parses into its id, row, body and headings", () => {
    const parsed = parseRecordFile(
      "RWF-900.md",
      record(
        "RWF-900",
        "Open",
        "## RWF-900 — a\n\nx\n\n## RWF-900 — CORRECTION\n\ny\n",
      ),
    );
    expect(parsed.problems).toEqual([]);
    expect(parsed).toMatchObject({
      id: "RWF-900",
      row: row("RWF-900"),
      headings: ["## RWF-900 — a", "## RWF-900 — CORRECTION"],
    });
  });

  it("is refused when its name is not an id", () => {
    expect(
      problemsOf(parseRecordFile("rwf-900.md", record("RWF-900"))),
    ).toMatch(/rwf-900\.md: not a record file name/);
    expect(
      problemsOf(parseRecordFile("RWF-900.txt", record("RWF-900"))),
    ).toMatch(/not a record file name/);
  });

  it("is refused when it does not begin with the status header and separator", () => {
    const text = `${row("RWF-900")}\n\n## RWF-900 — a\n`;
    expect(problemsOf(parseRecordFile("RWF-900.md", text))).toMatch(
      /RWF-900\.md: must begin with the status table's header/,
    );
    const otherHeader = record("RWF-900").replace(
      STATUS_HEADER_LINE,
      "| ID | Status |",
    );
    expect(problemsOf(parseRecordFile("RWF-900.md", otherHeader))).toMatch(
      /header/,
    );
  });

  it("is refused when its row names another id", () => {
    const text = recordFileText(row("RWF-901"), ["## RWF-900 — a\n"]);
    expect(problemsOf(parseRecordFile("RWF-900.md", text))).toMatch(
      /RWF-900\.md: its third line must be its own status row/,
    );
  });

  it("is refused when it has no row at all", () => {
    const text = `${STATUS_HEADER_LINE}\n${STATUS_SEPARATOR_LINE}\n\n## RWF-900 — a\n`;
    expect(problemsOf(parseRecordFile("RWF-900.md", text))).toMatch(
      /own status row/,
    );
  });

  it("is refused when the row is not followed by one empty line and a heading", () => {
    const twoRows = `${STATUS_HEADER_LINE}\n${STATUS_SEPARATOR_LINE}\n${row("RWF-900")}\n${row("RWF-901")}\n\n## RWF-900 — a\n`;
    expect(problemsOf(parseRecordFile("RWF-900.md", twoRows))).toMatch(
      /followed by one empty line/,
    );
    const prose = recordFileText(row("RWF-900"), [
      "prose before the heading\n\n## RWF-900 — a\n",
    ]);
    expect(problemsOf(parseRecordFile("RWF-900.md", prose))).toMatch(
      /followed by one empty line/,
    );
  });

  it("is refused when a section carries another id's heading", () => {
    const text = record(
      "RWF-900",
      "Open",
      "## RWF-900 — a\n\n## RWF-901 — b\n",
    );
    expect(problemsOf(parseRecordFile("RWF-900.md", text))).toMatch(
      /RWF-900\.md: every "##" heading must carry the file's id RWF-900; found "## RWF-901/,
    );
  });

  it("is refused when a section's heading carries no id", () => {
    const text = record(
      "RWF-900",
      "Open",
      "## RWF-900 — a\n\n## Precision limit — b\n",
    );
    expect(problemsOf(parseRecordFile("RWF-900.md", text))).toMatch(
      /must carry the file's id/,
    );
  });
});

describe("a note file", () => {
  it("is refused when it carries a finding heading", () => {
    expect(
      problemsOf(parseNoteFile("n.md", "## Note — a\n\n## RWF-900 — b\n")),
    ).toMatch(/notes\/n\.md: carries a finding heading/);
  });

  it("is refused when it does not begin with a heading", () => {
    expect(problemsOf(parseNoteFile("n.md", "text\n"))).toMatch(
      /must begin with a "## " heading/,
    );
  });
});

describe("the findings directory", () => {
  let root: string | undefined;
  afterEach(() => {
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  /** A repository root holding the given files under `findings/`. */
  function tree(files: Readonly<Record<string, string>>): string {
    root = mkdtempSync(path.join(os.tmpdir(), "vt-findings-"));
    const dir = path.join(root, FINDINGS_DIR);
    mkdirSync(path.join(dir, "notes"), { recursive: true });
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), text);
    }
    return root;
  }

  it("is read in id order, records and notes apart, README skipped", () => {
    const at = tree({
      "README.md": "# The findings register\n",
      "RWF-010.md": record("RWF-010"),
      "RWF-002.md": record("RWF-002", "Fixed"),
      "AUD-01.md": record("AUD-01"),
      "RWF-002b.md": record("RWF-002b"),
      "notes/limit.md": "## Precision limit — a\n",
    });
    const { records, notes } = readFindingRecords(at);
    expect(records.map((r) => r.id)).toEqual([
      "RWF-002",
      "RWF-002b",
      "RWF-010",
      "AUD-01",
    ]);
    expect(notes.map((n) => n.file)).toEqual(["limit.md"]);
  });

  it("refuses, naming each, every file that is not a record, a note, README.md or notes/", () => {
    const at = tree({
      "RWF-010.md": record("RWF-010"),
      "stray.txt": "x\n",
      "RWF-011.md": record("RWF-012"),
      "drafts/RWF-013.md": record("RWF-013"),
      "notes/bad.md": "## RWF-014 — a finding in the notes\n",
    });
    let message = "";
    try {
      readFindingRecords(at);
    } catch (error) {
      message = (error as Error).message;
    }
    // RWF-011.md holds RWF-012's record: its row and its heading are each
    // a problem.
    expect(message).toMatch(/5 layout problem\(s\)/);
    expect(message).toMatch(/stray\.txt: not a record file name/);
    expect(message).toMatch(
      /RWF-011\.md: its third line must be its own status row/,
    );
    expect(message).toMatch(
      /RWF-011\.md: every "##" heading must carry the file's id RWF-011/,
    );
    expect(message).toMatch(/drafts: not a record file, README\.md or notes\//);
    expect(message).toMatch(/notes\/bad\.md: carries a finding heading/);
  });

  it("assembles into the text the classifier reads, every row classified once", () => {
    const at = tree({
      "RWF-002.md": record("RWF-002", "Fixed"),
      "RWF-010.md": record("RWF-010", "Open in part — the rest is RWF-011's"),
      "AUD-01.md": record("AUD-01", "**Not fixed**"),
    });
    const register = classifyFindingsRegister(readFindingsRegisterText(at));
    expect(register.fixed.map((r) => r.id)).toEqual(["RWF-002"]);
    expect(register.partlyOpen.map((r) => r.id)).toEqual(["RWF-010"]);
    expect(register.open.map((r) => r.id)).toEqual(["AUD-01"]);
  });

  it("keeps the classifier's refusals: an unknown status names its record", () => {
    const at = tree({ "RWF-002.md": record("RWF-002", "Triaged") });
    expect(() =>
      classifyFindingsRegister(readFindingsRegisterText(at)),
    ).toThrow(/RWF-002: status value "triaged" is not in the vocabulary/);
  });

  it("indexes every record's sections and every note", () => {
    const at = tree({
      "RWF-002.md": record(
        "RWF-002",
        "Fixed",
        "## RWF-002 — a\n\n## RWF-002 CORRECTION — b\n",
      ),
      "notes/limit.md": "## Precision limit — c\n",
    });
    const index = renderFindingsIndex(readFindingRecords(at));
    expect(index).toContain(
      `${STATUS_HEADER_LINE}\n${STATUS_SEPARATOR_LINE}\n${row("RWF-002", "Fixed")}\n`,
    );
    expect(index).toContain(
      "- [`RWF-002`](findings/RWF-002.md): RWF-002 — a\n  - RWF-002 CORRECTION — b\n",
    );
    expect(index).toContain(
      "- [Precision limit — c](findings/notes/limit.md)\n",
    );
    // The index carries no section heading of its own, so it can never be
    // read as a second copy of a record.
    expect(index).not.toMatch(/^## RWF-002/m);
  });
});

describe("ids", () => {
  it("order by series as the status table lists them, then number, then suffix", () => {
    const ids = [
      "PRM-02",
      "RWF-013b",
      "AUD-10",
      "RWF-100",
      "RWF-013",
      "AUD-02",
      "RWF-9",
    ];
    expect([...ids].sort(compareFindingIds)).toEqual([
      "RWF-9",
      "RWF-013",
      "RWF-013b",
      "RWF-100",
      "AUD-02",
      "AUD-10",
      "PRM-02",
    ]);
  });
});

describe("the committed register", () => {
  const committed = readFindingRecords(ROOT);

  it("names every record file by its own id, and reads every row", () => {
    for (const entry of committed.records)
      expect(entry.file).toBe(`${entry.id}.md`);
    expect(readFindingsRegister().rows.map((r) => r.id)).toEqual(
      committed.records.map((r) => r.id),
    );
  });

  it("reads every file in the directory: none is skipped", () => {
    // Counted from a plain listing, independently of the reader, so a
    // reader that skipped a file could not also agree with itself.
    const dir = path.join(ROOT, FINDINGS_DIR);
    const records = readdirSync(dir).filter(
      (name) => name !== "README.md" && name !== "notes",
    );
    const notes = readdirSync(path.join(dir, "notes"));
    expect(committed.records.length).toBe(records.length);
    expect(committed.notes.length).toBe(notes.length);
    expect(readFindingsRegister().rows.length).toBe(records.length);
  });

  it("is what FINDINGS.md was generated from", () => {
    expect(readFileSync(path.join(ROOT, FINDINGS_INDEX), "utf-8")).toBe(
      renderFindingsIndex(committed),
    );
  });

  it("assembles to a text whose every section belongs to a record or a note", () => {
    const text = assembleFindingsRegister(committed);
    const headings = text.split("\n").filter((line) => line.startsWith("## "));
    const expected = [
      "## Status",
      ...committed.records.flatMap((r) => r.headings),
      ...committed.notes.flatMap((n) => n.headings),
    ];
    expect(headings).toEqual(expected);
  });
});
