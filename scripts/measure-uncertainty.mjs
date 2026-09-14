/**
 * FOUNDATION F3 § 29-§ 32 -- measures the UNCERTAINTY DISTRIBUTION of the
 * real-world validation corpus.
 *
 * This is the one output F3 exists to produce. P1-B (frontend
 * completeness) has to be prioritized from evidence rather than from
 * intuition, and until now the evidence did not exist in a form anything
 * could count: an UNKNOWN carried prose, so "how much of our UNKNOWN
 * surface is a coverage gap we could close?" could only be answered by
 * reading scan output by hand.
 *
 * DELIBERATELY NOT A BENCHMARK-RUNNER REDESIGN (F3 § 29). It reuses the
 * existing validation fixtures and the existing CLI, runs each case
 * exactly as `tests/validation/validation.test.ts` does, and aggregates
 * what the scan already reports. Nothing here re-analyses anything.
 *
 * Usage:  node scripts/measure-uncertainty.mjs [--json]
 *
 * Hits the live OSV API, exactly as the validation suite does, so it needs
 * network access and takes a couple of minutes.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const casesPath = path.join(root, "tests/validation/cases/cases.json");
const cases = JSON.parse(fs.readFileSync(casesPath, "utf-8"));

const emitJson = process.argv.includes("--json");

/**
 * One scan, run EXACTLY as `tests/validation/validation.test.ts` runs it.
 *
 * The fixture is copied to a fresh OS-temp directory first (VT-302 /
 * RWF-010). That is not tidiness: a fixture scanned in place inherits
 * VulnTrace's OWN repository as an ancestor, so `ts.resolveModuleName`'s
 * upward `node_modules` walk finds this project's dependencies, and the
 * measurement would then describe a project nobody has.
 */
