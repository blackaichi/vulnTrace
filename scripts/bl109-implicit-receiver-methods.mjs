// BL-109 inventory: which members a builtin calls on its receiver BY NAME
// from an operation with no call in the program
// (docs/tasks/BL-109-join-protocol-member.md; FINDINGS RWF-151, RWF-152).
//
// ADR 0008 § 2's protocol-member row accounts a member the runtime may
// invoke implicitly at its definition, by its key. A coercion, an
// iteration, `await` or `JSON.stringify` may also run an INHERITED builtin
// -- `Array.prototype.toString`, `Date.prototype.toJSON`, Node's own
// `Buffer.prototype.toString` -- that calls a further member of its
// receiver by name. This script measures those names, against real Node.
//
// For every prototype object and plain object Node's globals, a few
// intrinsics and every builtin module expose (one level deep), and for
// every trigger below, it runs the trigger on an object inheriting it,
// `Object.create(Proxy(P))`, and records the keys looked up through the
// chain. It then shims each key the trigger read with an own callable
// (returning `0`, and coercing to `0` / `""`) and repeats until no new key
// is read, so a builtin that reads one member before it calls another is
// followed past the first. A key not in ADR 0008 § 2's list is CONFIRMED
// when, with an own function under it (every other read key shimmed), the
// trigger calls that function. Protocol keys are left to the builtin in
// one pass, shimmed in another, and each left alone in turn, so a hook
// that needs an own `valueOf` (`Date.prototype.toJSON`) is reached.
//
// What it does not establish: a member a builtin calls only when the
// receiver holds real internal state (a stream's buffer: Node's streams
// call more of their receiver's members once they hold one -- see the
// `--stream` pass), or past a shim's `0`; a trigger not in the list.
//
// Usage:
//   node scripts/bl109-implicit-receiver-methods.mjs [--list] [--stream]
//
// `--list` prints every candidate expression; `--stream` adds the pass
// over an object inheriting a constructed `stream.Readable`.
//
// Prints, per confirmed name, the triggers and prototypes that call it.

import { execFile } from "node:child_process";
import { builtinModules } from "node:module";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const list = args.includes("--list");
const stream = args.includes("--stream");

/** ADR 0008 § 2's list as amended, by the probe's key names. */
const PROTOCOL = [
  "toString",
  "valueOf",
  "toJSON",
  "then",
  "next",
  "return",
  "throw",
  "Symbol(Symbol.iterator)",
  "Symbol(Symbol.asyncIterator)",
  "Symbol(Symbol.hasInstance)",
  "Symbol(Symbol.toPrimitive)",
  "Symbol(Symbol.dispose)",
  "Symbol(Symbol.asyncDispose)",
];

