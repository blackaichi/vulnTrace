// BL-114: does a plain DATA property on Object.prototype change what Node's
// loader loads, on the routes this task's inventory found beyond BL-111's
// gadgets.cjs? Each experiment runs in a fresh node process from a fresh
// project, and prints what the load gave: GOOD (the file Node would load
// with no store), EVIL (what the store chose) or THROW.
// Run: node gadgets-releases.cjs
//
// R*: require() of an ES module (unflagged from v20.19 and v22.12): the
//     load context's `source`, read by inheritance.
// G1: `trySelf` (v20's CommonJS loader) destructures `{ data, path }` from
//     `readPackageScope`, which is `false` for a module with no package.json
//     between it and its `node_modules` -- a single-file module
//     `node_modules/helper.js` here.
// G2: `Module._resolveFilename` reads its options' `conditions`, which a
//     `require.resolve(x, { paths })` call's options object inherits.
// G3: `Module.prototype.load` does `this.paths ??= …` (from a v22 release
//     after v22.12.0), so a new module with no own `paths` takes
//     `Object.prototype.paths` as its lookup list (found by BL-114's
//     independent audit).
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const SOURCE = `Object.prototype.source = 'export default "EVIL";';\n`;

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bl114-gadget-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  const esm = (name, files) => {
    w(`node_modules/${name}/package.json`, JSON.stringify({ name, type: "module", exports: "./index.js" }));
    for (const [rel, text] of Object.entries(files)) w(`node_modules/${name}/${rel}`, text);
  };
  w("package.json", JSON.stringify({ name: "app" }));
  esm("esm-dep", { "index.js": 'export { default } from "./dep.js";\n', "dep.js": 'export default "GOOD";\n' });
  esm("esm-cjs-dep", { "index.js": 'import d from "./dep.cjs";\nexport default d;\n', "dep.cjs": 'module.exports = "GOOD";\n' });
  esm("esm-leaf", { "index.js": 'export default "GOOD";\n' });
  esm("esm-builtin-dep", { "index.js": 'import { sep } from "node:path";\nexport default typeof sep === "string" ? "GOOD" : "";\n' });
  // G1, G2: an exports-mapped CommonJS package, and a directory outside
  // node_modules holding what the store points at.
  w("node_modules/good/package.json", JSON.stringify({ name: "good", exports: { ".": "./index.js", "./index.js": "./index.js", "./evil": { evil: "./evil.js", default: "./index.js" } } }));
  w("node_modules/good/index.js", 'module.exports = "GOOD";\n');
  w("node_modules/good/evil.js", 'module.exports = "EVIL";\n');
  w("evil/index.js", 'module.exports = "EVIL";\n');
  w("node_modules/helper.js", 'module.exports = () => require("good/index.js");\n');
  // G3: a module loaded after the store, and a lookup directory outside
  // node_modules holding another `good`.
  w("late.js", 'module.exports = require("good");\n');
  w("evil-modules/good/index.js", 'module.exports = "EVIL";\n');
  return root;
}

const requireDefault = (spec) =>
  `let r; try { r = require(${JSON.stringify(spec)}).default; } catch (e) { r = "THROW " + (e.code || "") + " " + String(e.message).split("\\n")[0].slice(0, 60); }\n` +
  `delete Object.prototype.source;\nconsole.log(r);\n`;

const experiments = {
  "R0 no store, require() of an ES module with a static ES dependency": () => requireDefault("esm-dep"),
  "R1 Object.prototype.source, require() of an ES module with a static ES dependency": () => SOURCE + requireDefault("esm-dep"),
  "R2 Object.prototype.source, require() of an ES module with a static CommonJS dependency": () => SOURCE + requireDefault("esm-cjs-dep"),
  "R3 Object.prototype.source, require() of an ES module with no dependency": () => SOURCE + requireDefault("esm-leaf"),
  "R4 Object.prototype.source, require() of an ES module whose only dependency is a builtin": () => SOURCE + requireDefault("esm-builtin-dep"),
  "G0 no store, a module with no package scope requires an exports-mapped package": () =>
    `let r; try { r = require("helper")(); } catch (e) { r = "THROW " + String(e.message).split("\\n")[0].slice(0, 60); }\nconsole.log(r);\n`,
  "G1 Object.prototype.data and .path, a module with no package scope requires an exports-mapped package": (root) =>
    `Object.prototype.data = { name: "good", exports: { "./index.js": "./index.js" } };\n` +
    `Object.prototype.path = ${JSON.stringify(path.join(root, "evil"))};\n` +
    `let r; try { r = require("helper")(); } catch (e) { r = "THROW " + String(e.message).split("\\n")[0].slice(0, 60); }\n` +
    `delete Object.prototype.data; delete Object.prototype.path;\nconsole.log(r);\n`,
  "G1b the same through getters that answer only a `false` receiver (an accessor store)": (root) =>
    `const fake = { name: "good", exports: { "./index.js": "./index.js" } };\n` +
    `const dir = ${JSON.stringify(path.join(root, "evil"))};\n` +
    `for (const [k, v] of [["data", fake], ["path", dir]]) Object.defineProperty(Object.prototype, k, { configurable: true, get() { "use strict"; return this === false ? v : undefined; }, set(x) { Object.defineProperty(this, k, { value: x, writable: true, enumerable: true, configurable: true }); } });\n` +
    `let r; try { r = require("helper")(); } catch (e) { r = "THROW " + String(e.message).split("\\n")[0].slice(0, 60); }\n` +
    `delete Object.prototype.data; delete Object.prototype.path;\nconsole.log(r);\n`,
  "G2b Object.prototype.conditions = a Set, require(require.resolve(x, { paths }))": (root) =>
    `Object.prototype.conditions = new Set(["evil", "require", "node", "default"]);\n` +
    `let r; try { r = require(require.resolve("good/evil", { paths: [${JSON.stringify(root)}] })); } catch (e) { r = "THROW " + String(e.message).split("\\n")[0].slice(0, 60); }\n` +
    `delete Object.prototype.conditions;\nconsole.log(r);\n`,
  "G3 Object.prototype.paths = [dir], then a module loaded after it requires a bare name": (root) =>
    `Object.prototype.paths = [${JSON.stringify(path.join(root, "evil-modules"))}];\n` +
    `let r; try { r = require("./late.js"); } catch (e) { r = "THROW " + String(e.message).split("\\n")[0].slice(0, 60); }\n` +
    `delete Object.prototype.paths;\nconsole.log(r);\n`,
  "G2 Object.prototype.conditions, require(require.resolve(x, { paths }))": (root) =>
    `Object.prototype.conditions = ["evil", "require", "node", "default"];\n` +
    `let r; try { r = require(require.resolve("good/evil", { paths: [${JSON.stringify(root)}] })); } catch (e) { r = "THROW " + String(e.message).split("\\n")[0].slice(0, 60); }\n` +
    `delete Object.prototype.conditions;\nconsole.log(r);\n`,
};

for (const [name, src] of Object.entries(experiments)) {
  const root = project();
  fs.writeFileSync(path.join(root, "main.cjs"), src(root));
  let out;
  try {
    out = execFileSync(process.execPath, ["--no-warnings", path.join(root, "main.cjs")], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }).trim();
  } catch (e) {
    out = "PROCESS FAILED " + String(e.stderr).split("\n").filter(Boolean).slice(0, 2).join(" | ");
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`${out.padEnd(10)} ${name}`);
}
