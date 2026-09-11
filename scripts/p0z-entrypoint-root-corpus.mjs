// P0-Z entrypoint root-completeness corpus measurement.
//
// Walks every vendored JS/CJS/MJS/TS file reachable from fixtures/ and asks
// the production `entrypointRootCandidates` whether that file, IF it were a
// configured entrypoint, would yield concretely derived reachability roots
// or an incomplete derivation.
//
// It reports counts only -- it makes no claim about verdicts, which are
// measured by the focused suites and the canonical validation baseline. The
// point is to size the population the fix can affect: only a file that both
// (a) is a configured entrypoint and (b) derives roots incompletely can lose
// a Family C proof.

import fs from "node:fs";
import path from "node:path";
import { buildModuleModel, entrypointRootCandidates } from "../dist/code-intelligence/module-model.js";
import { indexSourceFileFromDisk } from "../dist/code-intelligence/source-index.js";

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) ROOTS.push("fixtures");

const EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

let scanned = 0;
let failed = 0;
let withExports = 0;
let complete = 0;
let incomplete = 0;
const byReason = new Map();
const incompleteFiles = [];

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    scanned += 1;
    let candidates;
    let model;
    try {
      const index = indexSourceFileFromDisk(file);
      model = buildModuleModel(index);
      candidates = entrypointRootCandidates(index, model);
    } catch {
      failed += 1;
      continue;
    }
    if (model.exports.length > 0) withExports += 1;
    if (candidates.complete) {
      complete += 1;
    } else {
      incomplete += 1;
      incompleteFiles.push(file);
      for (const item of candidates.incompleteness) {
        byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1);
      }
    }
  }
}

console.log("P0-Z entrypoint root-completeness corpus");
console.log("  roots scanned:            ", ROOTS.join(", "));
console.log("  files scanned:            ", scanned);
console.log("  files that failed to index:", failed);
console.log("  files with any export:    ", withExports);
console.log("  COMPLETE root derivation: ", complete);
console.log("  INCOMPLETE root derivation:", incomplete);
for (const [reason, count] of [...byReason].sort()) {
  console.log(`    ${reason}: ${count}`);
}
console.log("\n  candidate entrypoints with incomplete root derivation:");
for (const file of incompleteFiles) {
  console.log("   ", path.relative(process.cwd(), file));
}
