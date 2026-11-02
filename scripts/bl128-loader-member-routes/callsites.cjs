"use strict";
/**
 * Task BL-128 — WHERE DO NODE'S OWN ES MODULE LOADERS TOUCH EACH MEMBER
 * BL-122's INVENTORY LISTS?
 *
 *   node scripts/bl128-loader-member-routes/callsites.cjs <fixture-root> [require-esm|import]
 *
 * BL-122's `probe-reach.cjs` records THAT a member is touched. This script
 * records WHERE: it wraps the candidate members with a recorder that keeps
 * the first two stack frames outside this file for each call, runs one of
 * BL-122's ES module workloads (`make-fixture.cjs`), and prints each
 * member's call sites with their counts. It changes no value: every
 * wrapper returns what the member returns.
 *
 * The call site says what the loader does with the member's value: a path,
 * a URL or a source it loads, or a check, a format, bookkeeping.
 * `results.md` classifies the members by it. A call site is evidence of
 * what a change COULD reach, not that it does: no change was tried end to
 * end (backlog `BL-129`).
 */
const path = require("path");
const fixture = process.argv[2];
const which = process.argv[3] || "require-esm";
if (!fixture) {
  console.error("usage: callsites.cjs <fixture-root> [require-esm|import]");
  process.exit(2);
}
require(path.join(__dirname, "..", "bl122-trust-boundary-reach", "make-fixture.cjs"))(fixture);
// The workload's paths, computed before recording starts.
const esmA = path.join(fixture, "node_modules/esmuser/a.mjs");
const esmB = require("url").pathToFileURL(path.join(fixture, "node_modules/esmuser/b.mjs")).href;

const sites = new Map();
let on = false;
const ErrorCtor = Error;
const SELF = path.basename(__filename);
function record(name) {
  if (!on) return;
  on = false;
  const frames = new ErrorCtor().stack
    .split("\n")
    .slice(1)
    .map((l) => l.trim().replace(/^at /, ""))
    .filter((l) => !l.includes(SELF))
    .slice(0, 2)
    .map((l) => l.replace(/ \(node:internal\/(modules\/)?/, " ("));
  on = true;
  const k = `${name}\t${frames.join(" < ")}`;
  sites.set(k, (sites.get(k) || 0) + 1);
}
function wrap(obj, key, label) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (!d || !d.configurable) return;
  if (typeof d.value === "function") {
    const f = d.value;
    const w = function (...a) {
      record(`${label}()`);
      return new.target ? Reflect.construct(f, a, new.target) : Reflect.apply(f, this, a);
    };
    for (const kk of Reflect.ownKeys(f)) {
      if (kk === "length" || kk === "name") continue;
      try {
        Object.defineProperty(w, kk, Object.getOwnPropertyDescriptor(f, kk));
      } catch {}
    }
    Object.defineProperty(obj, key, { ...d, value: w });
  } else if (d.get || d.set) {
    Object.defineProperty(obj, key, {
      ...d,
      get: d.get && function () { record(`${label} [get]`); return d.get.call(this); },
      set: d.set && function (v) { record(`${label} [set]`); return d.set.call(this, v); },
    });
  } else if (d.writable) {
    let v = d.value;
    Object.defineProperty(obj, key, {
      configurable: true,
      enumerable: d.enumerable,
      get() { record(`${label} [read]`); return v; },
      set(x) { v = x; },
    });
  }
}

const fs = require("fs");
for (const k of ["String", "Array", "Promise", "RegExp", "Set", "eval"]) wrap(globalThis, k, `globalThis.${k}`);
wrap(JSON, "parse", "JSON.parse");
wrap(Object, "create", "Object.create");
wrap(Object, "defineProperty", "Object.defineProperty");
wrap(Promise, "resolve", "Promise.resolve");
for (const k of ["allocUnsafe", "allocUnsafeSlow", "isEncoding"]) wrap(Buffer, k, `Buffer.${k}`);
for (const k of ["toString", "utf8Slice"]) wrap(Buffer.prototype, k, `Buffer.prototype.${k}`);
for (const k of ["hash", "search", "href", "pathname", "protocol", "hostname", "toString"]) {
  wrap(URL.prototype, k, `URL.prototype.${k}`);
}
for (const k of ["readSync", "closeSync", "openSync", "readFileSync", "realpathSync"]) wrap(fs, k, `fs.${k}`);
for (const k of ["extname", "basename", "dirname", "join", "normalize", "isAbsolute", "toNamespacedPath", "sep", "posix", "resolve"]) {
  wrap(path, k, `path.${k}`);
}
for (const k of ["env", "nextTick", "emitWarning", "_events", "domain"]) wrap(process, k, `process.${k}`);
const types = require("util/types");
for (const k of ["isArrayBufferView", "isPromise"]) wrap(types, k, `util/types.${k}`);
wrap(require("url"), "pathToFileURL", "url.pathToFileURL");
wrap(require("fs/promises"), "readFile", "fs/promises.readFile");
const EventEmitter = require("events");
for (const k of ["emit", "on", "once"]) wrap(EventEmitter.prototype, k, `EventEmitter.prototype.${k}`);

function print(outcome) {
  on = false;
  console.log(`# ${process.version} ${which}: ${outcome}`);
  for (const [k, v] of [...sites].sort()) console.log(`${v}\t${k}`);
}
if (which === "require-esm") {
  let loaded;
  on = true;
  try {
    loaded = require(esmA);
  } catch {}
  on = false;
  print(loaded ? "loaded" : "throws");
} else {
  (async () => {
    let loaded;
    on = true;
    try {
      loaded = await import(esmB);
    } catch {}
    on = false;
    print(loaded ? "loaded" : "throws");
  })();
}
