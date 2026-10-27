#!/usr/bin/env bash
# BL-111 inventory setup (see inventory.md). Writes, under <out-dir>:
#   natives/    the loader's own JavaScript, from process.binding("natives")
#   proj/       the probe project (relative, bare, main-less, exports-map,
#               JSON and ES module loads)
#   names.json  the candidate property names drawn from natives/
# Then: node probe-inherited.cjs <out-dir>/proj <out-dir>/names.json
#   (BL-114: add --require-esm to also require() src/req-esm.mjs, which has
#   a static dependency, and src/req-leaf.mjs, which has none)
# Usage: bash setup.sh <out-dir>
set -eu
D=${1:?usage: setup.sh <out-dir>}
mkdir -p "$D/natives"
node -e '
const fs = require("fs");
const n = process.binding("natives");
const extra = ["internal/fs/utils", "path", "internal/url", "internal/process/pre_execution", "internal/main/run_main_module"];
for (const k of Object.keys(n).filter((k) => k.startsWith("internal/modules/") || extra.includes(k))) {
  fs.writeFileSync(process.argv[1] + "/" + k.replace(/\//g, "__") + ".js", n[k]);
}
' "$D/natives" 2>/dev/null
P=$D/proj
rm -rf "$P"; mkdir -p "$P/src" "$P/node_modules/with-main" "$P/node_modules/no-main" "$P/node_modules/with-exports/lib" "$P/node_modules/esm-pkg"
echo 'module.exports = "local";' > "$P/src/local.js"
echo '{"v": 1}' > "$P/src/data.json"
echo 'import p from "esm-pkg"; export const v = p;' > "$P/src/esm.mjs"
echo '{"name":"with-main","main":"lib.js"}' > "$P/node_modules/with-main/package.json"
echo 'exports.name = "with-main";' > "$P/node_modules/with-main/lib.js"
echo '{"name":"no-main"}' > "$P/node_modules/no-main/package.json"
echo 'exports.name = "no-main";' > "$P/node_modules/no-main/index.js"
echo '{"name":"with-exports","exports":{".":"./lib/main.js","./feature":"./lib/feature.js"}}' > "$P/node_modules/with-exports/package.json"
echo 'exports.name = "with-exports";' > "$P/node_modules/with-exports/lib/main.js"
echo 'exports.name = "with-exports/feature";' > "$P/node_modules/with-exports/lib/feature.js"
echo '{"name":"esm-pkg","type":"module","exports":"./index.js"}' > "$P/node_modules/esm-pkg/package.json"
echo 'export default "esm-pkg";' > "$P/node_modules/esm-pkg/index.js"
echo 'export { default } from "./req-dep.mjs";' > "$P/src/req-esm.mjs"
echo 'export default "req-dep";' > "$P/src/req-dep.mjs"
echo 'export default "req-leaf";' > "$P/src/req-leaf.mjs"
node -e '
const fs = require("fs");
const dir = process.argv[1];
const names = new Set();
for (const f of fs.readdirSync(dir)) {
  const src = fs.readFileSync(dir + "/" + f, "utf8");
  for (const m of src.matchAll(/\.([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/[\x27"]([A-Za-z_$.\/][\w$.\/-]{0,40})[\x27"]/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*:/g)) names.add(m[1]);
}
for (let i = 0; i < 50; i++) names.add(String(i));
fs.writeFileSync(process.argv[2], JSON.stringify([...names]));
console.log(names.size, "candidate names");
' "$D/natives" "$D/names.json"