function scan(testCase) {
  const source = path.join(root, "tests/validation/fixtures", testCase.dir);
  const dest = fs.mkdtempSync(
    path.join(os.tmpdir(), `vulntrace-f3-measure-${testCase.id}-`),
  );
  try {
    fs.cpSync(source, dest, { recursive: true, dereference: false });
    const args = [
      path.join(root, "dist/cli.js"),
      "scan",
      dest,
      "--config",
      path.join(dest, "vulntrace.yml"),
    ];
    let stdout;
    try {
      stdout = execFileSync(process.execPath, args, {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      // A non-zero exit is normal: exit 1 means "an AFFECTED was found".
      stdout = error.stdout;
    }
    return stdout ? JSON.parse(stdout) : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

const totals = {
  cases: 0,
  scansCompleted: 0,
  findings: 0,
  unknownFindings: 0,
  unknownWithReasons: 0,
  unreportedCandidates: 0,
  unreportedUndetermined: 0,
  unreportedNotApplicable: 0,
};

/** category -> count of OCCURRENCES */
const byCategory = new Map();
/** category -> reason -> count of OCCURRENCES */
const byReason = new Map();
/** reason -> number of distinct UNKNOWN FINDINGS it blocks */
const findingsBlockedBy = new Map();
/** no-finding reason -> occurrences */
const noFindingReasons = new Map();
/** per-case detail, for the RWB-05 / RWF-002 question */
const perCase = [];

const bump = (map, key, amount = 1) =>
  map.set(key, (map.get(key) ?? 0) + amount);

for (const testCase of cases) {
  totals.cases += 1;
  const output = scan(testCase);
  if (!output) {
    perCase.push({ id: testCase.id, error: "scan produced no parsable output" });
    continue;
  }
  totals.scansCompleted += 1;
  totals.findings += output.findings.length;

  const caseCategories = new Map();
  const caseReasons = new Map();

  for (const finding of output.findings) {
    if (finding.verdict !== "UNKNOWN") {
      continue;
    }
    totals.unknownFindings += 1;
    const reasons = finding.unknownReasons ?? [];
    if (reasons.length > 0) {
      totals.unknownWithReasons += 1;
    }
    for (const entry of reasons) {
      bump(byCategory, entry.category, entry.count);
      if (!byReason.has(entry.category)) {
        byReason.set(entry.category, new Map());
      }
      bump(byReason.get(entry.category), entry.reason, entry.count);
      bump(findingsBlockedBy, entry.reason);
      bump(caseCategories, entry.category, entry.count);
      bump(caseReasons, entry.reason, entry.count);
    }
  }

  for (const candidate of output.unreportedCandidates ?? []) {
    totals.unreportedCandidates += 1;
    if (candidate.disposition === "undetermined") {
      totals.unreportedUndetermined += 1;
    } else {
      totals.unreportedNotApplicable += 1;
    }
    bump(noFindingReasons, `${candidate.disposition}:${candidate.reason}`);
  }

  perCase.push({
    id: testCase.id,
    verdicts: output.findings.map((f) => f.verdict),
    unknownFindings: output.findings.filter((f) => f.verdict === "UNKNOWN").length,
    categories: Object.fromEntries(caseCategories),
    reasons: Object.fromEntries(caseReasons),
    unreportedCandidates: (output.unreportedCandidates ?? []).map((c) => ({
      disposition: c.disposition,
      reason: c.reason,
      package: c.package,
    })),
  });
}

const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

const report = {
  totals,
  byCategory: Object.fromEntries(sortDesc(byCategory)),
  byReason: Object.fromEntries(
    [...byReason.entries()].map(([category, reasons]) => [
      category,
      Object.fromEntries(sortDesc(reasons)),
    ]),
  ),
  findingsBlockedBy: Object.fromEntries(sortDesc(findingsBlockedBy)),
  noFindingReasons: Object.fromEntries(sortDesc(noFindingReasons)),
  perCase,
};

if (emitJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("=== F3 UNCERTAINTY DISTRIBUTION (real-world corpus) ===\n");
  console.log(`cases:                 ${totals.cases}`);
  console.log(`scans completed:       ${totals.scansCompleted}`);
  console.log(`findings:              ${totals.findings}`);
  console.log(`UNKNOWN findings:      ${totals.unknownFindings}`);
  console.log(
    `  ...with reasons:     ${totals.unknownWithReasons} (must equal UNKNOWN findings)`,
  );
  console.log(`unreported candidates: ${totals.unreportedCandidates}`);
  console.log(`  undetermined:        ${totals.unreportedUndetermined}`);
  console.log(`  not_applicable:      ${totals.unreportedNotApplicable}`);

  console.log("\n--- by category (occurrences) ---");
  for (const [category, count] of sortDesc(byCategory)) {
    console.log(`  ${category.padEnd(30)} ${count}`);
  }

  console.log("\n--- by specific reason (occurrences) ---");
  for (const [category, reasons] of byReason) {
    console.log(`  ${category}`);
    for (const [reason, count] of sortDesc(reasons)) {
      console.log(`    ${reason.padEnd(44)} ${count}`);
    }
  }

  console.log("\n--- UNKNOWN findings blocked by each reason ---");
  for (const [reason, count] of sortDesc(findingsBlockedBy)) {
    console.log(`  ${reason.padEnd(46)} ${count}`);
  }

  console.log("\n--- no-finding reasons ---");
  for (const [reason, count] of sortDesc(noFindingReasons)) {
    console.log(`  ${reason.padEnd(60)} ${count}`);
  }

  console.log("\n--- per case ---");
  for (const entry of perCase) {
    if (entry.error) {
      console.log(`  ${entry.id.padEnd(10)} ERROR: ${entry.error}`);
      continue;
    }
    console.log(
      `  ${entry.id.padEnd(10)} verdicts=[${entry.verdicts.join(",")}] ` +
        `unknown=${entry.unknownFindings} ` +
        `reasons=${JSON.stringify(entry.reasons)} ` +
        `nofinding=${entry.unreportedCandidates.length}`,
    );
  }
}
