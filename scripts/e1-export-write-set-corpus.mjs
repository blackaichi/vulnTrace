// E-1 corpus measurement: what the export write set changes in export
// ATTRIBUTION (ADR 0009 § 1; docs/tasks/E-1-export-write-set.md).
//
// Walks every JS file under the given roots and builds each file's export
// map (`mapExportsToFunctions`: canonical export name -> the indexed
// function it denotes) twice -- with a BASE build of the analyzer and with
// a HEAD build -- and compares them name by name. Both builds are imported
// from compiled `dist/` directories, so this measures the shipping code.
//
// It reports, per root: the files read, the files with any export
// attributed on either side, the attributed exports compared, and three
// kinds of change:
//
// - lost: attributed on base, not on head (a withdrawal: precision cost,
//   or a stale attribution the base got wrong);
// - gained: attributed on head, not on base;
// - moved: attributed on both, to different functions (the name `find`
//   landing on a same-named decoy, for example).
//
// Each lost export is labelled with the head's reason as far as the model
// shows it: `file` when every CommonJS binding of the file is withdrawn
// (the census met a reference it does not enumerate), `name` when only
// this name's binding is withdrawn, `none` when the head publishes no
// binding of the name at all (a stale write), and `lexical` when the head
// keeps an attributed binding but resolves no function (lexical identity
// refused the local).
//
// It makes no claim about verdicts -- those are measured by the
// differential (`node scripts/differential.mjs`) and the suites.
//
// Usage:
//   node scripts/e1-export-write-set-corpus.mjs \
//     --base-dist <dir> [--head-dist <dir>] [--list] [roots...]
//
// A base build: `git worktree add <dir> <base>`, link `node_modules`, and
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
  const index = await import(
    new URL("code-intelligence/source-index.js", root)
  );
  const model = await import(new URL("code-intelligence/module-model.js", root));
  return {
    indexSourceFile: index.indexSourceFile,
    buildModuleModel: model.buildModuleModel,
    mapExportsToFunctions: model.mapExportsToFunctions,
  };
}

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

function analyze(analyzer, file, text) {
  try {
    const index = analyzer.indexSourceFile(path.resolve(file), text);
    const model = analyzer.buildModuleModel(index);
    const map = analyzer.mapExportsToFunctions(index, model);
    return { model, map };
  } catch (error) {
    return { error: String(error) };
  }
}

function reasonFor(model, name) {
  const commonJs = model.exports.filter((exp) => exp.syntax === "commonjs");
  if (
    commonJs.length > 0 &&
    commonJs.every((exp) => exp.exportAttributionWithdrawn === true)
  ) {
    return "file";
  }
  const own = model.exports.filter(
    (exp) => (exp.kind === "default" ? "default" : exp.exportedName) === name,
  );
  if (own.length === 0) {
    return "none";
  }
  return own.some((exp) => exp.exportAttributionWithdrawn === true)
    ? "name"
    : "lexical";
}

const base = await load(baseDist);
const head = await load(headDist);

const totals = [];
const changes = [];
for (const root of ROOTS) {
  const row = {
    root,
    files: 0,
    filesWithAttribution: 0,
    attributed: 0,
    lost: { file: 0, name: 0, none: 0, lexical: 0 },
    gained: 0,
    moved: 0,
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
    const before = analyze(base, file, text);
    const after = analyze(head, file, text);
    if (before.error !== undefined || after.error !== undefined) {
      row.errors += 1;
      continue;
    }
    if (before.map.size === 0 && after.map.size === 0) {
      continue;
    }
    row.filesWithAttribution += 1;
    for (const name of new Set([...before.map.keys(), ...after.map.keys()])) {
      row.attributed += 1;
      const b = before.map.get(name);
      const a = after.map.get(name);
      if (b !== undefined && a !== undefined) {
        if (position(b) !== position(a)) {
          row.moved += 1;
          changes.push({ kind: "moved", file, name, detail: `${position(b)} -> ${position(a)}` });
        }
      } else if (b !== undefined) {
        const reason = reasonFor(after.model, name);
        row.lost[reason] += 1;
        changes.push({ kind: `lost:${reason}`, file, name, detail: position(b) });
      } else {
        row.gained += 1;
        changes.push({ kind: "gained", file, name, detail: position(a) });
      }
    }
  }
  totals.push(row);
}

console.log(
  "| root | files | files with an attribution | exports compared | lost (file / name / none / lexical) | gained | moved | errors |",
);
console.log("| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |");
for (const row of totals) {
  const lost = row.lost;
  const lostTotal = lost.file + lost.name + lost.none + lost.lexical;
  console.log(
    `| ${row.root} | ${row.files} | ${row.filesWithAttribution} | ${row.attributed} | ${lostTotal} (${lost.file} / ${lost.name} / ${lost.none} / ${lost.lexical}) | ${row.gained} | ${row.moved} | ${row.errors} |`,
  );
}
if (list || changes.length <= 80) {
  console.log("");
  for (const change of changes) {
    console.log(`${change.kind}  ${change.file}  ${change.name}  ${change.detail}`);
  }
}
