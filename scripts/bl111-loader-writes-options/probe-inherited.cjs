// BL-111 inventory probe: which property names Node's own loader reads or
// writes BY INHERITANCE on Object.prototype / Array.prototype /
// Function.prototype while loading modules. Each candidate name gets a
// recording accessor on each prototype that does not own it; an access
// whose stack shows a node:internal/modules frame is recorded with that
// frame. Run: node probe-inherited.cjs <project-dir> <names.json>
"use strict";
const fs = require("fs");
const path = require("path");
const [projectDir, namesFile] = process.argv.slice(2);
const names = JSON.parse(fs.readFileSync(namesFile, "utf8"));
const symbols = Object.getOwnPropertyNames(Symbol)
  .map((k) => Symbol[k])
  .filter((v) => typeof v === "symbol");

const hits = new Map();
let depth = 0;
// Everything the recorder uses is captured before any accessor is installed,
// and its holder has no prototype, so a candidate accessor never answers
// the recorder's own reads.
const origCapture = Error.captureStackTrace;
const apply = Reflect.apply;
const split = String.prototype.split;
const trim = String.prototype.trim;
const test = RegExp.prototype.test;
const create = Object.create;
const INTERNAL = /node:internal\/(modules|fs)|node:path/;
const SELF = /probe-inherited\.cjs/;
function loaderFrame() {
  const holder = create(null);
  const old = Error.stackTraceLimit;
  Error.stackTraceLimit = 12;
  origCapture(holder, loaderFrame);
  Error.stackTraceLimit = old;
  const lines = apply(split, holder.stack, ["\n"]);
  // The accessor's caller: the first frame outside this file (V8 names the
  // accessor frame after the receiver's type, `Module.set`).
  for (let i = 1; i < lines.length; i++) {
    if (!apply(test, SELF, [lines[i]])) {
      return apply(test, INTERNAL, [lines[i]]) ? apply(trim, lines[i], []) : undefined;
    }
  }
  return undefined;
}
function record(kind, proto, key, receiver) {
  if (depth > 0) return;
  depth += 1;
  try {
    const frame = loaderFrame();
    if (frame === undefined) return;
    const recv = Array.isArray(receiver) ? "array" : typeof receiver === "function" ? "function" : receiver === null ? "null" : typeof receiver;
    const id = `${kind} ${proto} ${String(key)} <${recv}> @ ${frame.replace(/^at /, "").replace(/\(?node:/, "node:")}`;
    hits.set(id, (hits.get(id) || 0) + 1);
  } finally {
    depth -= 1;
  }
}
const protos = [
  ["Object.prototype", Object.prototype],
  ["Array.prototype", Array.prototype],
  ["Function.prototype", Function.prototype],
];
const installed = [];
const failed = [];
for (const [pname, proto] of protos) {
  for (const key of [...names, ...symbols]) {
    if (Object.prototype.hasOwnProperty.call(proto, key)) continue;
    // Keep the probe itself alive: a getter returning undefined is what an
    // absent property gives; a setter defines an own data property.
    try {
      Object.defineProperty(proto, key, {
        __proto__: null,
        configurable: true,
        get() { record("get", pname, key, this); return undefined; },
        set(v) {
          record("set", pname, key, this);
          Object.defineProperty(this, key, { __proto__: null, value: v, writable: true, enumerable: true, configurable: true });
        },
      });
      installed.push([proto, key]);
    } catch (e) {
      failed.push(`${pname}.${String(key)}: ${e.message}`);
    }
  }
}

const results = {};
function attempt(label, fn) {
  try { results[label] = String(fn()).slice(0, 60); } catch (e) { results[label] = "THROW " + e.message.slice(0, 80); }
}
const r = require("module").createRequire(path.join(projectDir, "src", "index.js"));
attempt("relative", () => r("./local.js"));
attempt("bare-main", () => r("with-main").name);
attempt("bare-no-main", () => r("no-main").name);
attempt("bare-exports", () => r("with-exports").name);
attempt("bare-exports-subpath", () => r("with-exports/feature").name);
attempt("json", () => r("./data.json").v);
attempt("resolve-paths", () => r.resolve("with-main", { paths: [projectDir] }));
const done = () => {
  for (const [proto, key] of installed) delete proto[key];
  const out = [...hits.entries()].sort().map(([k, n]) => `${n}\t${k}`);
  process.stdout.write(JSON.stringify({ node: process.version, installed: installed.length, failed, results, hits: out }, null, 1));
};
import(path.join(projectDir, "src", "esm.mjs")).then(
  (m) => { results.esm = String(m.v); done(); },
  (e) => { results.esm = "THROW " + e.message.slice(0, 80); done(); },
);
