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
 * The RWF register's own status table (`tests/validation/FINDINGS.md`).
 *
 * The table is a committed markdown table with a fixed five-column shape,
 * not free prose: the parser below requires that shape and throws if the
 * table moves, rather than best-effort scraping around it.
 */
export function readFindingsRegister() {
  const text = fs.readFileSync(
    path.join(ROOT, "tests/validation/FINDINGS.md"),
    "utf-8",
  );
  const start = text.indexOf("\n## Status\n");
  if (start < 0) throw new Error("FINDINGS.md: no '## Status' section");
  const rows = [];
  for (const line of text.slice(start).split("\n")) {
    if (rows.length > 0 && !line.startsWith("| RWF-")) break;
    if (!line.startsWith("| RWF-")) continue;
    const cells = line.split(" | ");
    rows.push({
      id: cells[0].replace(/^\|\s*/, "").trim(),
      status: cells[4].replace(/\s*\|$/, "").trim(),
    });
  }
  if (rows.length === 0) throw new Error("FINDINGS.md: status table is empty");

  // ------------------------------------------------------------------
  // CLASSIFICATION IS TOTAL. Every row lands in exactly one bucket.
  //
  // This is the register's most consequential reading, and it has already
  // gone wrong once: an earlier version asked only whether a status began
  // with "Open", and so reported RWF-002 -- whose status reads "Bypassed
  // for unloaded packages (VT-307d); the underlying reachability-scoping
  // tradeoff remains open" -- as CLOSED.
  //
  // Widening the pattern is not the fix on its own, because the next
  // honest rewording defeats the next pattern just as quietly. The fix is
  // to refuse to guess: a status this function cannot classify is an
  // ERROR naming the row and its text, never a silent omission and never
  // a default bucket. A row that falls out of every bucket is precisely
  // how an open finding disappears from the scorecard while the totals
  // still look plausible.
  //
  // Deliberately NOT keyed on any RWF id. RWF-002 classifies because its
  // status is recognised, not because it is special-cased.
  // ------------------------------------------------------------------

  /** Partly discharged AND partly outstanding -- both halves must be said. */
  const isPartlyOpen = (status) =>
    /\bremains?\b[^.]*\bopen\b|\bstill\b[^.]*\bopen\b|\bopen\b[^.]*\bremains?\b/i.test(
      status,
    ) && /fixed|bypassed|partial|mitigated/i.test(status);

  /** Wholly outstanding. */
  const isOpen = (status) => /^Open\b/i.test(status) && !isPartlyOpen(status);

  /** Wholly discharged. */
  const isFixed = (status) =>
    /\bfixed\b/i.test(status) && !isOpen(status) && !isPartlyOpen(status);

  const open = [];
  const partlyOpen = [];
  const fixed = [];
  const unclassified = [];

  for (const row of rows) {
    if (isPartlyOpen(row.status)) partlyOpen.push(row);
    else if (isOpen(row.status)) open.push(row);
    else if (isFixed(row.status)) fixed.push(row);
    else unclassified.push(row);
  }

  if (unclassified.length > 0) {
    throw new Error(
      `FINDINGS.md: the status of ${unclassified.length} register row(s) ` +
        "could not be classified as open, open-in-part or fixed. Classify " +
        "the row, or teach `readFindingsRegister` the wording -- do not " +
        "leave it out of the scorecard:\n" +
        unclassified
          .map((row) => `  ${row.id}: ${JSON.stringify(row.status)}`)
          .join("\n"),
    );
  }

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
    /vitest\.foundation\.config\.ts|vitest\.adversarial\.config\.ts/.test(
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
