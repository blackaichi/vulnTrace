// Task BL-122 (independent audit, round 1, finding 5) — RWF-163 through
// the ES module resolver. Usage:
//
//   node scripts/bl122-trust-boundary-reach/require-esm-route.mjs <dir> <node-binary>...
//
// The ES module resolver (`internal/modules/esm/resolve`) is loaded lazily,
// and destructures `realpathSync` and `resolve` from `fs` and `path` when
// it loads. A replacement made before that first load is what it keeps.
// Per binary and per replacement, writes BL-092's decoy setup under
// `<dir>`, where `wrap/index.js` replaces the member and then `require()`s
// an ES module importing `vuln-lib/index.js`, and prints whether the
// affected top-level instance's `parse` ran ("called"), the decoy's ran
// ("decoy"), or the load threw ("throws").
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [dir, ...binaries] = process.argv.slice(2);
if (!dir || binaries.length === 0) {
  console.error("usage: require-esm-route.mjs <dir> <node-binary>...");
  process.exit(2);
}
const REWRITE = `.replace("/wrap/node_modules/vuln-lib", "/vuln-lib")`;
const PATCHES = {
  realpathSync: `const m = require("fs"); const o = m.realpathSync; m.realpathSync = function (p, ...a) { return o.call(this, typeof p === "string" ? p${REWRITE} : p, ...a); };\n`,
  resolve: `const m = require("path"); const o = m.resolve; m.resolve = function (...a) { const r = o.apply(this, a); return typeof r === "string" ? r${REWRITE} : r; };\n`,
  // BL-122's independent audit (round 2): the ES module loader reads the
  // source with `readFileSync(url)` and no encoding, which opens the file
  // through `fs.openSync` on the same exports object.
  openSync: `const m = require("fs"); const o = m.openSync; m.openSync = function (p, ...a) { const s = p instanceof URL ? p.href : String(p); if (s.includes("/wrap/node_modules/vuln-lib/index.js")) { const t = s${REWRITE}; return o.call(this, p instanceof URL ? new URL(t) : t, ...a); } return o.call(this, p, ...a); };\n`,
  none: ``,
};
function write(root, patch) {
  rmSync(root, { recursive: true, force: true });
  const files = {
    "node_modules/vuln-lib/package.json": `{"name":"vuln-lib","version":"1.0.0","main":"index.js"}`,
    "node_modules/vuln-lib/index.js": `exports.parse = () => console.log("called");\n`,
    "node_modules/wrap/package.json": `{"name":"wrap","version":"1.0.0","main":"index.js"}`,
    "node_modules/wrap/index.js": patch + `require("./e.mjs");\n`,
    "node_modules/wrap/e.mjs": `import v from "vuln-lib/index.js";\nv.parse("x");\n`,
    "node_modules/wrap/node_modules/vuln-lib/package.json": `{"name":"vuln-lib","version":"99.0.0","main":"index.js"}`,
    "node_modules/wrap/node_modules/vuln-lib/index.js": `exports.parse = () => console.log("decoy");\n`,
    "index.js": `require("wrap");\n`,
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}
console.log(`| release | ${Object.keys(PATCHES).join(" | ")} |`);
console.log(`| --- |${Object.keys(PATCHES).map(() => " --- |").join("")}`);
for (const bin of binaries) {
  const version = execFileSync(bin, ["--version"], { encoding: "utf8" }).trim();
  const cells = [];
  for (const [name, patch] of Object.entries(PATCHES)) {
    const root = join(dir, `${version}-${name}`);
    write(root, patch);
    let out;
    try {
      out = execFileSync(bin, ["--no-warnings", "index.js"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      out = "throws";
    }
    cells.push(out);
  }
  console.log(`| ${version} | ${cells.join(" | ")} |`);
}
