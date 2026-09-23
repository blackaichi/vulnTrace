/**
 * FOUNDATION F7 — the scorecard's SOURCE READERS.
 *
 * Every number in `docs/SCORECARD.md` is read from one of the structured
 * artifacts below. Nothing here parses prose, and nothing here re-derives
 * a fact the repository already states in a machine-readable form (F7
 * § 29): the invariant map, the uncertainty taxonomy, the gate configs,
 * the case list and the JSON schema are each read directly, so a value in
 * the scorecard cannot disagree with the thing it describes.
 *
 * TWO KINDS OF SOURCE, AND THE DIFFERENCE MATTERS.
 *
 * - **Structural** (this file's `read*` functions): derived from committed
 *   source. Recomputing them needs no test run, no network and no clock,
 *   so `generate-scorecard.mjs --check` can prove the committed scorecard
 *   is current.
 * - **Measured** (`docs/scorecard-data/measurements.json`): the result of
 *   actually running a command. A check can prove the scorecard matches
 *   what was recorded; it cannot prove the recording is fresh, which is
 *   why every measured row carries the command, the commit and the date it
 *   was taken at, and why the live ones are labelled as such.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

/**
 * Imports a TypeScript module for its DATA exports.
 *
 * The transpiled module is written under `node_modules/` rather than into
 * the OS temp directory, deliberately: a temp-directory module cannot
 * resolve this project's own bare imports (`vitest/config`), and the gate
 * configs are among the sources that must be read. Types are erased, so a
 * type-only import (`import type { DynamicCallReason }`) disappears rather
 * than becoming a runtime dependency.
 */
