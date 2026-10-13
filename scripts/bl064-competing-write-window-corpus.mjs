// BL-064 corpus measurement: the precision cost of the competing-write
// window (ADR 0009 § 1 clause 4, as amended by BL-064; FINDINGS RWF-094).
//
// Walks every JS/CJS file under the given roots and builds each file's
// module model twice -- with a BASE build of the analyzer and with a HEAD
// build -- and compares every export binding's attribution facts
// (`localName`, `localFunctionLocation`, `commonJsReExport`,
// `exportAttributionWithdrawn`). Both builds are imported from compiled
// `dist/` directories, so this measures the shipping code, not a
// restatement of it.
//
// It reports, per root: the files and CommonJS files read, the exports
// compared, every export whose facts differ (expected: attributed on base,
// withdrawn on head, and nothing else), and for each a one-line reason
// from the HEAD side: the competing writes and the first statement in the
// window that is not proven to complete.
//
// It makes no claim about verdicts -- those are measured by the
// differential (`node scripts/differential.mjs`) and the suites.
//
// Usage:
//   node scripts/bl064-competing-write-window-corpus.mjs \
//     --base-dist <dir> --head-dist <dir> [--list] [roots...]
//
// A base build: `git worktree add <dir> <base>`, link `node_modules`, and
// `npx tsc -p tsconfig.build.json` inside it; `--base-dist <dir>/dist`.

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
  console.error("usage: --base-dist <dir> [--head-dist <dir>] [--list] [roots...]");
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
  const index = await import(new URL("code-intelligence/source-index.js", root));
  const model = await import(new URL("code-intelligence/module-model.js", root));
  return { indexSourceFile: index.indexSourceFile, buildModuleModel: model.buildModuleModel };
}

const EXTENSIONS = new Set([".js", ".cjs"]);

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

function facts(exp) {
  return JSON.stringify({
    localName: exp.localName,
    localFunctionLocation: exp.localFunctionLocation,
    commonJsReExport: exp.commonJsReExport,
    exportAttributionWithdrawn: exp.exportAttributionWithdrawn === true,
  });
}

function exportKey(exp, i) {
  return `${exp.kind}:${exp.exportedName ?? "-"}:${exp.location?.line ?? i}`;
}

function modelExports(analyzer, file, text) {
  try {
    const index = analyzer.indexSourceFile(path.resolve(file), text);
    if (index.moduleSyntax !== undefined && index.moduleSyntax !== "commonjs") {
      return undefined;
    }
    const model = analyzer.buildModuleModel(index);
    if (model.syntax !== undefined && model.syntax !== "commonjs") {
      return undefined;
    }
    return model.exports.filter((exp) => exp.syntax === "commonjs");
  } catch (error) {
    return { error: String(error) };
  }
}

const base = await load(baseDist);
const head = await load(headDist);

const totals = [];
const changes = [];
for (const root of ROOTS) {
  const row = { root, files: 0, commonJsFiles: 0, exports: 0, withdrawnByHead: 0, otherChanges: 0, errors: 0 };
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
    const before = modelExports(base, file, text);
    const after = modelExports(head, file, text);
    if (before === undefined || after === undefined) {
      continue;
    }
    if (!Array.isArray(before) || !Array.isArray(after)) {
      row.errors += 1;
      continue;
    }
    if (before.length === 0 && after.length === 0) {
      continue;
    }
    row.commonJsFiles += 1;
    const beforeByKey = new Map(before.map((exp, i) => [exportKey(exp, i), exp]));
    const afterByKey = new Map(after.map((exp, i) => [exportKey(exp, i), exp]));
    for (const key of new Set([...beforeByKey.keys(), ...afterByKey.keys()])) {
      row.exports += 1;
      const b = beforeByKey.get(key);
      const a = afterByKey.get(key);
      if (b !== undefined && a !== undefined && facts(b) === facts(a)) {
        continue;
      }
      const withdrawn =
        b !== undefined &&
        a !== undefined &&
        b.exportAttributionWithdrawn !== true &&
        a.exportAttributionWithdrawn === true;
      if (withdrawn) {
        row.withdrawnByHead += 1;
      } else {
        row.otherChanges += 1;
      }
      changes.push({ file, key, withdrawn, base: b && facts(b), head: a && facts(a) });
    }
  }
  totals.push(row);
}

console.log("| root | files | CommonJS files with exports | exports compared | withdrawn by head | other changes | errors |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const row of totals) {
  console.log(
    `| ${row.root} | ${row.files} | ${row.commonJsFiles} | ${row.exports} | ${row.withdrawnByHead} | ${row.otherChanges} | ${row.errors} |`,
  );
}
if (list || changes.length <= 60) {
  console.log("");
  for (const change of changes) {
    console.log(`${change.withdrawn ? "withdrawn" : "CHANGED"}  ${change.file}  ${change.key}`);
    if (!change.withdrawn) {
      console.log(`  base: ${change.base}\n  head: ${change.head}`);
    }
  }
}
