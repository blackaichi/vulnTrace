// BL-081 corpus measurement: what making every store onto an object not
// proven to be the program's own an escape costs in CALL-GRAPH precision
// (docs/tasks/BL-081-builtin-replaced-without-name.md; ADR 0008's BL-081
// decision record).
//
// For every package directly under `node_modules` (scoped ones included),
// builds the call graph with EVERY JavaScript file of the package as an
// entry -- twice, with the base build's analyzer and with this working
// tree's -- and counts, among the graph nodes in the package's own files,
// the CLEAN ones: nodes from which no unknown edge is reachable through
// resolved and possible edges. A family-C `NOT_AFFECTED` needs its search
// region to be clean, so a node clean on base and not on head is
// precision the change gives up (an upper bound per package: a real
// project's entrypoints reach only part of it). It reports, per package
// and in all, the clean nodes on base, how many head loses and gains, and
// the unknown and possible edges. No time limit is set: a cap makes the
// walk depend on the machine's load (task BL-081 measured that first,
// and read a load-dependent truncation of `typescript` as a gain).
//
// It makes no claim about verdicts: those are the differential's
// (`node scripts/differential.mjs`).
//
// Usage:
//   node scripts/bl081-builtin-store-escape-corpus.mjs \
//     --base-dist <dir> [--head-dist <dir>] [--list] [--typescript]
//     [packages...]
//
// `--typescript` (task BL-095) takes each package's TypeScript sources
// (`.ts`, `.mts`, `.cts`, `.tsx`; not declaration files) instead of its
// JavaScript files, for a change that only TypeScript's emit reaches; a
// package with none is skipped.
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
function flag(name) {
  const at = args.indexOf(name);
  if (at >= 0) {
    args.splice(at, 1);
  }
  return at >= 0;
}
const list = flag("--list");
const typescript = flag("--typescript");
if (baseDist === undefined) {
  console.error(
    "usage: --base-dist <dir> [--head-dist <dir>] [--list] [--typescript] [packages...]",
  );
  process.exit(2);
}

async function load(dist) {
  const root = pathToFileURL(path.resolve(dist) + "/").href;
  const at = (module) => import(new URL(`code-intelligence/${module}`, root));
  const graph = await at("call-graph.js");
  const resolver = await at("module-resolver.js");
  const project = await at("ts-project.js");
  return {
    buildCallGraph: graph.buildCallGraph,
    createModuleResolver: resolver.createModuleResolver,
    loadTsProject: project.loadTsProject,
  };
}

const base = await load(baseDist);
const head = await load(headDist);

const EXTENSIONS = new Set(
  typescript ? [".ts", ".mts", ".cts", ".tsx"] : [".js", ".cjs", ".mjs"],
);
const DECLARATION_FILE = /\.d\.[cm]?ts$/;
const MAX_FILE_BYTES = 2_000_000;
const MAX_FILES = 600;

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
      if (entry.name !== "node_modules") {
        yield* walk(full);
      }
    } else if (
      entry.isFile() &&
      EXTENSIONS.has(path.extname(entry.name)) &&
      !DECLARATION_FILE.test(entry.name)
    ) {
      yield full;
    }
  }
}

function packages(root) {
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }
    const dir = path.join(root, entry.name);
    if (entry.name.startsWith("@")) {
      for (const scoped of fs.readdirSync(dir, { withFileTypes: true })) {
        if (scoped.isDirectory()) {
          found.push(path.join(dir, scoped.name));
        }
      }
    } else {
      found.push(dir);
    }
  }
  return found.sort();
}

async function measure(analyzer, pkg, files) {
  const project = analyzer.loadTsProject(".");
  const graph = await analyzer.buildCallGraph({
    entryFiles: files,
    resolver: analyzer.createModuleResolver(project),
    project,
  });
  const prefix = path.resolve(pkg) + path.sep;
  const predecessors = new Map();
  const dirty = new Set();
  let unknown = 0;
  let possible = 0;
  for (const edge of graph.edges) {
    if (edge.resolution.kind === "unknown") {
      dirty.add(edge.from);
      unknown += 1;
      continue;
    }
    if (edge.resolution.kind === "possible") {
      possible += 1;
    }
    const target = edge.resolution.target;
    if (!predecessors.has(target)) {
      predecessors.set(target, []);
    }
    predecessors.get(target).push(edge.from);
  }
  const stack = [...dirty];
  while (stack.length > 0) {
    for (const from of predecessors.get(stack.pop()) ?? []) {
      if (!dirty.has(from)) {
        dirty.add(from);
        stack.push(from);
      }
    }
  }
  const own = graph.nodes.filter((node) => node.module.startsWith(prefix));
  return {
    nodes: own.length,
    clean: new Set(own.filter((n) => !dirty.has(n.id)).map((n) => n.id)),
    unknown,
    possible,
  };
}

const started = Date.now();
const rows = [];
const skipped = [];
for (const pkg of args.length > 0 ? args : packages("node_modules")) {
  const files = [...walk(pkg)]
    .map((file) => path.resolve(file))
    .filter((file) => fs.statSync(file).size < MAX_FILE_BYTES);
  if (files.length === 0 || files.length > MAX_FILES) {
    skipped.push(`${pkg} (${files.length} files)`);
    continue;
  }
  try {
    const before = await measure(base, pkg, files);
    const after = await measure(head, pkg, files);
    const lost = [...before.clean].filter((id) => !after.clean.has(id));
    const gained = [...after.clean].filter((id) => !before.clean.has(id));
    rows.push({ pkg, before, after, lost, gained });
  } catch (error) {
    skipped.push(`${pkg} (error: ${String(error).slice(0, 120)})`);
  }
}

const total = (pick) => rows.reduce((sum, row) => sum + pick(row), 0);
console.log(
  "| package | nodes | clean on base | lost | gained | unknown edges base → head | possible edges base → head |",
);
console.log("| --- | ---: | ---: | ---: | ---: | --- | --- |");
for (const row of rows.filter((r) => r.lost.length > 0 || r.gained.length > 0)) {
  console.log(
    `| ${row.pkg} | ${row.before.nodes} | ${row.before.clean.size} | ${row.lost.length} | ${row.gained.length} | ${row.before.unknown} → ${row.after.unknown} | ${row.before.possible} → ${row.after.possible} |`,
  );
}
console.log(
  `| **all ${rows.length} packages** | ${total((r) => r.before.nodes)} | ${total((r) => r.before.clean.size)} | ${total((r) => r.lost.length)} | ${total((r) => r.gained.length)} | ${total((r) => r.before.unknown)} → ${total((r) => r.after.unknown)} | ${total((r) => r.before.possible)} → ${total((r) => r.after.possible)} |`,
);
console.log("");
console.log(`skipped: ${skipped.length === 0 ? "none" : skipped.join(", ")}`);
console.log(`${Math.round((Date.now() - started) / 1000)} s in all`);
if (list) {
  console.log("");
  for (const row of rows) {
    for (const id of row.lost) {
      console.log(`lost  ${id}`);
    }
    for (const id of row.gained) {
      console.log(`gained  ${id}`);
    }
  }
}