async function importTs(relativePath) {
  const source = fs.readFileSync(path.join(ROOT, relativePath), "utf-8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: false,
    },
  });
  const dir = fs.mkdtempSync(
    path.join(ROOT, "node_modules", ".vulntrace-scorecard-"),
  );
  try {
    const file = path.join(dir, "module.mjs");
    fs.writeFileSync(file, outputText);
    return await import(`${file}?t=${Date.now()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readJson = (relativePath) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), "utf-8"));

/** The Foundation invariant ownership map (F6) — 22 rows and their owners. */
export async function readInvariantMap() {
  const module = await importTs("src/testing/foundation-invariants.ts");
  const invariants = module.FOUNDATION_INVARIANTS;
  const byFoundation = new Map();
  for (const invariant of invariants) {
    byFoundation.set(
      invariant.foundation,
      (byFoundation.get(invariant.foundation) ?? 0) + 1,
    );
  }
  const owners = new Set(invariants.flatMap((invariant) => invariant.owners));
  return {
    invariants,
    count: invariants.length,
    ownerFiles: [...owners].sort(),
    byFoundation,
    liveSignals: module.LIVE_SIGNALS,
  };
}

/** The six-class uncertainty taxonomy (F3). */
export async function readUncertaintyTaxonomy() {
  const module = await importTs("src/domain/uncertainty.ts");
  const byCategory = new Map(
    module.UNCERTAINTY_CATEGORIES.map((category) => [category, []]),
  );
  for (const [reason, category] of Object.entries(
    module.UNCERTAINTY_REASON_CATEGORY,
  )) {
    byCategory.get(category).push(reason);
  }
  return {
    categories: module.UNCERTAINTY_CATEGORIES,
    reasons: module.UNCERTAINTY_REASONS,
    byCategory,
  };
}

/** The test files each suite config actually runs. */
export async function readSuiteShapes() {
  const full = await importTs("vitest.config.ts");
  const foundation = await importTs("vitest.foundation.config.ts");
  const adversarial = await importTs("vitest.adversarial.config.ts");
  const performance = await importTs("vitest.performance.config.ts");
  const validation = await importTs("vitest.validation.config.ts");
  const gateFiles = foundation.default.test.include;

  // `npm test` is `src/**/*.test.ts` minus the wall-clock guards, which
  // are excluded by exact path. Counting the directory alone would
  // overstate the suite by however many files that list names.
  const excludedFromFullRun = (full.default.test.exclude ?? []).filter(
    (pattern) =>
      pattern.startsWith("src/") &&
      !pattern.includes("*") &&
      fs.existsSync(path.join(ROOT, pattern)),
  );

  return {
    gateFiles,
    gateFileCount: gateFiles.length,
    adversarialInclude: adversarial.default.test.include,
    performanceInclude: performance.default.test.include,
    validationInclude: validation.default.test.include,
    /** The `*.test.ts` files under `src/` that `npm test` actually runs. */
    unitTestFileCount:
      countTestFiles(path.join(ROOT, "src")) - excludedFromFullRun.length,
    excludedFromFullRun,
  };
}

function countTestFiles(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countTestFiles(path.join(dir, entry.name));
    else if (entry.name.endsWith(".test.ts")) total += 1;
  }
  return total;
}

/** The real-world validation / benchmark case list and its oracles. */
export function readValidationCases() {
  const cases = readJson("tests/validation/cases/cases.json");
  const list = Array.isArray(cases) ? cases : cases.cases;
  const byExpected = new Map();
  for (const testCase of list) {
    byExpected.set(
      testCase.expected,
      (byExpected.get(testCase.expected) ?? 0) + 1,
    );
  }
  return {
    total: list.length,
    knownFailures: list.filter((testCase) => testCase.knownFailure),
    byExpected,
    cases: list,
  };
}

/**
 * The serialized output contract: the verdict vocabulary and the three
 * negative-proof families, read from the schema that enforces them rather
 * than restated.
 */
export function readOutputContract() {
  const schema = readJson("schemas/result.schema.json");
  const finding = schema.properties.findings.items;
  // VT-CONTRACT-01's `oneOf` — one branch per family, each requiring its
  // own evidence object. Read from the clause that enforces exclusivity,
  // so a family added to the type but not to the contract does not appear.
  const proofFamilies = finding.allOf
    .flatMap((clause) => clause.then?.properties?.evidence?.oneOf ?? [])
    .flatMap((branch) => branch.required ?? [])
    .filter((name, index, all) => all.indexOf(name) === index)
    .sort();
  if (proofFamilies.length === 0) {
    throw new Error(
      "result.schema.json: found no negative-proof families in VT-CONTRACT-01's oneOf",
    );
  }
  return {
    verdicts: finding.properties.verdict.enum,
    proofFamilies,
    topLevelProperties: Object.keys(schema.properties).sort(),
    findingProperties: Object.keys(finding.properties).sort(),
  };
}

/** The npm scripts the documentation is allowed to reference. */
export function readScripts() {
  return Object.entries(readJson("package.json").scripts)
    .map(([name, command]) => ({
      name,
      command,
      ...classifyScript(name, command),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The findings register's own status table (`tests/validation/FINDINGS.md`,
 * `## Status`).
 *
 * THE DESIGNATED FIELD. A row's status is read from exactly one place: the
 * `Status` column (the fifth cell) of that table, whose header must be
 * exactly `FINDINGS_STATUS_HEADER`. Nothing else in a row, and nothing
 * outside the table, is ever consulted to decide a status. A header that
 * moves, a row whose cell count differs from the header's, a malformed or
 * duplicated id -- each is an error, never a best-effort parse.
 *
 * THE STATUS VALUE is the leading phrase of that cell: markdown emphasis
 * (`*`, `_`) is stripped, then the text runs up to the first `—`, `–`,
 * `;`, `,`, `:`, `.` or `(`, and is lower-cased with hyphens read as
 * spaces. So `**Fixed (RWF-046)** — see below` has the value `fixed`, and
 * `Open — classified, not fixed` has the value `open`. What follows the
 * value is commentary for the reader, and is never classified.
 *
 * THE VOCABULARY is closed: `FINDINGS_STATUS_VOCABULARY` lists every
 * accepted value and the one category it maps to. A value that is not
 * listed is an ERROR naming the row and the value. It is never defaulted
 * to a category, and above all never to fixed: adding a value means adding
 * it to the vocabulary, deliberately, with the category that cannot
 * overstate closure.
 *
 * EVERY FINDING IS COUNTED. The ids with a `## <ID>` section and the ids
 * with a status row must be the same set; a mismatch either way is an
 * error naming the id (`sectionRowProblems`).
 *
 * ONE TRIPWIRE, AND IT CAN ONLY REFUSE. A cell whose value is `fixed` but
 * whose commentary says the fix is incomplete ("not fixed", "in part",
 * "partially", "open", "remains", "outstanding") contradicts itself; that
 * is an error too, because the classifier must not decide which half the
 * author meant. The tripwire never places a row in any category.
 *
 * History, for why this is structural. The first classifier asked whether
 * a status began with "Open", and filed RWF-002 ("…the underlying
 * tradeoff remains open") as closed. Its replacement matched prose
 * (`/^Open\b/i`, `/\bfixed\b/i`) and filed RWF-047 -- a reproduced,
 * open soundness defect whose cell read `**OPEN — classified, not
 * fixed**` -- as FIXED (`tests/validation/FINDINGS.md`, RWF-047 § 6).
 * Every widening of a prose pattern is defeated by the next honest
 * rewording; a closed vocabulary over one field is not.
 */
export function readFindingsRegister() {
  return classifyFindingsRegister(
    fs.readFileSync(path.join(ROOT, "tests/validation/FINDINGS.md"), "utf-8"),
  );
}

/** The exact header the status table must carry, in order. */
export const FINDINGS_STATUS_HEADER = Object.freeze([
  "ID",
  "Package",
  "Root cause",
  "Impact",
  "Status",
]);

/**
 * Every accepted status value, and the one category it maps to.
 *
 * - `open`: wholly outstanding.
 * - `partlyOpen`: partly discharged and partly outstanding. It is OPEN for
 *   every purpose that asks "is anything left?" -- a finding only partly
 *   fixed is not fixed.
 * - `fixed`: wholly discharged.
 *
 * The two scoped entries (`bypassed for unloaded packages`, `fixed for
 * variable bindings`) are existing rows' qualified values (RWF-002,
 * RWF-013). A fix or bypass scoped to part of a finding does not by itself
 * say the rest is closed, so they map to `partlyOpen` -- the category that
 * cannot overstate closure -- whatever another row may say about the rest.
 */
export const FINDINGS_STATUS_VOCABULARY = new Map([
  ["open", "open"],
  ["not fixed", "open"],
  ["open in part", "partlyOpen"],
  ["fixed in part", "partlyOpen"],
  ["partially fixed", "partlyOpen"],
  ["bypassed for unloaded packages", "partlyOpen"],
  ["fixed for variable bindings", "partlyOpen"],
  ["fixed", "fixed"],
]);

/** Commentary that contradicts a `fixed` value. Used only to refuse. */
const INCOMPLETE_FIX =
  /\bnot\s+(?:yet\s+)?(?:fully\s+)?fixed\b|\bunfixed\b|\bpartial(?:ly)?\b|\bin[\s-]part\b|\bopen\b|\bremains?\b|\bremaining\b|\boutstanding\b/i;

const ROW_ID = /^[A-Z]+-\d+[a-z]?$/;

/**
 * Splits one markdown table row into its trimmed cells, or `undefined` when
 * the line is not a `| a | b |` row. A `|` inside a code span or escaped as
 * `\|` does not split.
 */
function tableCells(line) {
  const cells = [];
  let current = "";
  let inCode = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === "\\" && line[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "`") {
      inCode = !inCode;
      current += char;
    } else if (char === "|" && !inCode) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  if (cells.length < 3 || cells[0] !== "" || cells[cells.length - 1] !== "") {
    return undefined;
  }
  return cells.slice(1, -1);
}

/** The status value of one Status cell (see `readFindingsRegister`). */
export function findingsStatusValue(cell) {
  return cell
    .replace(/[*_]/g, "")
    .split(/[—–;,:.(]/)[0]
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * The classification itself, over the text of `FINDINGS.md`, so it can be
 * exercised without the committed file (`src/testing/findings-status.test.ts`).
 */
export function classifyFindingsRegister(text) {
  const lines = text.split("\n");
  const heading = lines.indexOf("## Status");
  if (heading < 0) throw new Error("FINDINGS.md: no '## Status' section");

  // The table is the first table under the heading. Prose above it (the
  // note naming this field and vocabulary) is allowed; another heading
  // before it is not.
  let cursor = heading + 1;
  while (cursor < lines.length && !lines[cursor].startsWith("|")) {
    if (lines[cursor].startsWith("#")) {
      throw new Error(
        "FINDINGS.md: '## Status' has no table before the next heading",
      );
    }
    cursor += 1;
  }
  const header = tableCells(lines[cursor] ?? "");
  if (
    header === undefined ||
    header.join(" | ") !== FINDINGS_STATUS_HEADER.join(" | ")
  ) {
    throw new Error(
      "FINDINGS.md: the status table's header must be exactly " +
        `"| ${FINDINGS_STATUS_HEADER.join(" | ")} |", found ` +
        JSON.stringify(lines[cursor] ?? ""),
    );
  }
  const separator = tableCells(lines[cursor + 1] ?? "");
  if (
    separator === undefined ||
    separator.length !== header.length ||
    !separator.every((cell) => /^:?-+:?$/.test(cell))
  ) {
    throw new Error(
      "FINDINGS.md: the status table's header has no separator row",
    );
  }

  const statusColumn = FINDINGS_STATUS_HEADER.indexOf("Status");
  const rows = [];
  const problems = [];
  const seen = new Set();
  for (const line of lines.slice(cursor + 2)) {
    if (!line.startsWith("|")) break;
    const cells = tableCells(line);
    const id = cells?.[0] ?? line.slice(0, 40);
    if (cells === undefined || cells.length !== header.length) {
      problems.push(
        `${id}: the row has ${cells?.length ?? "no"} cells; the header has ${header.length}`,
      );
      continue;
    }
    if (!ROW_ID.test(id)) {
      problems.push(
        `${JSON.stringify(id)}: not a register id (e.g. RWF-047, AUD-01)`,
      );
      continue;
    }
    if (seen.has(id)) {
      problems.push(`${id}: appears in the status table more than once`);
      continue;
    }
    seen.add(id);

    const status = cells[statusColumn];
    const value = findingsStatusValue(status);
    const category = FINDINGS_STATUS_VOCABULARY.get(value);
    if (category === undefined) {
      problems.push(
        `${id}: status value ${JSON.stringify(value)} is not in the ` +
          `vocabulary (cell: ${JSON.stringify(status)})`,
      );
      continue;
    }
    if (
      category === "fixed" &&
      INCOMPLETE_FIX.test(status.replace(/[*_]/g, ""))
    ) {
      problems.push(
        `${id}: status value "fixed" is contradicted by its own cell, ` +
          "which says the fix is incomplete -- use an open or open-in-part " +
          `value (cell: ${JSON.stringify(status)})`,
      );
      continue;
    }
    rows.push({ id, status, value, category, impact: cells[3] });
  }
  problems.push(...sectionRowProblems(lines, rows));

  if (problems.length > 0) {
    throw new Error(
      `FINDINGS.md: ${problems.length} register problem(s). Every finding ` +
        "section needs a status-table row and every row a section; a status " +
        "is read from the Status column only, and its " +
        "value must be one of " +
        [...FINDINGS_STATUS_VOCABULARY.keys()]
          .map((value) => JSON.stringify(value))
          .join(", ") +
        " (FINDINGS_STATUS_VOCABULARY, scripts/scorecard-sources.mjs). " +
        "Never default a row -- classify it:\n" +
        problems.map((problem) => `  ${problem}`).join("\n"),
    );
  }
  if (rows.length === 0) throw new Error("FINDINGS.md: status table is empty");

  const open = rows.filter((row) => row.category === "open");
  const partlyOpen = rows.filter((row) => row.category === "partlyOpen");
  const fixed = rows.filter((row) => row.category === "fixed");

  // The partition invariant, asserted rather than assumed. If the three
  // buckets ever stop summing to the parsed row count, the scorecard is
  // under-reporting the register and must not be generated at all.
  const classified = open.length + partlyOpen.length + fixed.length;
  if (classified !== rows.length) {
    throw new Error(
      `FINDINGS.md: ${classified} classified rows != ${rows.length} parsed ` +
        "rows. Every register row must be classified exactly once.",
    );
  }

  return { rows, open, partlyOpen, fixed };
}

/** A finding section's heading: `## RWF-049 — …`, `## AUD-01 — …`. */
const SECTION_ID = /^## ([A-Z]+-\d+[a-z]?)\b/;

/**
 * Every finding id with a `##` section and every id with a status row must
 * be the same set. A section with no row is in no count at all -- that is
 * how nineteen findings, one of them open, were invisible to the
 * scorecard -- and a row with no section is a status nobody can check.
 * Both are errors naming the id. There is no allowlist: the fix is always
 * to the data.
 */
function sectionRowProblems(lines, rows) {
  const sections = new Set(
    lines
      .map((line) => SECTION_ID.exec(line)?.[1])
      .filter((id) => id !== undefined),
  );
  const tabled = new Set(rows.map((row) => row.id));
  return [
    ...[...sections]
      .filter((id) => !tabled.has(id))
      .map((id) => `${id}: has a "## ${id}" section but no status-table row`),
    ...[...tabled]
      .filter((id) => !sections.has(id))
      .map((id) => `${id}: has a status-table row but no "## ${id}" section`),
  ];
}

/**
 * Whether an npm script reaches the network, derived from what it runs
 * rather than from a list of names somebody has to remember to update.
 *
 * The one live suite inside the default vitest run is
 * `src/vulnerabilities/osv-provider.integration.test.ts`, which queries
 * OSV unconditionally. So any vitest invocation that does not exclude the
 * integration tests, and does not point at an offline config, includes it.
 */
export function classifyScript(name, command) {
  if (!/\bvitest\b/.test(command)) {
    return { deterministic: true, network: false };
  }
  if (/vitest\.validation\.config\.ts/.test(command)) {
    return { deterministic: false, network: true, why: "live OSV" };
  }
  if (/vitest\.performance\.config\.ts/.test(command)) {
    return {
      deterministic: false,
      network: false,
      why: "wall-clock: shape deterministic, timing environmental",
    };
  }
  if (
    /vitest\.foundation\.config\.ts|vitest\.adversarial\.config\.ts|vitest\.binding-grammar\.config\.ts/.test(
      command,
    )
  ) {
    return { deterministic: true, network: false };
  }
  if (/--exclude\s+\\?"?\*\*\/\*\.integration\.test\.ts/.test(command)) {
    return { deterministic: true, network: false };
  }
  return {
    deterministic: false,
    network: true,
    why: "includes the live OSV provider integration suite",
  };
}

/** The recorded results of commands that had to actually be run. */
export function readMeasurements() {
  return readJson("docs/scorecard-data/measurements.json");
}
