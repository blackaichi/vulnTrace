// P1-A4 workspace / monorepo corpus measurement.
//
// Measures, over every vendored `package.json` in the given roots (default:
// the repository's own fixture corpora), how many manifests declare a
// `workspaces` field and in which SHAPE, plus how many workspace packages
// each declaration actually yields.
//
// These are PREVALENCE counts for these corpora only. They are not claims
// about npm at large, they imply nothing about any verdict, and fixture
// coverage must never be extrapolated into ecosystem coverage.
//
// Nothing here builds a call graph, runs a reachability search, or executes
// any target code. Verdict movements are measured by the focused suites and
// the canonical validation baseline, and nowhere else.
//
// Usage:
//   node scripts/p1a4-workspace-corpus.mjs [root ...]

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const roots =
  process.argv.slice(2).length > 0
    ? process.argv.slice(2).map((p) => path.resolve(p))
    : [
        path.join(REPO_ROOT, "tests", "validation", "fixtures"),
        path.join(REPO_ROOT, "fixtures"),
      ];

/** Every `package.json` below `dir`, including inside `node_modules`. */
function manifests(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      manifests(full, out);
    } else if (entry.name === "package.json") {
      out.push(full);
    }
  }
  return out;
}

/**
 * The declaration SHAPE, using the same two spellings
 * `dependencies/workspaces.ts` accepts -- and reporting anything else as
 * `unsupported` rather than guessing at it.
 */
function shapeOf(workspaces) {
  if (workspaces === undefined || workspaces === null) return "absent";
  if (Array.isArray(workspaces)) {
    return workspaces.every((entry) => typeof entry === "string")
      ? "array"
      : "unsupported";
  }
  if (typeof workspaces === "object" && Array.isArray(workspaces.packages)) {
    return workspaces.packages.every((entry) => typeof entry === "string")
      ? "object"
      : "unsupported";
  }
  return "unsupported";
}

/** The three pattern shapes this analyzer interprets; everything else fails closed. */
function patternSupported(pattern) {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  if (path.isAbsolute(pattern) || pattern.startsWith("/")) return false;
  if (/[?[\]{}()!+@]/.test(pattern)) return false;
  const segments = pattern.split(/[\\/]+/).filter((s) => s !== ".");
  if (segments.length === 0 || segments.some((s) => s === "..")) return false;
  const last = segments[segments.length - 1];
  if (segments.slice(0, -1).some((s) => s.includes("*"))) return false;
  return last === "*" || last === "**" || !last.includes("*");
}

const counts = {
  manifestsExamined: 0,
  unreadable: 0,
  declaringWorkspaces: 0,
  arrayForm: 0,
  objectForm: 0,
  unsupportedShape: 0,
  patternsDeclared: 0,
  patternsSupported: 0,
  patternsUnsupported: 0,
  scopedNames: 0,
};
const declarations = [];

for (const root of roots) {
  for (const file of manifests(root)) {
    counts.manifestsExamined += 1;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      counts.unreadable += 1;
      continue;
    }
    if (typeof manifest.name === "string" && manifest.name.startsWith("@")) {
      counts.scopedNames += 1;
    }
    const shape = shapeOf(manifest.workspaces);
    if (shape === "absent") continue;

    counts.declaringWorkspaces += 1;
    if (shape === "array") counts.arrayForm += 1;
    else if (shape === "object") counts.objectForm += 1;
    else counts.unsupportedShape += 1;

    const patterns =
      shape === "array"
        ? manifest.workspaces
        : shape === "object"
          ? manifest.workspaces.packages
          : [];
    let supported = 0;
    for (const pattern of patterns) {
      counts.patternsDeclared += 1;
      if (patternSupported(pattern)) {
        counts.patternsSupported += 1;
        supported += 1;
      } else {
        counts.patternsUnsupported += 1;
      }
    }
    declarations.push({
      manifest: path.relative(REPO_ROOT, file),
      shape,
      patterns,
      supportedPatterns: supported,
    });
  }
}

process.stdout.write(
  JSON.stringify({ roots, counts, declarations }, null, 2) + "\n",
);

if (counts.declaringWorkspaces === 0) {
  process.stdout.write(
    "\nNo manifest in these roots declares `workspaces`. This corpus cannot\n" +
      "validate or measure workspace behavior; do not read fixture coverage\n" +
      "as ecosystem coverage.\n",
  );
}
