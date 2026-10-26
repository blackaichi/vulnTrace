// BL-110 structural performance measurement
// (docs/tasks/BL-110-module-paths-allow-list.md): what the lookup list's
// use check costs the loader classifier, counted in resolution steps, never
// in wall clock alone (ARCHITECTURE § 10.2).
//
// For every `.js` / `.cjs` / `.mjs` file under each root, runs
// `findClosureWideningConstructs` with the base build's analyzer and with
// this tree's, and reads `loaderCapabilityResolutionCount()` (every step of
// `resolveLoaderCapability`, recursive ones included) around each run. The
// base build needs the counter: a base checkout with only the counter
// applied (`let loaderCapabilityResolutions`, its increment and the
// exported reader, as in this tree), built with `npx tsc -p
// tsconfig.build.json`. It reports the total steps on each side, the
// ratio, the files with the largest head/base ratio, and the largest
// head count per file against the file's node count.
//
// Usage:
//   node scripts/bl110-resolution-steps-corpus.mjs --base-dist <dir> \
//     [--head-dist <dir>] [roots...]

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const args = process.argv.slice(2);
function option(name) {
  const at = args.indexOf(name);
  if (at < 0) {
    return undefined;
  }
  const [value] = args.splice(at, 2).slice(1);
  return value;
}
const baseDist = option("--base-dist");
const headDist = option("--head-dist") ?? "dist";
const roots = args.length > 0 ? args : ["node_modules"];
if (baseDist === undefined) {
  console.error("usage: --base-dist <dir> [--head-dist <dir>] [roots...]");
  process.exit(2);
}

async function load(dist) {
  const root = pathToFileURL(path.resolve(dist) + "/").href;
  const at = (module) => import(new URL(`code-intelligence/${module}`, root));
  const loader = await at("loader-constructs.js");
  const model = await at("module-model.js");
  const index = await at("source-index.js");
  if (typeof loader.loaderCapabilityResolutionCount !== "function") {
    throw new Error(`${dist} has no loaderCapabilityResolutionCount`);
  }
  return {
    find: loader.findClosureWideningConstructs,
    count: loader.loaderCapabilityResolutionCount,
    buildModuleModel: model.buildModuleModel,
    indexSourceFile: index.indexSourceFile,
  };
}

const base = await load(baseDist);
const head = await load(headDist);

const EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);
const MAX_FILE_BYTES = 2_000_000;

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      yield full;
    }
  }
}

function steps(analyzer, file, text) {
  const index = analyzer.indexSourceFile(file, text);
  const model = analyzer.buildModuleModel(index);
  const before = analyzer.count();
  const started = process.hrtime.bigint();
  analyzer.find({ index, model });
  const ns = process.hrtime.bigint() - started;
  return { steps: analyzer.count() - before, ms: Number(ns) / 1e6 };
}

function nodesOf(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
  let n = 0;
  const visit = (node) => {
    n += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return n;
}

const rows = [];
let skipped = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    let text;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      text = fs.readFileSync(file, "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    let b;
    let h;
    try {
      b = steps(base, file, text);
      h = steps(head, file, text);
    } catch {
      skipped += 1;
      continue;
    }
    rows.push({ file, nodes: nodesOf(text, file), base: b, head: h });
  }
}

const sum = (pick) => rows.reduce((total, row) => total + pick(row), 0);
const baseSteps = sum((r) => r.base.steps);
const headSteps = sum((r) => r.head.steps);
const baseMs = sum((r) => r.base.ms);
const headMs = sum((r) => r.head.ms);
console.log(`roots: ${roots.join(", ")}`);
console.log(`files: ${rows.length} (skipped: ${skipped})`);
console.log(
  `resolution steps: base ${baseSteps}, head ${headSteps} (x${(headSteps / baseSteps).toFixed(3)})`,
);
console.log(
  `classifier time (informative, load-dependent): base ${baseMs.toFixed(0)} ms, head ${headMs.toFixed(0)} ms`,
);
const perNode = rows
  .map((r) => ({ ...r, perNode: r.head.steps / Math.max(1, r.nodes) }))
  .sort((a, b) => b.perNode - a.perNode);
console.log("largest head steps per AST node:");
for (const r of perNode.slice(0, 5)) {
  console.log(
    `  ${r.perNode.toFixed(2)} steps/node (${r.head.steps} steps, ${r.nodes} nodes; base ${r.base.steps}): ${r.file}`,
  );
}
const ratio = rows
  .filter((r) => r.base.steps >= 100)
  .map((r) => ({ ...r, ratio: r.head.steps / r.base.steps }))
  .sort((a, b) => b.ratio - a.ratio);
console.log("largest head/base step ratio (files with at least 100 base steps):");
for (const r of ratio.slice(0, 5)) {
  console.log(
    `  x${r.ratio.toFixed(2)} (base ${r.base.steps}, head ${r.head.steps}, ${r.nodes} nodes): ${r.file}`,
  );
}
