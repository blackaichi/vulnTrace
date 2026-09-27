// Round 2: provenance (P0-C), root/entrypoint (P0-D), invocation (P0-E)
// and write/observability (P0-F) probes, plus the reassignment-poisoning
// breadth test that round 1's A21 result implies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures2");
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// [id, construct, endsEval, extraHelpers, entryOverride, libOverride]
const variants = [
  // ---- P0-C: does one destructuring-target key POISON the whole file? ----
  [
    "C01-destructure-key-alone",
    `let q;\n  ({ [bail()]: q } = HOLDER);\n  void q;`,
    true,
  ],
  [
    "C02-poison-defeats-rwf024",
    `const o = { [bail()]: 1 };\n  void o;\n  let q;\n  ({ [bail()]: q } = HOLDER);\n  void q;`,
    true,
  ],
  [
    "C03-poison-defeats-rwf016",
    `bail();\n  let q;\n  ({ [bail()]: q } = HOLDER);\n  void q;`,
    true,
  ],
  [
    "C04-poison-defeats-rwf017",
    `const v = bail();\n  void v;\n  let q;\n  ({ [bail()]: q } = HOLDER);\n  void q;`,
    true,
  ],
  [
    "C05-poison-via-array-destructure",
    `bail();\n  let q;\n  [HOLDER[bail()]] = [1];\n  void q;`,
    true,
  ],
  [
    "C06-poison-control-no-destructure",
    `bail();\n  let q;\n  void q;`,
    true,
  ],
  // ---- P0-C: documented lexical/provenance boundaries ----
  ["C07-alias-call", `const alias = bail;\n  alias();`, true],
  ["C08-transitive-call", `viaHelper();`, true, `function viaHelper() {\n  bail();\n}`],
  [
    "C09-member-call",
    `const holder = { bail: bail };\n  holder.bail();`,
    true,
  ],
  [
    "C10-own-block-throwing-shadow",
    `{\n    const bail = () => { throw new Error("shadow"); };\n    bail();\n  }`,
    true,
  ],
  // ---- P0-E: invocation semantics ----
  ["E01-new-expression", `new bail();`, true],
  [
    "E02-throwing-iife",
    `(() => { throw new Error("iife"); })();`,
    true,
  ],
  [
    "E03-iife-calling-bail",
    `(() => { bail(); })();`,
    true,
  ],
];

const LIB_PKG = `{ "name": "fixture-lib", "version": "1.0.0", "main": "index.js" }\n`;
const DANGER = `"use strict";
function explode(input) {
  return "danger:" + input;
}
exports.explode = explode;
`;
const ENTRY = `const fixture = require("fixture-lib");
module.exports = function main(input) {
  return fixture(input);
};
`;

function libIndex(construct, extra) {
  return `"use strict";
const danger = require("./danger");

function dangerousOp(input) {
  return danger.explode(input);
}

function safeOp(input) {
  return "safe:" + input;
}

function bail() {
  throw new Error("bail");
}

const HOLDER = { k: 1 };
const FLAG = process.env.FIXTURE_LIB_MODE === "fast";
${extra ? "\n" + extra + "\n" : ""}
if (process.env.FIXTURE_LIB_MODE === "fast") {
  module.exports = dangerousOp;
  ${construct}
}

module.exports = safeOp;
`;
}

const manifest = [];
for (const [id, construct, endsEval, extra] of variants) {
  const dir = path.join(ROOT, id);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const lib = path.join(dir, "node_modules", "fixture-lib");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: `p0probe2-${id.toLowerCase()}`,
        version: "1.0.0",
        private: true,
        dependencies: { "fixture-lib": "1.0.0" },
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(path.join(dir, "src", "index.cjs"), ENTRY);
  fs.writeFileSync(path.join(lib, "package.json"), LIB_PKG);
  fs.writeFileSync(path.join(lib, "danger.js"), DANGER);
  fs.writeFileSync(path.join(lib, "index.js"), libIndex(construct, extra));
  manifest.push({ id, endsEval, dir });
}
fs.writeFileSync(
  path.join(ROOT, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log("generated", manifest.length, "round-2 probe fixtures");
