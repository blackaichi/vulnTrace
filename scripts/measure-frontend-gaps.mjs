/**
 * P1-B1/P1-B2 -- measures the FRONTEND GAP DISTRIBUTION of the real-world
 * corpus, per `unsupported_*` subtype.
 *
 * The companion to `measure-uncertainty.mjs`, which answers "which KIND OF
 * WORK is our UNKNOWN surface?" (the six F3 categories). This answers the
 * next question down, the one P1-B has to be prioritized from: *within*
 * the frontend coverage gap, WHICH construct is the analyzer failing to
 * model, how often, and in how many different projects.
 *
 * TWO NUMBERS PER SUBTYPE, AND CONFUSING THEM IS THE WHOLE TRAP.
 *
 * - **graph-wide occurrences** come from `diagnostics`, which carries one
 *   entry per unresolved edge ANYWHERE the graph builder walked. This is
 *   the shape of the JavaScript the analyzer meets. It is NOT a work
 *   queue: most of it is in code no vulnerable target is on.
 * - **blocking occurrences** come from `findings[].unknownReasons`, i.e.
 *   only the edges a reachability search for a real vulnerable target
 *   actually traversed. This is the subset that costs a verdict.
 *
 * The two rank the subtypes DIFFERENTLY in this corpus, which is exactly
 * why both are printed and why neither is printed as a percentage alone
 * (P1-B1 § 20). A subtype can be the most common construct in the world
 * and block nothing.
 *
 * EXCLUDED BY CONSTRUCTION. `no_vulnerable_symbol_rule` and every other
 * non-frontend reason never appear here: this tool reports the
 * `unsupported_*` family and nothing else, so a corpus/config artifact
 * cannot be read as an analyzer coverage gap (P1-B1 § 8/§ 9).
 *
 * Usage:  node scripts/measure-frontend-gaps.mjs [--json]
 *
 * Hits the live OSV API, exactly as the validation suite does.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const cases = JSON.parse(
  fs.readFileSync(path.join(root, "tests/validation/cases/cases.json"), "utf-8"),
);
const emitJson = process.argv.includes("--json");

/** See `measure-uncertainty.mjs` for why the fixture is copied out first. */
function scan(testCase) {
  const source = path.join(root, "tests/validation/fixtures", testCase.dir);
  const dest = fs.mkdtempSync(
    path.join(os.tmpdir(), `vulntrace-p1b1-${testCase.id}-`),
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
      stdout = error.stdout;
    }
    return stdout ? { output: JSON.parse(stdout), dest } : undefined;
  } catch {
    return undefined;
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

/**
 * A call-graph diagnostic reads `"<reason> at <file>#<symbol>@<line>:<col>"`.
 * Splitting it gives the three granularities § 21/§ 23 require: the
 * occurrence, the distinct SITE it happened at, and the distinct package
 * that site lives in.
 */
function parseDiagnostic(message) {
  const at = message.indexOf(" at ");
  if (at < 0) return undefined;
  const reason = message.slice(0, at);
  const node = message.slice(at + 4);
  const hash = node.indexOf("#");
  const file = hash < 0 ? node : node.slice(0, hash);
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(file);
  return { reason, node, file, pkg: match ? match[1] : "<application>" };
}

const isFrontendGap = (reason) => reason.startsWith("unsupported_");

const subtypes = new Map();
const ensure = (reason) => {
  let entry = subtypes.get(reason);
  if (!entry) {
    entry = {
      reason,
      occurrences: 0,
      blocking: 0,
      fixtures: new Set(),
      blockingFixtures: new Set(),
      packages: new Set(),
      sites: new Set(),
      files: new Set(),
    };
    subtypes.set(reason, entry);
  }
  return entry;
};

const perCase = [];
let scansCompleted = 0;

for (const testCase of cases) {
  const result = scan(testCase);
  if (!result) {
    perCase.push({ id: testCase.id, error: "no parsable output" });
    continue;
  }
  scansCompleted += 1;
  const { output } = result;

  const caseOccurrences = new Map();
  for (const diagnostic of output.diagnostics ?? []) {
    if (diagnostic.source !== "call-graph") continue;
    const parsed = parseDiagnostic(diagnostic.message);
    if (!parsed || !isFrontendGap(parsed.reason)) continue;
    const entry = ensure(parsed.reason);
    entry.occurrences += 1;
    entry.fixtures.add(testCase.id);
    entry.packages.add(parsed.pkg);
    entry.sites.add(parsed.node);
    entry.files.add(parsed.file);
    caseOccurrences.set(
      parsed.reason,
      (caseOccurrences.get(parsed.reason) ?? 0) + 1,
    );
  }

  const caseBlocking = new Map();
  for (const finding of output.findings ?? []) {
    if (finding.verdict !== "UNKNOWN") continue;
    for (const item of finding.unknownReasons ?? []) {
      if (!isFrontendGap(item.reason)) continue;
      const entry = ensure(item.reason);
      entry.blocking += item.count;
      entry.blockingFixtures.add(testCase.id);
      caseBlocking.set(
        item.reason,
        (caseBlocking.get(item.reason) ?? 0) + item.count,
      );
    }
  }

  perCase.push({
    id: testCase.id,
    occurrences: Object.fromEntries(caseOccurrences),
    blocking: Object.fromEntries(caseBlocking),
  });
}

const rows = [...subtypes.values()].sort(
  (a, b) => b.occurrences - a.occurrences || a.reason.localeCompare(b.reason),
);
const totalOccurrences = rows.reduce((n, r) => n + r.occurrences, 0);
const totalBlocking = rows.reduce((n, r) => n + r.blocking, 0);

const report = {
  cases: cases.length,
  scansCompleted,
  totalOccurrences,
  totalBlocking,
  genericFallbackOccurrences:
    subtypes.get("unsupported_construct")?.occurrences ?? 0,
  genericFallbackBlocking: subtypes.get("unsupported_construct")?.blocking ?? 0,
  subtypes: rows.map((r) => ({
    reason: r.reason,
    occurrences: r.occurrences,
    blocking: r.blocking,
    distinctFixtures: r.fixtures.size,
    distinctBlockingFixtures: r.blockingFixtures.size,
    distinctPackages: r.packages.size,
    distinctSites: r.sites.size,
    distinctFiles: r.files.size,
    // Named, not just counted: § 23's project-concentration question is
    // "is this one library's idiom or a language-wide one?", and only the
    // names answer it.
    packages: [...r.packages].sort(),
    fixtures: [...r.fixtures].sort(),
  })),
  perCase,
};

if (emitJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log("=== P1-B1 FRONTEND GAP DISTRIBUTION (real-world corpus) ===\n");
  console.log(`cases:            ${report.cases}`);
  console.log(`scans completed:  ${report.scansCompleted}`);
  console.log(`graph-wide occurrences: ${totalOccurrences}`);
  console.log(`blocking occurrences:   ${totalBlocking}`);
  console.log(
    `generic fallback:       ${report.genericFallbackOccurrences} graph-wide / ${report.genericFallbackBlocking} blocking`,
  );

  console.log(
    "\nsubtype                            graph-wide  fixtures  pkgs  sites  blocking  blk-fixtures",
  );
  for (const r of report.subtypes) {
    console.log(
      [
        r.reason.padEnd(34),
        String(r.occurrences).padStart(10),
        String(r.distinctFixtures).padStart(9),
        String(r.distinctPackages).padStart(5),
        String(r.distinctSites).padStart(6),
        String(r.blocking).padStart(9),
        String(r.distinctBlockingFixtures).padStart(13),
      ].join(""),
    );
  }

  console.log("\n--- per case (graph-wide | blocking) ---");
  for (const entry of perCase) {
    if (entry.error) {
      console.log(`  ${entry.id.padEnd(10)} ERROR: ${entry.error}`);
      continue;
    }
    const sum = (o) => Object.values(o).reduce((n, v) => n + v, 0);
    console.log(
      `  ${entry.id.padEnd(10)} ${String(sum(entry.occurrences)).padStart(5)} | ${String(sum(entry.blocking)).padStart(4)}  ${JSON.stringify(entry.blocking)}`,
    );
  }
}
