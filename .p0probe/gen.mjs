import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

// Each variant supplies the CONSTRUCT placed between the dangerous export
// write and the later safe export write, plus optional extra helpers.
// Runtime truth: does module evaluation END there (so the later safe
// write never runs)?  endsEval=true => a later NOT_AFFECTED proof over the
// dangerous branch is UNSOUND.
const variants = [
  // ---------- P0-A: definitely-abrupt expression evaluation ----------
  ["A01-objlit-value", `const o = { k: bail() };\n  void o;`, true],
  ["A02-objlit-computed-key", `const o = { [bail()]: 1 };\n  void o;`, true],
  ["A03-call-argument", `sink(bail());`, true],
  ["A04-sequence-comma", `(bail(), 1);`, true],
  ["A05-logical-or-left", `bail() || SAFE_VALUE;`, true],
  ["A06-logical-and-left", `bail() && SAFE_VALUE;`, true],
  ["A07-template-substitution", `const s = \`\${bail()}\`;\n  void s;`, true],
  ["A08-array-element", `const a = [bail()];\n  void a;`, true],
  ["A09-binary-left", `const n = bail() + 1;\n  void n;`, true],
  ["A10-property-access", `const p = bail().x;\n  void p;`, true],
  ["A11-element-access-index", `const q = HOLDER[bail()];\n  void q;`, true],
  ["A12-spread-array", `const a = [...bail()];\n  void a;`, true],
  ["A13-spread-object", `const o = { ...bail() };\n  void o;`, true],
  ["A14-assignment-rhs", `let z;\n  z = bail();\n  void z;`, true],
  ["A15-module-exports-call", `module.exports = bail();`, true],
  ["A16-new-argument", `const i = new Holder(bail());\n  void i;`, true],
  ["A17-throw-argument", `throw bail();`, true],
  ["A18-nested-objlit-value", `const o = { a: { b: bail() } };\n  void o;`, true],
  ["A19-if-test", `if (bail()) { void 0; }`, true],
  ["A20-tagged-template", `const t = tag\`\${bail()}\`;\n  void t;`, true],
  [
    "A21-destructuring-target",
    `let x;\n  ({ [bail()]: x } = HOLDER);\n  void x;`,
    true,
  ],
  ["A22-objlit-value-parens", `const o = { k: (bail()) };\n  void o;`, true],
  ["A23-switch-discriminant", `switch (bail()) { default: break; }`, true],
  ["A24-for-initializer", `for (let i = bail(); false; ) { void i; }`, true],
  ["A25-optional-call-value", `const o = { k: bail?.() };\n  void o;`, true],
  ["A26-exportwrite-objlit", `module.exports = { k: bail() };`, true],
  ["A27-paren-call-statement", `((bail()));`, true],
  ["A28-array-destructure-rhs", `const [d] = bail();\n  void d;`, true],

  // ---------- P0-A negative controls (must NOT end evaluation) ----------
  [
    "N01-deferred-in-function",
    `function later() { return { k: bail() }; }\n  void later;`,
    false,
  ],
  ["N02-conditional-value", `const o = { k: FLAG2 ? bail() : 1 };\n  void o;`, false],
  ["N03-logical-or-right", `SAFE_VALUE || bail();`, false],
  ["N04-logical-and-right", `FALSY && bail();`, false],
  ["N05-caught", `try { bail(); } catch (e) { void e; }`, false],
  ["N06-stable-no-construct", `void 0;`, false],

  // ---------- P0-B: multi-path completion ----------
  [
    "B01-heritage-multipath",
    `class C extends maybe() {}\n  void C;`,
    true,
    `function maybe() {\n  if (FLAG) {\n    throw new Error("boom");\n  }\n  return 1;\n}`,
  ],
  [
    "B02-heritage-both-invalid",
    `class C extends twoBad() {}\n  void C;`,
    true,
    `function twoBad() {\n  if (FLAG) {\n    return 1;\n  }\n  return 2;\n}`,
  ],
  [
    "B03-heritage-throw-or-async",
    `class C extends mixed() {}\n  void C;`,
    true,
    `async function mixed() {\n  if (FLAG) {\n    throw new Error("boom");\n  }\n  return 1;\n}`,
  ],
  [
    "B04-multipath-plain-call",
    `multi();`,
    false,
    `function multi() {\n  if (FLAG2) {\n    throw new Error("boom");\n  }\n  return 1;\n}`,
  ],
  [
    "B05-heritage-multipath-completes",
    `class C extends maybe2() {}\n  void C;`,
    false,
    `function maybe2() {\n  if (FLAG2) {\n    throw new Error("boom");\n  }\n  return safeOp;\n}`,
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

function tag(parts) {
  return parts.join("");
}

function sink(x) {
  return x;
}

function Holder(x) {
  this.x = x;
}

const SAFE_VALUE = "safe-value";
const FALSY = 0;
const HOLDER = { k: 1 };
const FLAG = process.env.FIXTURE_LIB_MODE === "fast";
const FLAG2 = process.env.FIXTURE_LIB_OTHER === "yes";
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
        name: `p0probe-${id.toLowerCase()}`,
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
console.log("generated", manifest.length, "probe fixtures");
