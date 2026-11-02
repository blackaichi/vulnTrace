"use strict";
/**
 * Task BL-122 — WHICH BUILTIN OBJECTS OUTSIDE THE INTRINSIC PROTOTYPES DOES
 * NODE'S OWN LOADER TOUCH AFTER STARTUP?
 *
 *   node scripts/bl122-trust-boundary-reach/probe-reach.cjs [<fixture-root>]
 *
 * The trust boundary (SOUNDNESS-CONTRACT § 1) covers the ECMAScript
 * intrinsic prototypes. ADR 0010's decision record left its reach over
 * four other kinds of builtin object undecided:
 *
 * - O1 a builtin constructor's own properties (`Array[Symbol.species]`,
 *   `Object.keys`, `Promise.resolve`, ...), and `%TypedArray%`'s;
 * - O2 Node's own builtin prototypes and constructors (`URL.prototype`,
 *   `Buffer.prototype`, `EventEmitter.prototype`, ...);
 * - O3 a builtin module's exports object (`require("fs")`, ...);
 * - O4 a global: a namespace object (`JSON`, `Math`, `Reflect`, ...),
 *   `process`, and `globalThis`'s own properties.
 *
 * This script replaces every configurable member of those objects with a
 * recording wrapper: a function with one that records its call, an
 * accessor with one that records its get or set, and (for O3 and the
 * namespaces and `process`) a writable data property with an accessor
 * that records its read. It then runs a load workload (a nested package
 * with `main`, a package with `exports` and a subpath, a JSON file, a
 * relative load, `require.resolve`) and prints every member the workload
 * touched, with its count. `require("module")` is not wrapped: it is
 * Node's loader object, which the analyzer models
 * (`tests/oracle/bl113-trust-boundary.cases.ts`, `modeled.*`).
 *
 * A member touched is a CANDIDATE route, not a measured one: whether a
 * change to it redirects a load, and whether the analyzer sees the
 * change, is measured end to end by `tests/oracle/bl122-*`. A member NOT
 * touched is not touched by this workload on this release only.
 *
 * The fixture is written by `make-fixture.cjs` beside this file.
 */
const path = require("path");
const fixture = process.argv[2] ?? path.join(require("os").tmpdir(), "bl122-probe-fixture");
require("./make-fixture.cjs")(fixture);

const Module = require("module");
const hits = new Map();
let on = false;
const hit = (n) => {
  if (on) hits.set(n, (hits.get(n) || 0) + 1);
};
const wrapped = new WeakSet();
const { apply: reflectApply, construct: reflectConstruct, ownKeys: reflectOwnKeys } = Reflect;
const { defineProperty: define, getOwnPropertyDescriptor: describe } = Object;
const SKIP = new Set(["prototype", "constructor", "length", "name", "caller", "arguments"]);

function wrapObj(obj, label, { data = false } = {}) {
  if (obj === null || (typeof obj !== "object" && typeof obj !== "function") || wrapped.has(obj)) return;
  wrapped.add(obj);
  for (const k of reflectOwnKeys(obj)) {
    if (SKIP.has(k)) continue;
    let d;
    try {
      d = describe(obj, k);
    } catch {
      continue;
    }
    if (!d || !d.configurable) continue;
    const name = `${label}.${String(k)}`;
    try {
      if (d.get || d.set) {
        const { get: g, set: s } = d;
        define(obj, k, {
          configurable: true,
          enumerable: d.enumerable,
          get: g && function () { hit(`${name} [get]`); return g.call(this); },
          set: s && function (v) { hit(`${name} [set]`); return s.call(this, v); },
        });
      } else if (typeof d.value === "function") {
        const f = d.value;
        const w = function (...a) {
          hit(`${name}()`);
          return new.target ? reflectConstruct(f, a, new.target) : reflectApply(f, this, a);
        };
        for (const kk of reflectOwnKeys(f)) {
          if (kk === "prototype" || kk === "length" || kk === "name") continue;
          try { define(w, kk, describe(f, kk)); } catch {}
        }
        if (f.prototype) try { define(w, "prototype", { value: f.prototype, writable: true }); } catch {}
        define(obj, k, { ...d, value: w });
      } else if (data && d.writable) {
        let v = d.value;
        define(obj, k, {
          configurable: true,
          enumerable: d.enumerable,
          get() { hit(`${name} [read]`); return v; },
          set(x) { v = x; },
        });
      }
    } catch {}
  }
}

const INTRINSIC_CONSTRUCTORS = [
  "Object", "Function", "Array", "Number", "Boolean", "String", "Symbol", "Date", "Promise", "RegExp",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
  "ArrayBuffer", "SharedArrayBuffer", "DataView", "Map", "Set", "WeakMap", "WeakSet", "WeakRef",
  "FinalizationRegistry", "Proxy", "BigInt", "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array",
  "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array",
];
// O1
for (const c of INTRINSIC_CONSTRUCTORS) wrapObj(globalThis[c], `O1 ${c}`);
wrapObj(Object.getPrototypeOf(Int8Array), "O1 %TypedArray%");
// O4 namespaces
for (const n of ["JSON", "Math", "Reflect", "Atomics", "Intl", "console"]) wrapObj(globalThis[n], `O4 ${n}`, { data: true });
// O2
const EventEmitter = require("events");
for (const [n, o] of Object.entries({
  "URL.prototype": URL.prototype,
  "URLSearchParams.prototype": URLSearchParams.prototype,
  "Buffer.prototype": Buffer.prototype,
  "Buffer": Buffer,
  "EventEmitter.prototype": EventEmitter.prototype,
  "URL": URL,
})) wrapObj(o, `O2 ${n}`);
// O3
for (const m of Module.builtinModules) {
  if (m === "module" || m.startsWith("_")) continue;
  let e;
  try { e = require(m); } catch { continue; }
  wrapObj(e, `O3 require("${m}")`, { data: true });
}
// O4 process and globalThis
wrapObj(process, "O4 process", { data: true });
wrapObj(globalThis, "O4 globalThis");

on = true;
const r = require(path.join(fixture, "node_modules/wrap"));
const r2 = require(path.join(fixture, "node_modules/plain"));
on = false;

console.log(`# node ${process.version}; workload ok: ${Array.isArray(r) && r2.a === 1}`);
for (const [k, v] of [...hits].sort(([a], [b]) => (a < b ? -1 : 1))) console.log(`${k}\t${v}`);