// The probe run in a separate Node process for one candidate (argv[1]).
const CHILD = String.raw`
const P = eval(process.argv[1]);
const PROTOCOL = new Set(${JSON.stringify(PROTOCOL)});
const TRIGGERS = {
  template: (o) => ${"`${o}`"},
  plus: (o) => o + "",
  unaryPlus: (o) => +o,
  less: (o) => o < 1,
  looseEquality: (o) => o == 1,
  computedKey: (o) => ({ [o]: 1 }),
  in: (o) => o in {},
  outerArray: (o) => "" + [o],
  "JSON.stringify": (o) => JSON.stringify(o),
  "JSON.stringify nested": (o) => JSON.stringify({ a: o }),
  "JSON.parse": (o) => JSON.parse(o),
  String: (o) => String(o),
  Number: (o) => Number(o),
  parseInt: (o) => parseInt(o),
  encodeURIComponent: (o) => encodeURIComponent(o),
  Error: (o) => Error(o),
  "new Date": (o) => new Date(o),
  "Math.max": (o) => Math.max(o),
  "for…of break": (o) => { for (const x of o) break; },
  "for…of": (o) => { let n = 0; for (const x of o) { if (++n > 3) break; } },
  spread: (o) => [...o].slice(0, 3),
  "array destructuring": (o) => { const [a] = o; return a; },
  "object spread": (o) => ({ ...o }),
  "Object.keys": (o) => Object.keys(o),
  "path.join": (o) => require("path").join(o),
  await: async (o) => { await o; },
  "async return": async (o) => (async () => o)(),
  "for await break": async (o) => { for await (const x of o) break; },
};
const keyName = (k) => (typeof k === "symbol" ? String(k) : k);
function shim() {
  const f = function () { return 0; };
  f.valueOf = () => 0;
  f.toString = () => "";
  return f;
}
function build(defs) {
  const reads = new Map();
  const proxy = new Proxy(P, {
    get(t, k, r) {
      const name = keyName(k);
      if (!reads.has(name)) reads.set(name, k);
      return Reflect.get(t, k, r);
    },
  });
  const o = Object.create(proxy);
  for (const [k, v] of defs) {
    try { Object.defineProperty(o, k, { value: v, writable: true, configurable: true }); } catch {}
  }
  return { o, reads };
}
async function run(fn, o) {
  try {
    const r = fn(o);
    if (r && typeof r.then === "function") {
      await Promise.race([Promise.resolve(r).catch(() => {}), new Promise((s) => setTimeout(s, 50))]);
    }
  } catch {}
}
async function survey(fn, keep) {
  const shimmable = (name) => (keep === null ? !PROTOCOL.has(name) : !keep.has(name));
  const shimmed = new Map();
  const protocolRead = new Set();
  for (let round = 0; round < 6; round++) {
    const { o, reads } = build([...shimmed.values()].map((k) => [k, shim()]));
    await run(fn, o);
    let grew = false;
    for (const [name, k] of reads) {
      if (PROTOCOL.has(name)) protocolRead.add(name);
      if (shimmable(name) && !shimmed.has(name)) { shimmed.set(name, k); grew = true; }
    }
    if (!grew) break;
  }
  const confirmed = [];
  for (const [name] of shimmed) {
    if (PROTOCOL.has(name)) continue;
    let hit = false;
    const marker = function () { hit = true; return 0; };
    const { o } = build([...shimmed].map(([n, k]) => [k, n === name ? marker : shim()]));
    await run(fn, o);
    if (hit) confirmed.push(name);
  }
  return { confirmed, protocolRead };
}
(async () => {
  const out = {};
  for (const [trigger, fn] of Object.entries(TRIGGERS)) {
    const found = new Set();
    const builtinProtocol = await survey(fn, null);
    const allShimmed = await survey(fn, new Set());
    for (const k of [...builtinProtocol.confirmed, ...allShimmed.confirmed]) found.add(k);
    for (const p of new Set([...builtinProtocol.protocolRead, ...allShimmed.protocolRead])) {
      for (const k of (await survey(fn, new Set([p]))).confirmed) found.add(k);
    }
    if (found.size) out[trigger] = [...found];
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(0);
})();
`;

// The candidates, enumerated in a separate Node process (requiring every
// builtin module has side effects this process should not carry).
const ENUMERATE = String.raw`
const exprs = new Set();
const seen = new Set();
function add(expr, value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return;
  if (seen.has(value)) return;
  seen.add(value);
  exprs.add(expr);
}
function scan(base, obj, depth) {
  let names;
  try { names = Object.getOwnPropertyNames(obj); } catch { return; }
  for (const name of names) {
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    let v;
    try {
      const d = Object.getOwnPropertyDescriptor(obj, name);
      if (!d || !("value" in d)) continue;
      v = d.value;
    } catch { continue; }
    const e = base + "." + name;
    if (typeof v === "function") {
      let proto;
      try { proto = v.prototype; } catch {}
      if (proto && typeof proto === "object") add(e + ".prototype", proto);
      if (depth > 0) scan(e, v, depth - 1);
    } else if (v && typeof v === "object") {
      add(e, v);
      if (depth > 0) scan(e, v, depth - 1);
    }
  }
}
scan("globalThis", globalThis, 1);
for (const e of [
  "Object.getPrototypeOf([][Symbol.iterator]())",
  "Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()))",
  "Object.getPrototypeOf(new Map().entries())",
  "Object.getPrototypeOf(new Set().values())",
  "Object.getPrototypeOf(''[Symbol.iterator]())",
  "Object.getPrototypeOf(/a/g[Symbol.matchAll](''))",
  "Object.getPrototypeOf(Uint8Array).prototype",
  "Object.getPrototypeOf(function*(){}).prototype",
  "Object.getPrototypeOf(Object.getPrototypeOf(function*(){}).prototype)",
  "Object.getPrototypeOf(async function*(){}).prototype",
  "Object.getPrototypeOf(Object.getPrototypeOf(async function*(){}).prototype)",
  "Object.getPrototypeOf(async function(){})",
  "Object.getPrototypeOf(function*(){})",
  "(function(){ return arguments; })()",
  "Function.prototype",
]) add(e, eval(e));
const SKIP = new Set(${JSON.stringify(["repl", "sys", "wasi", "trace_events", "inspector/promises", "test/reporters"])});
for (const m of ${JSON.stringify(builtinModules)}) {
  if (m.startsWith("_") || SKIP.has(m)) continue;
  let mod;
  try { mod = require(m); } catch { continue; }
  const e = "require(" + JSON.stringify(m) + ")";
  add(e, mod);
  if (typeof mod === "function" && mod.prototype) add(e + ".prototype", mod.prototype);
  scan(e, mod, 1);
}
process.stdout.write([...exprs].join("\n"));
`;

