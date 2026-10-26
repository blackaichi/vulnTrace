// BL-111 corpus census (docs/tasks/BL-111-loader-writes-builtins.md): how
// often a candidate closure-wide rule fires on real code. With a build of
// one prototype tier (`git apply scripts/bl111-loader-writes-options/<tier>.patch`,
// `npm run build`), reads `fileMayRedirectLoader` for every `.js` / `.cjs` /
// `.mjs` file under each root and reports the files and packages for which
// it is true. One such file in a closure makes that closure incomplete.
//
// Usage:
//   node scripts/bl111-loader-writes-options/census.mjs [--dist <dir>] [roots...]

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
const dist = option("--dist") ?? "dist";
const roots = args.length > 0 ? args : ["node_modules"];
const root = pathToFileURL(path.resolve(dist) + "/").href;
const at = (module) => import(new URL(`code-intelligence/${module}`, root));
const loader = await at("loader-constructs.js");
const { buildModuleModel } = await at("module-model.js");
const { indexSourceFile } = await at("source-index.js");
if (typeof loader.fileMayRedirectLoader !== "function") {
  console.error(`${dist} is not a BL-111 prototype build`);
  process.exit(2);
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
function packageOf(file) {
  const parts = file.split(path.sep);
  const i = parts.lastIndexOf("node_modules");
  if (i < 0 || i + 1 >= parts.length) {
    return "(none)";
  }
  const name = parts[i + 1].startsWith("@") ? parts.slice(i + 1, i + 3).join("/") : parts[i + 1];
  return parts.slice(0, i + 1).join(path.sep) + path.sep + name;
}

let files = 0;
let flagged = 0;
let skipped = 0;
const packages = new Map();
for (const r of roots) {
  for (const file of walk(r)) {
    let text;
    try {
      if (fs.statSync(file).size > 2_000_000) {
        skipped += 1;
        continue;
      }
      text = fs.readFileSync(file, "utf8");
    } catch {
      skipped += 1;
      continue;
    }
    let hit;
    try {
      const index = indexSourceFile(file, text);
      hit = loader.fileMayRedirectLoader({ index, model: buildModuleModel(index) });
    } catch {
      skipped += 1;
      continue;
    }
    files += 1;
    const pkg = packageOf(file);
    const entry = packages.get(pkg) ?? { files: 0, flagged: 0 };
    entry.files += 1;
    if (hit) {
      flagged += 1;
      entry.flagged += 1;
    }
    packages.set(pkg, entry);
  }
}
const pk = [...packages.values()];
console.log(`roots: ${roots.join(", ")}`);
console.log(`files: ${files} (skipped ${skipped}); flagged ${flagged} (${((100 * flagged) / files).toFixed(1)} %)`);
console.log(
  `packages: ${pk.length}; with a flagged file ${pk.filter((p) => p.flagged > 0).length} (${((100 * pk.filter((p) => p.flagged > 0).length) / pk.length).toFixed(1)} %)`,
);
