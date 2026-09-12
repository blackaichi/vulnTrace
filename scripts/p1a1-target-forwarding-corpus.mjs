// P1-A1 target-side re-export corpus measurement.
//
// Walks every vendored JS/CJS/MJS/TS file reachable from the given roots
// (default: the repository's own fixture corpora) and asks the production
// `exportForwardingHops` relation, for each name that file exports, whether
// that export is FORWARDED from another module rather than declared locally
// -- then FOLLOWS each forwarding chain with the production module resolver
// and records where it actually ends up.
//
// WHAT THESE NUMBERS ARE, AND ARE NOT
//
// These are RESOLUTION measurements, not verdict improvements. Nothing here
// runs a reachability search, so no count below implies any finding changed
// from UNKNOWN to AFFECTED or NOT_AFFECTED. Verdicts are measured by the
// focused suites and the canonical validation baseline, and nowhere else.
//
// The distinction that matters most is between a forwarding hop EXISTING and
// a target actually being RESOLVED. A file can carry a perfectly exact
// forwarding hop whose chain then leaves the PackageInstance, hits a
// specifier that does not resolve, or dead-ends at a module that neither
// attributes the name nor forwards it further. None of those resolves a
// target. So "carrying an exact forwarding hop" is reported separately from
// "the chain terminates at an attributable implementation", and the former
// is an upper bound on the latter -- never a synonym for it.
//
// Even the terminal count is an upper bound on what the analyzer binds in
// production: `verdict.ts` additionally requires the implementation to have a
// node in the call graph for the scan actually being run. This script has no
// call graph, so it measures the static ceiling only.
//
// Usage: node scripts/p1a1-target-forwarding-corpus.mjs [roots...]

import fs from "node:fs";
import path from "node:path";
import { exportForwardingHops } from "../dist/code-intelligence/export-forwarding.js";
import {
  buildModuleModel,
  mapExportsToFunctions,
} from "../dist/code-intelligence/module-model.js";
import { createModuleResolver } from "../dist/code-intelligence/module-resolver.js";
import { indexSourceFileFromDisk } from "../dist/code-intelligence/source-index.js";
import { loadTsProject } from "../dist/code-intelligence/ts-project.js";
import { identifyModule } from "../dist/domain/resolved-target.js";

const ROOTS = process.argv.slice(2);
if (ROOTS.length === 0) {
  ROOTS.push("fixtures", "tests/validation/fixtures");
}

const EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"]);

/** A bound on chain length; the visited set already bounds it, this is belt-and-braces for a corpus walk. */
const MAX_HOPS = 16;

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

/**
 * The fixture project a corpus file belongs to -- `<root>/<fixture-name>`.
 * Each gets its own resolver, because module resolution is relative to a
 * project, and one shared resolver would answer a different question.
 */
function fixtureRootOf(root, file) {
  const rel = path.relative(root, file);
  const first = rel.split(path.sep)[0];
  return path.join(root, first);
}

const resolverByRoot = new Map();
function resolverFor(fixtureRoot) {
  let resolver = resolverByRoot.get(fixtureRoot);
  if (!resolver) {
    resolver = createModuleResolver(loadTsProject(fixtureRoot));
    resolverByRoot.set(fixtureRoot, resolver);
  }
  return resolver;
}

let scanned = 0;
let failed = 0;
let withExports = 0;
let exportNames = 0;
let locallyAttributable = 0;
// The population of interest: an exported name this file does NOT itself
// declare a function for.
let notLocallyAttributable = 0;
let hopCarrying = 0;
let noHop = 0;
const hopFiles = new Set();
const bySyntax = new Map();
const byShape = new Map();

// Chase outcomes, over the hop-carrying population only.
let terminatesAttributable = 0;
let leavesPackageInstance = 0;
let specifierUnresolved = 0;
let deadEnd = 0;

function bump(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * Follows one forwarding chain exactly the way `verdict.ts`'s target-side
 * chase does -- production resolver, same-PackageInstance gate, visited-set
 * cycle guard -- and reports where it stops.
 */
async function chase(startFile, startName, resolver, instance) {
  let file = startFile;
  let name = startName;
  const visited = new Set();

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const key = `${file}#${name}`;
    if (visited.has(key)) {
      return "dead-end";
    }
    visited.add(key);

    let index;
    let model;
    try {
      index = indexSourceFileFromDisk(file);
      model = buildModuleModel(index);
    } catch {
      return "dead-end";
    }
    if (mapExportsToFunctions(index, model).has(name)) {
      return "terminates";
    }
    const hops = exportForwardingHops(model, name);
    if (hops.length === 0) {
      return "dead-end";
    }
    const next = hops[0];
    const resolution = await resolver.resolve(next.specifier, file);
    if (resolution.kind !== "resolved") {
      return "specifier-unresolved";
    }
    if (
      identifyModule(resolution.resolvedFileName, undefined).packageInstance !==
      instance
    ) {
      return "leaves-instance";
    }
    file = resolution.resolvedFileName;
    name = next.exportName;
  }
  return "dead-end";
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
        .map(
          (exp) =>
            exp.exportedName ?? (exp.kind === "default" ? "default" : undefined),
        )
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
        noHop += 1;
        continue;
      }
      hopCarrying += 1;
      hopFiles.add(file);
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

      const fixtureRoot = fixtureRootOf(root, file);
      const instance = identifyModule(file, undefined).packageInstance;
      let outcome;
      try {
        outcome = await chase(file, name, resolverFor(fixtureRoot), instance);
      } catch {
        outcome = "specifier-unresolved";
      }
      if (outcome === "terminates") terminatesAttributable += 1;
      else if (outcome === "leaves-instance") leavesPackageInstance += 1;
      else if (outcome === "specifier-unresolved") specifierUnresolved += 1;
      else deadEnd += 1;
    }
  }
}

const lines = [
  `roots:                             ${ROOTS.join(", ")}`,
  `files scanned:                     ${scanned}`,
  `  unreadable/unparsable:           ${failed}`,
  `  with at least one export:        ${withExports}`,
  ``,
  `export names examined:             ${exportNames}`,
  `  locally attributable:            ${locallyAttributable}`,
  `  NOT locally attributable:        ${notLocallyAttributable}`,
  `    carrying an exact hop:         ${hopCarrying}   (upper bound -- a hop existing is not a target resolved)`,
  `    no hop (ambiguous/unsupported):${String(noHop).padStart(4)}   (stays UNKNOWN, by design)`,
  `  distinct files carrying a hop:   ${hopFiles.size}`,
  ``,
  `chain outcomes over the ${hopCarrying} hop-carrying names:`,
  `  terminates at an attributable implementation`,
  `    in the same PackageInstance:   ${terminatesAttributable}   (static ceiling on what can resolve)`,
  `  refused: hop leaves the PackageInstance: ${leavesPackageInstance}`,
  `  refused: specifier did not resolve:      ${specifierUnresolved}`,
  `  dead end (no further hop, or cycle):     ${deadEnd}`,
];
for (const [k, v] of [...bySyntax].sort()) lines.push(`  hop syntax ${k}: ${v}`);
for (const [k, v] of [...byShape].sort()) lines.push(`  hop shape  ${k}: ${v}`);
lines.push(
  ``,
  `These are RESOLUTION measurements, not verdict improvements: no count`,
  `above implies any finding changed verdict. See this file's header.`,
);

console.log(lines.join("\n"));
