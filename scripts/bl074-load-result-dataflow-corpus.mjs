// BL-074 corpus measurement: what censusing a load's result through any
// dataflow costs in export ATTRIBUTION, under the module-graph-aware rule
// the task implements (option (b)) and under the per-file rule it did not
// take (option (a)) -- the comparison the project owner's decision rests on
// (docs/tasks/BL-074-load-result-dataflow.md; ADR 0009 § 4).
//
// Walks every JS file under the given roots and builds each file's export
// map (`mapExportsToFunctions`) three times:
//
// - base: the BASE build's analyzer (E-2's merge);
// - (b):  the HEAD build, with the file's module-graph context from a
//         `LoadReachGraph` over the repository's resolver -- what a scan
//         does;
// - (a):  the HEAD build with no context -- the per-file rule.
//
// and reports, per root, the exports attributed on base and how many each
// rule loses (attributed on base, not on the rule's side), gains and moves.
// It also reports the reach graph's work (files scanned, closure members
// visited). It makes no claim about verdicts: those are the differential's
// (`node scripts/differential.mjs`).
//
// Usage:
//   node scripts/bl074-load-result-dataflow-corpus.mjs \
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
  return {
    indexSourceFile: index.indexSourceFile,
    buildModuleModel: model.buildModuleModel,
    mapExportsToFunctions: model.mapExportsToFunctions,
  };
}

const base = await load(baseDist);
const head = await load(headDist);
const headRoot = pathToFileURL(path.resolve(headDist) + "/").href;
const reachModule = await import(
  new URL("code-intelligence/load-reach.js", headRoot)
);
const resolverModule = await import(
  new URL("code-intelligence/module-resolver.js", headRoot)
);
const projectModule = await import(
  new URL("code-intelligence/ts-project.js", headRoot)
);
const reachGraph = new reachModule.LoadReachGraph(
  resolverModule.createModuleResolver(projectModule.loadTsProject(".")),
);

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

function map(analyzer, index, reach) {
  return analyzer.mapExportsToFunctions(
    index,
    analyzer.buildModuleModel(index, reach),
  );
}

function compare(row, key, before, after, file, changes) {
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const b = before.get(name);
    const a = after.get(name);
    if (b !== undefined && a !== undefined) {
      if (position(b) !== position(a)) {
        row[key].moved += 1;
        changes.push(`${key} moved  ${file}  ${name}`);
      }
    } else if (b !== undefined) {
      row[key].lost += 1;
      changes.push(`${key} lost  ${file}  ${name}`);
    } else {
      row[key].gained += 1;
      changes.push(`${key} gained  ${file}  ${name}`);
    }
  }
}

const scansBefore = reachModule.loadReachMemberScanCount();
const visitsBefore = reachModule.loadReachClosureVisitCount();
const started = Date.now();
const totals = [];
const changes = [];
for (const root of ROOTS) {
  const row = {
    root,
    files: 0,
    attributed: 0,
    b: { lost: 0, gained: 0, moved: 0 },
    a: { lost: 0, gained: 0, moved: 0 },
    errors: 0,
  };
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
      const baseMap = map(base, base.indexSourceFile(full, text));
      const headIndex = head.indexSourceFile(full, text);
      const reach = await reachGraph.prepare(headIndex);
      const withGraph = map(head, headIndex, reach);
      const perFile = map(head, head.indexSourceFile(full, text));
      row.attributed += baseMap.size;
      compare(row, "b", baseMap, withGraph, file, changes);
      compare(row, "a", baseMap, perFile, file, changes);
    } catch (error) {
      row.errors += 1;
      if (list) changes.push(`error  ${file}  ${String(error)}`);
    }
  }
  totals.push(row);
}

console.log(
  "| root | files | exports attributed on base | (b) lost / gained / moved | (a) lost / gained / moved | errors |",
);
console.log("| --- | ---: | ---: | --- | --- | ---: |");
for (const row of totals) {
  console.log(
    `| ${row.root} | ${row.files} | ${row.attributed} | ${row.b.lost} / ${row.b.gained} / ${row.b.moved} | ${row.a.lost} / ${row.a.gained} / ${row.a.moved} | ${row.errors} |`,
  );
}
console.log("");
console.log(
  `reach graph: ${reachModule.loadReachMemberScanCount() - scansBefore} files scanned, ` +
    `${reachModule.loadReachClosureVisitCount() - visitsBefore} closure members visited, ` +
    `${Math.round((Date.now() - started) / 1000)} s in all`,
);
if (list || changes.length <= 80) {
  console.log("");
  for (const change of changes.filter((c) => c.startsWith("b ") || list)) {
    console.log(change);
  }
}
