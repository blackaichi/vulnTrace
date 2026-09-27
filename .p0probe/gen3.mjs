// Round 3: P0-D (root/entrypoint provenance, post RWF-021), P0-F (write /
// observability semantics) and the duplicate-PackageInstance twin control.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures3");
fs.rmSync(ROOT, { recursive: true, force: true });
fs.mkdirSync(ROOT, { recursive: true });

const LIB_PKG = `{ "name": "fixture-lib", "version": "1.0.0", "main": "index.js" }\n`;
const DANGER = `"use strict";
function explode(input) {
  return "danger:" + input;
}
exports.explode = explode;
`;

const PRELUDE = `"use strict";
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
`;

// Each case: { id, endsEval, entry, lib, target }
const cases = [];

// ---------- P0-D: entrypoint root provenance (RWF-021) ----------
// The CUTOFF is in the ENTRYPOINT itself, above its own export write.
// RWF-021 must still root reachability at the exported callable.
function dCase(id, cutoff, exportWrite, endsEval) {
  cases.push({
    id,
    endsEval,
    entry: `"use strict";
const fixture = require("fixture-lib");

function main(input) {
  return fixture(input);
}

function bail() {
  throw new Error("entry bail");
}

if (process.env.FIXTURE_LIB_MODE === "fast") {
  ${cutoff}
}

${exportWrite}
`,
    lib: `"use strict";
const danger = require("./danger");
module.exports = function run(input) {
  return danger.explode(input);
};
`,
  });
}

dCase("D01-entry-cutoff-named-export", `bail();`, `module.exports = main;`, true);
dCase(
  "D02-entry-cutoff-anonymous-export",
  `bail();`,
  `module.exports = function (input) {\n  return fixture(input);\n};`,
  true,
);
dCase(
  "D03-entry-cutoff-property-export",
  `bail();`,
  `exports.main = main;`,
  true,
);
// P0-A gap construct in the ENTRYPOINT -- does the A-family gap interact
// with root widening?
dCase(
  "D04-entry-gap-objlit-value",
  `const o = { k: bail() };\n  void o;`,
  `module.exports = main;`,
  true,
);

// ---------- P0-F: write / observability semantics ----------
// A PROPERTY export overwritten after a cutoff.
cases.push({
  id: "F01-property-export-overwrite",
  endsEval: true,
  entry: `const fixture = require("fixture-lib");
module.exports = function main(input) {
  return fixture.run(input);
};
`,
  lib: `${PRELUDE}
if (process.env.FIXTURE_LIB_MODE === "fast") {
  exports.run = dangerousOp;
  bail();
}

exports.run = safeOp;
`,
});
// Same, but the cutoff is a P0-A GAP position.
cases.push({
  id: "F02-property-export-overwrite-gap",
  endsEval: true,
  entry: `const fixture = require("fixture-lib");
module.exports = function main(input) {
  return fixture.run(input);
};
`,
  lib: `${PRELUDE}
if (process.env.FIXTURE_LIB_MODE === "fast") {
  exports.run = dangerousOp;
  const o = { k: bail() };
  void o;
}

exports.run = safeOp;
`,
});
// Object-literal whole-module export overwritten after a GAP cutoff.
cases.push({
  id: "F03-objlit-export-overwrite-gap",
  endsEval: true,
  entry: `const fixture = require("fixture-lib");
module.exports = function main(input) {
  return fixture.run(input);
};
`,
  lib: `${PRELUDE}
if (process.env.FIXTURE_LIB_MODE === "fast") {
  module.exports = { run: dangerousOp };
  const o = { k: bail() };
  void o;
}

module.exports = { run: safeOp };
`,
});
// Control: property export, no cutoff at all -> genuinely NOT_AFFECTED.
cases.push({
  id: "F04-property-export-control",
  endsEval: false,
  entry: `const fixture = require("fixture-lib");
module.exports = function main(input) {
  return fixture.run(input);
};
`,
  lib: `${PRELUDE}
exports.run = safeOp;
`,
});

const manifest = [];
for (const c of cases) {
  const dir = path.join(ROOT, c.id);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  const lib = path.join(dir, "node_modules", "fixture-lib");
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: `p0probe3-${c.id.toLowerCase()}`,
        version: "1.0.0",
        private: true,
        dependencies: { "fixture-lib": "1.0.0" },
      },
      null,
      2,
    ) + "\n",
  );
  fs.writeFileSync(path.join(dir, "src", "index.cjs"), c.entry);
  fs.writeFileSync(path.join(lib, "package.json"), LIB_PKG);
  fs.writeFileSync(path.join(lib, "danger.js"), DANGER);
  fs.writeFileSync(path.join(lib, "index.js"), c.lib);

  // Duplicate same-name/same-version TWIN, installed but never reached.
  // Family A/B controls must never substitute one instance for the other.
  const twin = path.join(dir, "node_modules", "elsewhere", "node_modules", "fixture-lib");
  fs.mkdirSync(twin, { recursive: true });
  fs.writeFileSync(path.join(twin, "package.json"), LIB_PKG);
  fs.writeFileSync(path.join(twin, "danger.js"), DANGER);
  fs.writeFileSync(path.join(twin, "index.js"), c.lib);
  fs.mkdirSync(path.join(dir, "node_modules", "elsewhere"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "node_modules", "elsewhere", "package.json"),
    `{ "name": "elsewhere", "version": "1.0.0", "main": "index.js" }\n`,
  );
  fs.writeFileSync(
    path.join(dir, "node_modules", "elsewhere", "index.js"),
    `"use strict";\nmodule.exports = {};\n`,
  );

  manifest.push({ id: c.id, endsEval: c.endsEval, dir });
}
fs.writeFileSync(
  path.join(ROOT, "manifest.json"),
  JSON.stringify(manifest, null, 2),
);
console.log("generated", manifest.length, "round-3 probe fixtures (each with a duplicate PackageInstance twin)");
