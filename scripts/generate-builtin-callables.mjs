#!/usr/bin/env node
/**
 * Task A-3a — regenerates `src/code-intelligence/builtin-callables.data.ts`,
 * the table of builtin callables Node itself supplies, from the Node that
 * runs this script:
 *
 *   node scripts/generate-builtin-callables.mjs && npx prettier --write \
 *     src/code-intelligence/builtin-callables.data.ts
 *
 * What it enumerates is listed below and in the generated file's header.
 * `tests/oracle/builtin-admission.test.ts` checks that every entry exists,
 * as a function, in the Node the suite runs on, or is a version-dependent
 * key recorded in `builtin-callables.ts`
 * (`VERSION_DEPENDENT_BUILTIN_CALLABLES`). Which of these a call may use
 * to skip an edge, and how, is `builtin-callables.ts`'s -- this file
 * only produces the data.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Every global root below must be in `AMBIENT_GLOBAL_NAMES` (escape-row.ts):
// a write to one of those names is an escaping assignment, which keeps the
// table's no-edge proofs sound against a polyfill. The admission test fails
// if a key is rooted anywhere else.
const GLOBAL_FUNCTIONS = [
  "setTimeout", "setInterval", "setImmediate", "clearTimeout",
  "clearInterval", "clearImmediate", "queueMicrotask", "structuredClone",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURIComponent",
  "decodeURIComponent", "encodeURI", "decodeURI", "fetch",
];
const CONSTRUCTORS = [
  "Object", "Array", "String", "Number", "Boolean", "Date", "RegExp",
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError",
  "EvalError", "URIError", "AggregateError", "Promise", "Map", "Set",
  "WeakMap", "WeakSet", "Symbol", "Proxy", "ArrayBuffer",
  "SharedArrayBuffer", "DataView", "Int8Array", "Uint8Array",
  "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array",
  "Uint32Array", "Float32Array", "Float64Array", "BigInt", "BigInt64Array",
  "BigUint64Array", "Buffer",
];
const NAMESPACES = [
  "Object", "Array", "Number", "String", "Math", "JSON", "Reflect",
  "Promise", "Symbol", "Date", "BigInt", "Buffer", "console", "process",
  "ArrayBuffer", "Error",
];
/** Loader and code-execution capabilities (lane C): never listed. */
const EXCLUDED = new Set([
  "process.dlopen",
  "process.binding",
  "process._linkedBinding",
  "process.getBuiltinModule",
  "process.reallyExit",
  "process._rawDebug",
]);
/** Builtin modules; the loader ones (vm, module, child_process, worker_threads, inspector, repl) are absent. */
const MODULES = [
  "fs", "path", "os", "util", "crypto", "url", "querystring", "events",
  "stream", "zlib", "assert", "buffer", "string_decoder", "timers",
  "readline", "http", "https", "net", "dns", "tls", "perf_hooks",
];

const IDENTIFIER = /^[A-Za-z$][\w$]*$/;
const keys = [];

for (const name of [...GLOBAL_FUNCTIONS, ...CONSTRUCTORS]) {
  if (typeof globalThis[name] === "function") keys.push(`global:${name}`);
}
for (const ns of NAMESPACES) {
  const value = globalThis[ns];
  for (const member of Object.getOwnPropertyNames(value)) {
    let fn;
    try {
      fn = value[member];
    } catch {
      continue;
    }
    if (typeof fn !== "function" || member.startsWith("_")) continue;
    if (!IDENTIFIER.test(member)) continue;
    if (EXCLUDED.has(`${ns}.${member}`)) continue;
    keys.push(`global:${ns}.${member}`);
  }
}
for (const stream of ["stdout", "stderr"]) {
  keys.push(`global:process.${stream}.write`);
}
// process is an EventEmitter: its listener methods are inherited, not own.
for (const member of Object.getOwnPropertyNames(
  require("events").EventEmitter.prototype,
)) {
  if (member === "constructor" || member.startsWith("_")) continue;
  if (typeof process[member] === "function") keys.push(`global:process.${member}`);
}
for (const specifier of MODULES) {
  const mod = require(specifier);
  const members =
    typeof mod === "function" ? Object.getOwnPropertyNames(mod) : Object.keys(mod);
  if (typeof mod === "function") keys.push(`module:${specifier}:`);
  for (const member of members) {
    let fn;
    try {
      fn = mod[member];
    } catch {
      continue;
    }
    if (typeof fn !== "function" || member.startsWith("_")) continue;
    if (!IDENTIFIER.test(member)) continue;
    keys.push(`module:${specifier}:${member}`);
  }
}
const promises = require("fs").promises;
for (const member of Object.keys(promises)) {
  if (typeof promises[member] === "function") {
    keys.push(`module:fs:promises.${member}`);
  }
}

const sorted = [...new Set(keys)].sort();
const lines = [
  "/**",
  " * The known builtin callables (task A-3a): every function-valued member",
  " * a pristine Node.js exposes on the ambient globals and the builtin",
  ` * modules below, by exact member path, enumerated from Node ${process.version}`,
  " * by `scripts/generate-builtin-callables.mjs` (do not edit by hand).",
  " * `builtin-callables.ts` owns what the table MEANS; this module is only",
  " * the data. `tests/oracle/builtin-admission.test.ts` checks that every",
  " * entry exists, as a function, in the real Node the suite runs on, or",
  " * is listed in `VERSION_DEPENDENT_BUILTIN_CALLABLES` there.",
  " *",
  " * Key forms: `global:<path>` for an ambient global (`global:setTimeout`,",
  " * `global:Array.isArray`, `global:process.nextTick`) and",
  " * `module:<specifier>:<path>` for a builtin module's export",
  " * (`module:fs:readFile`, `module:fs:promises.readFile`), where an empty",
  " * path is the module value itself (`module:events:`).",
  " *",
  " * Deliberately absent: the loader and code-execution capabilities, which",
  " * lane C owns and which must never earn a no-edge proof here --",
  " * `eval`, `Function`, the modules `vm`, `module`, `child_process`,",
  " * `worker_threads`, `inspector` and `repl`, and `process.dlopen`,",
  " * `process.binding`, `process._linkedBinding`,",
  " * `process.getBuiltinModule`.",
  " */",
  "export const KNOWN_BUILTIN_CALLABLE_KEYS: readonly string[] = [",
  ...sorted.map((key) => `  ${JSON.stringify(key)},`),
  "];",
  "",
];
writeFileSync(
  new URL("../src/code-intelligence/builtin-callables.data.ts", import.meta.url),
  lines.join("\n"),
);
console.log(`wrote ${sorted.length} builtin callables`);
