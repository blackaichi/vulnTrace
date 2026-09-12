// P1-A1 target-side re-export corpus measurement.
//
// Walks every vendored JS/CJS/MJS/TS file reachable from the given roots
// (default: the repository's own fixture corpora) and asks the production
// `exportForwardingHops` relation, for each name that file exports, whether
// that export is FORWARDED from another module rather than declared locally.
//
// It reports counts only -- it makes no claim about verdicts, which are
// measured by the focused suites and the canonical validation baseline. The
// point is to size the population P1-A1's target-side chase can affect:
// only an export that (a) is named by an advisory target and (b) is
// forwarded rather than locally declared could previously fail to attribute.
//
// Usage: node scripts/p1a1-target-forwarding-corpus.mjs [roots...]

import fs from "node:fs";
import path from "node:path";
import { exportForwardingHops } from "../dist/code-intelligence/export-forwarding.js";
import {
  buildModuleModel,
  mapExportsToFunctions,
} from "../dist/code-intelligence/module-model.js";
import { indexSourceFileFromDisk } from "../dist/code-intelligence/source-index.js";

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) {
  ROOTS.push("fixtures", "tests/validation/fixtures");
}

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
let exportNames = 0;
let locallyAttributable = 0;
// The population of interest: an exported name this file does NOT itself
// declare a function for.
let notLocallyAttributable = 0;
let forwardingCandidates = 0;
let ambiguous = 0;
const bySyntax = new Map();
const byShape = new Map();
const candidateFiles = new Set();

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

for (const root of ROOTS) {
  if (!fs.existsSync(root)) continue;
  for (const file of walk(root)) {
    scanned += 1;
    let model;
    let index;
    try {
      index = indexSourceFileFromDisk(file);
      model = buildModuleModel(index);
    } catch {
      failed += 1;
      continue;
    }
    if (model.exports.length === 0) continue;
    withExports += 1;

    const attributable = mapExportsToFunctions(index, model);
    const names = new Set(
      model.exports
        .map((exp) => exp.exportedName ?? (exp.kind === "default" ? "default" : undefined))
        .filter((n) => typeof n === "string"),
    );

    for (const name of names) {
      exportNames += 1;
      if (attributable.has(name)) {
        locallyAttributable += 1;
        continue;
      }
      notLocallyAttributable += 1;

      const hops = exportForwardingHops(model, name);
      if (hops.length === 0) {
        // Not declared here AND not forwarded by any authoritative binding:
        // a dynamic/conditional/reassigned/star shape, or a non-callable
        // export. Stays unresolved -- which is the correct, fail-closed
        // outcome, not a gap this task widens.
        ambiguous += 1;
        continue;
      }
      forwardingCandidates += 1;
      candidateFiles.add(file);
      for (const hop of hops) {
        bump(bySyntax, hop.syntax);
        bump(
          byShape,
          hop.exportName === "default"
            ? "whole-module -> default"
            : hop.exportName === name
              ? "same-name forward"
              : "renamed forward",
        );
      }
    }
  }
}

const lines = [
  `roots:                        ${ROOTS.join(", ")}`,
  `files scanned:                ${scanned}`,
  `  unreadable/unparsable:      ${failed}`,
  `  with at least one export:   ${withExports}`,
  `export names examined:        ${exportNames}`,
  `  locally attributable:       ${locallyAttributable}`,
  `  NOT locally attributable:   ${notLocallyAttributable}`,
  `    exact forwarding hop:     ${forwardingCandidates}   <- the population P1-A1 can resolve`,
  `    ambiguous/unsupported:    ${ambiguous}   <- stays UNKNOWN, by design`,
  `distinct files with a hop:    ${candidateFiles.size}`,
];
for (const [k, v] of [...bySyntax].sort()) lines.push(`  syntax ${k}: ${v}`);
for (const [k, v] of [...byShape].sort()) lines.push(`  shape  ${k}: ${v}`);

console.log(lines.join("\n"));