// A constructed stream's receiver, each of its chain's members replaced in
// turn by a marker that calls the original (task BL-109's stream pass).
const STREAM = String.raw`
const { Readable } = require("stream");
const names = new Set(["_read", "_destroy", "_construct"]);
for (let p = Readable.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p))
  for (const k of Object.getOwnPropertyNames(p)) if (k !== "constructor") names.add(k);
(async () => {
  const hits = [];
  for (const k of names) {
    let hit = false;
    const s = { __proto__: new Readable({ read() { this.push("a"); this.push(null); } }) };
    const original = Object.getPrototypeOf(s)[k];
    s[k] = function (...a) {
      hit = true;
      try { return typeof original === "function" ? original.apply(this, a) : undefined; } catch { return undefined; }
    };
    try {
      await Promise.race([(async () => { for await (const c of s) break; })(), new Promise((r) => setTimeout(r, 100))]);
    } catch {}
    if (hit && !${JSON.stringify(PROTOCOL)}.includes(k)) hits.push(k);
  }
  process.stdout.write(JSON.stringify(hits));
  process.exit(0);
})();
`;

async function node(script, ...argv) {
  const { stdout } = await execFileAsync(
    process.execPath,
    ["-e", script, ...argv],
    { encoding: "utf-8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
}

const candidates = (await node(ENUMERATE)).split("\n").filter(Boolean);
if (list) {
  console.log(candidates.join("\n"));
  process.exit(0);
}

/** name -> trigger -> candidates */
const confirmed = new Map();
const failed = [];
let next = 0;
async function worker() {
  while (next < candidates.length) {
    const candidate = candidates[next++];
    let result;
    try {
      result = JSON.parse(await node(CHILD, candidate));
    } catch (error) {
      failed.push(`${candidate}: ${String(error.message).split("\n")[0]}`);
      continue;
    }
    for (const [trigger, names] of Object.entries(result)) {
      for (const name of names) {
        const byTrigger = confirmed.get(name) ?? new Map();
        confirmed.set(name, byTrigger);
        const at = byTrigger.get(trigger) ?? [];
        byTrigger.set(trigger, at);
        at.push(candidate);
      }
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

console.log(
  `Node ${process.version}: ${candidates.length} candidates, ${failed.length} probes failed.`,
);
for (const [name, byTrigger] of [...confirmed].sort()) {
  const prototypes = new Set([...byTrigger.values()].flat());
  console.log(
    `\n${name}: ${prototypes.size} candidate(s), ${byTrigger.size} trigger(s)`,
  );
  console.log(`  triggers: ${[...byTrigger.keys()].join(", ")}`);
  console.log(`  e.g.: ${[...prototypes].slice(0, 6).join(", ")}`);
}
for (const line of failed) {
  console.log(`failed: ${line}`);
}
if (stream) {
  console.log(
    `\nfor await over { __proto__: new Readable(…) }: ${await node(STREAM)}`,
  );
}
