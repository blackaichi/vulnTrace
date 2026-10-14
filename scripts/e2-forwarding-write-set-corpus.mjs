// E-2 corpus measurement: what consulting the export write set changes in
// the FORWARDING HOP (ADR 0009 § 1; docs/tasks/E-2-forwarding-write-set.md).
//
// Walks every JS file under the given roots and asks each file's model
// `exportForwardingHops(model, name)` twice -- with a BASE build of the
// analyzer and with a HEAD build -- for every name either model exports,
// every name the head's write set records on a whole-module re-export
// (`forwardingShadowedNames`), and `default`. Both builds are imported
// from compiled `dist/` directories, so this measures the shipping code.
//
// It reports, per root: the files read, the files with any hop on either
// side, the (file, name) hops compared, and three kinds of change:
//
// - lost: a hop on base, none on head (a refusal: precision cost, or a
//   forward the base got wrong);
// - gained: a hop on head, none on base;
// - moved: a hop on both, to a different specifier or name.
//
// Each lost hop is labelled with the head's reason: `shadowed` when the
// head's whole-module re-export records the name (RWF-105's refusal),
// `own` when the head has own bindings of the name that do not agree on
// one origin, `other` otherwise.
//
// It makes no claim about verdicts -- those are measured by the
// differential (`node scripts/differential.mjs`) and the suites.
//
// Usage:
//   node scripts/e2-forwarding-write-set-corpus.mjs \
//     --base-dist <dir> [--head-dist <dir>] [--list] [roots...]
//
// A base build: extract the base commit (`git archive <base> | tar -x -C
// <dir>`), link `node_modules`, and `npx tsc -p <dir>/tsconfig.build.json`;
// `--base-dist <dir>/dist`.

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
  const forwarding = await import(
    new URL("code-intelligence/export-forwarding.js", root)
  );
  return {
    indexSourceFile: index.indexSourceFile,
    buildModuleModel: model.buildModuleModel,
    exportForwardingHops: forwarding.exportForwardingHops,
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

function modelOf(analyzer, file, text) {
  try {
    return analyzer.buildModuleModel(
      analyzer.indexSourceFile(path.resolve(file), text),
    );
  } catch (error) {
    return { error: String(error) };
  }
}

function hopsOf(analyzer, model, name) {
  return analyzer
    .exportForwardingHops(model, name)
    .map((hop) => `${hop.syntax}:${hop.specifier}#${hop.exportName}`)
    .join(" | ");
}

function shadowedOf(model) {
  const names = new Set();
  for (const exp of model.exports) {
    for (const name of exp.forwardingShadowedNames ?? []) {
      names.add(name);
    }
  }
  return names;
}

function reasonFor(model, name) {
  if (shadowedOf(model).has(name)) {
    return "shadowed";
  }
  const own = model.exports.filter(
    (exp) =>
      exp.syntax === "commonjs" &&
      exp.kind === "named" &&
      exp.exportedName === name,
  );
  return own.length > 0 ? "own" : "other";
}

const base = await load(baseDist);
const head = await load(headDist);

const totals = [];
const changes = [];
for (const root of ROOTS) {
  const row = {
    root,
    files: 0,
    filesWithHop: 0,
    compared: 0,
    lost: { shadowed: 0, own: 0, other: 0 },
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
    const before = modelOf(base, file, text);
    const after = modelOf(head, file, text);
    if (before.error !== undefined || after.error !== undefined) {
      row.errors += 1;
      continue;
    }
    const names = new Set(["default", ...shadowedOf(after)]);
    for (const model of [before, after]) {
      for (const exp of model.exports) {
        if (exp.exportedName !== undefined) {
          names.add(exp.exportedName);
        }
      }
    }
    let any = false;
    for (const name of names) {
      const b = hopsOf(base, before, name);
      const a = hopsOf(head, after, name);
      if (b === "" && a === "") {
        continue;
      }
      any = true;
      row.compared += 1;
      if (b !== "" && a !== "") {
        if (a !== b) {
          row.moved += 1;
          changes.push({ kind: "moved", file, name, detail: `${b} -> ${a}` });
        }
      } else if (b !== "") {
        const reason = reasonFor(after, name);
        row.lost[reason] += 1;
        changes.push({ kind: `lost:${reason}`, file, name, detail: b });
      } else {
        row.gained += 1;
        changes.push({ kind: "gained", file, name, detail: a });
      }
    }
    if (any) {
      row.filesWithHop += 1;
    }
  }
  totals.push(row);
}

console.log(
  "| root | files | files with a hop | hops compared | lost (shadowed / own / other) | gained | moved | errors |",
);
console.log("| --- | ---: | ---: | ---: | --- | ---: | ---: | ---: |");
for (const row of totals) {
  const lost = row.lost;
  const lostTotal = lost.shadowed + lost.own + lost.other;
  console.log(
    `| ${row.root} | ${row.files} | ${row.filesWithHop} | ${row.compared} | ${lostTotal} (${lost.shadowed} / ${lost.own} / ${lost.other}) | ${row.gained} | ${row.moved} | ${row.errors} |`,
  );
}
if (list || changes.length <= 80) {
  console.log("");
  for (const change of changes) {
    console.log(`${change.kind}  ${change.file}  ${change.name}  ${change.detail}`);
  }
}
