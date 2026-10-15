// BL-075 corpus measurement: what refusing to trust a builtin "reader"
// with an export object costs in export ATTRIBUTION (option (a);
// docs/tasks/BL-075-builtin-reader-trust.md; ADR 0009's BL-075 decision
// record).
//
// Walks every JS file under the given roots and builds each file's export
// map (`mapExportsToFunctions`) twice, each with its own build's
// module-graph context (a `LoadReachGraph` over the repository's
// resolver, as a scan does):
//
// - base: the BASE build's analyzer (BL-074's merge);
// - head: this working tree's build (option (a)).
//
// and reports, per root, the exports attributed on base and how many head
// loses, gains and moves. Option (b) -- deciding builtin patching over the
// modules that may run -- could at most keep what (a) loses, so the "lost"
// column is also the ceiling of what (b) could save. It makes no claim
// about verdicts: those are the differential's (`node
// scripts/differential.mjs`).
//
// Usage:
//   node scripts/bl075-builtin-reader-trust-corpus.mjs \
//     --base-dist <dir> [--head-dist <dir>] [--list] [roots...]
//
// A base build: `git archive <base> src schemas package.json tsconfig.json
// tsconfig.build.json | tar -x -C <dir>`, link `node_modules`, and
// `npx tsc -p <dir>/tsconfig.build.json`; `--base-dist <dir>/dist`.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

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
const listAt = args.indexOf("--list");
const list = listAt >= 0;
if (list) {
  args.splice(listAt, 1);
}
if (baseDist === undefined) {
  console.error(
    "usage: --base-dist <dir> [--head-dist <dir>] [--list] [roots...]",
  );
  process.exit(2);
}
const ROOTS =
  args.length > 0
    ? args
    : [
        "node_modules",
        "fixtures",
        "tests/adversarial/v1/fixtures",
        "tests/adversarial/v2/fixtures",
        "tests/validation/fixtures",
      ];

async function load(dist) {
  const root = pathToFileURL(path.resolve(dist) + "/").href;
  const at = (module) => import(new URL(`code-intelligence/${module}`, root));
  const index = await at("source-index.js");
  const model = await at("module-model.js");
  const reach = await at("load-reach.js");
  const resolver = await at("module-resolver.js");
  const project = await at("ts-project.js");
  return {
    indexSourceFile: index.indexSourceFile,
    buildModuleModel: model.buildModuleModel,
    mapExportsToFunctions: model.mapExportsToFunctions,
    reachGraph: new reach.LoadReachGraph(
      resolver.createModuleResolver(project.loadTsProject(".")),
    ),
  };
}

const base = await load(baseDist);
const head = await load(headDist);

const EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

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

function position(fn) {
  return `${fn.location.line}:${fn.location.column}`;
}

async function map(analyzer, file, text) {
  const index = analyzer.indexSourceFile(file, text);
  const reach = await analyzer.reachGraph.prepare(index);
  return analyzer.mapExportsToFunctions(
    index,
    analyzer.buildModuleModel(index, reach),
  );
}

const started = Date.now();
const totals = [];
const changes = [];
for (const root of ROOTS) {
  const row = { root, files: 0, attributed: 0, lost: 0, gained: 0, moved: 0, lostFiles: 0, errors: 0 };
  for (const file of walk(root)) {
    row.files += 1;
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (text.length > 2_000_000) {
      continue;
    }
    try {
      const full = path.resolve(file);
      const before = await map(base, full, text);
      const after = await map(head, full, text);
      row.attributed += before.size;
      let lostHere = false;
      for (const name of new Set([...before.keys(), ...after.keys()])) {
        const b = before.get(name);
        const a = after.get(name);
        if (b !== undefined && a !== undefined) {
          if (position(b) !== position(a)) {
            row.moved += 1;
            changes.push(`moved  ${file}  ${name}`);
          }
        } else if (b !== undefined) {
          row.lost += 1;
          lostHere = true;
          changes.push(`lost  ${file}  ${name}`);
        } else {
          row.gained += 1;
          changes.push(`gained  ${file}  ${name}`);
        }
      }
      if (lostHere) row.lostFiles += 1;
    } catch (error) {
      row.errors += 1;
      if (list) changes.push(`error  ${file}  ${String(error)}`);
    }
  }
  totals.push(row);
}

console.log(
  "| root | files | exports attributed on base | lost (files) | gained | moved | errors |",
);
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const row of totals) {
  console.log(
    `| ${row.root} | ${row.files} | ${row.attributed} | ${row.lost} (${row.lostFiles}) | ${row.gained} | ${row.moved} | ${row.errors} |`,
  );
}
console.log("");
console.log(`${Math.round((Date.now() - started) / 1000)} s in all`);
if (list || changes.length <= 80) {
  console.log("");
  for (const change of changes) {
    console.log(change);
  }
}
