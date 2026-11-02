"use strict";
/**
 * Task BL-122 — the load workload `probe-reach.cjs` runs: writes a small
 * project under `root` (removed first) with a nested package loaded
 * through `main`, a package with `exports` and a subpath, a JSON file, a
 * relative load and a `require.resolve`.
 */
const fs = require("fs");
const path = require("path");

module.exports = function makeFixture(root) {
  fs.rmSync(root, { recursive: true, force: true });
  const files = {
    "node_modules/plain/package.json": { name: "plain", version: "1.0.0", main: "index.js" },
    "node_modules/plain/index.js": `module.exports = { a: 1, j: require("./data.json") };\n`,
    "node_modules/plain/data.json": { x: 1 },
    "node_modules/withexp/package.json": {
      name: "withexp",
      version: "1.0.0",
      exports: { ".": "./lib/main.js", "./sub": "./lib/sub.js" },
    },
    "node_modules/withexp/lib/main.js": `module.exports = require("./sub-local");\n`,
    "node_modules/withexp/lib/sub-local.js": `module.exports = 2;\n`,
    "node_modules/withexp/lib/sub.js": `module.exports = 3;\n`,
    "node_modules/wrap/package.json": { name: "wrap", version: "1.0.0", main: "index.js" },
    "node_modules/wrap/index.js":
      `module.exports = [require("inner"), require("withexp"), require("withexp/sub"), require.resolve("plain")];\n`,
    "node_modules/wrap/node_modules/inner/package.json": { name: "inner", version: "1.0.0" },
    "node_modules/wrap/node_modules/inner/index.js": `module.exports = "inner";\n`,
    // The ES module workloads (task BL-122's independent audit): an ES
    // module `require()`d and one `import()`ed, each importing a CommonJS
    // package with `exports`, an ES module package, and a relative module.
    "node_modules/esmdep/package.json": {
      name: "esmdep",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./index.js" },
    },
    "node_modules/esmdep/index.js": `export default "esmdep";\n`,
    "node_modules/esmuser/package.json": { name: "esmuser", version: "1.0.0" },
    "node_modules/esmuser/a.mjs":
      `import w from "withexp";\nimport e from "esmdep";\nimport l from "./local-a.mjs";\nexport default [w, e, l].join();\n`,
    "node_modules/esmuser/local-a.mjs": `export default "la";\n`,
    "node_modules/esmuser/b.mjs":
      `import s from "withexp/sub";\nimport e from "esmdep";\nimport l from "./local-b.mjs";\nexport default [s, e, l].join();\n`,
    "node_modules/esmuser/local-b.mjs": `export default "lb";\n`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  }
};
