// BL-094, option O3 ("read the build"): does a project's tsconfig decide
// the emit Node runs?
//
// One TypeScript source -- RWF-126/RWF-127's shape, a static field on a
// class derived from `util.inspect` -- is turned into what Node runs by
// each tool the repository has, under the SAME tsconfig, and run with
// real Node. Under an ASSIGN emit the field's store runs `util.inspect`'s
// inherited `defaultOptions` setter, installing the comparator, which the
// later `util.inspect` call then runs; under a DEFINE emit it is an own
// property of the class and nothing runs.
//
// The source is this file's own probe program, not target code.
//
// Usage: node scripts/bl094-escape-options/o3-emit-probe.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const esbuild = require("esbuild");

const SOURCE = `const util = require("util");
class D extends (util.inspect as any) {
  static defaultOptions = {
    sorted: (a: string, b: string) => {
      console.log("COMPARATOR RAN");
      return a < b ? -1 : 1;
    },
  };
}
void D;
util.inspect({ b: 1, a: 2 });
`;

const TSCONFIGS = {
  "target ES2020": { target: "ES2020", module: "commonjs" },
  "target ES2022": { target: "ES2022", module: "commonjs" },
  "target ES2022, useDefineForClassFields false": {
    target: "ES2022",
    module: "commonjs",
    useDefineForClassFields: false,
  },
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bl094-o3-"));

function run(file, extraArgs = []) {
  const result = spawnSync(process.execPath, [...extraArgs, file], {
    cwd: dir,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return `throws (${(result.stderr.split("\n").find((l) => /Error/.test(l)) ?? "exit " + result.status).trim()})`;
  }
  return result.stdout.includes("COMPARATOR RAN")
    ? "setter runs (assign)"
    : "nothing runs (define)";
}

const rows = [];
for (const [label, options] of Object.entries(TSCONFIGS)) {
  fs.writeFileSync(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: options }),
  );

  // 1. tsc (the compiler API's emit for this tsconfig).
  const parsed = ts.convertCompilerOptionsFromJson(options, dir).options;
  const tscOut = ts.transpileModule(SOURCE, { compilerOptions: parsed });
  fs.writeFileSync(path.join(dir, "tsc.cjs"), tscOut.outputText);

  // 2. esbuild (what tsx and vite-node run), given the same tsconfig.
  const esbuildOut = esbuild.transformSync(SOURCE, {
    loader: "ts",
    format: "cjs",
    tsconfigRaw: { compilerOptions: options },
  });
  fs.writeFileSync(path.join(dir, "esbuild.cjs"), esbuildOut.code);

  // 3. Node's own type stripping, which reads no tsconfig at all.
  fs.writeFileSync(path.join(dir, "strip.cts"), SOURCE);

  rows.push([
    label,
    run("tsc.cjs"),
    run("esbuild.cjs"),
    run("strip.cts", ["--experimental-strip-types", "--no-warnings"]),
  ]);
}

console.log(`Node ${process.version}, TypeScript ${ts.version}, esbuild ${esbuild.version}`);
console.log("| tsconfig | tsc | esbuild | node --experimental-strip-types |");
console.log("| --- | --- | --- | --- |");
for (const row of rows) {
  console.log(`| ${row.join(" | ")} |`);
}
fs.rmSync(dir, { recursive: true, force: true });
