// BL-096 premise probe: for each (tamper, use) pair, does real Node hand
// a CommonJS module's own `module.paths` array to user code?
// Each case is a fresh CommonJS file run in its own `node` process. The
// tamper installs functions that call `__seen(x)` on every value they
// receive (`this` and arguments); `__seen` records whether `x` is the
// module's own `module.paths` array, by identity.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRELUDE = `
let __hit = false;
const __P = module.paths;
function __seen() { for (let i = 0; i < arguments.length; i++) if (arguments[i] === __P) __hit = true; }
`;

// Each tamper: statements run before the use.
const T = {
  none: ``,
  replaceMethod: (m) => `
const __o = Array.prototype.${m};
Array.prototype.${m} = function (...a) { __seen(this, ...a); return __o.apply(this, a); };`,
  accessorMethod: (m) => `
const __o = Array.prototype.${m};
Object.defineProperty(Array.prototype, "${m}", { configurable: true, get() { __seen(this); return __o; } });`,
  replaceIterator: `
const __o = Array.prototype[Symbol.iterator];
Array.prototype[Symbol.iterator] = function () { __seen(this); return __o.call(this); };`,
  replaceArrayIteratorNext: `
const __ip = Object.getPrototypeOf([][Symbol.iterator]());
const __o = __ip.next;
__ip.next = function () { __seen(this); return __o.call(this); };`,
  arrayProtoToPrimitive: `
Array.prototype[Symbol.toPrimitive] = function (h) { __seen(this); return "s"; };`,
  objectProtoToPrimitive: `
Object.prototype[Symbol.toPrimitive] = function (h) { __seen(this); return "s"; };`,
  objectProtoValueOf: `
const __o = Object.prototype.valueOf;
Object.prototype.valueOf = function () { __seen(this); return __o.call(this); };`,
  arrayProtoIndexGetter: `
Object.defineProperty(Array.prototype, "77777", { configurable: true, get() { __seen(this); } });`,
  objectProtoIndexGetter: `
Object.defineProperty(Object.prototype, "77777", { configurable: true, get() { __seen(this); } });`,
  objectProtoNamedGetter: `
Object.defineProperty(Object.prototype, "foo", { configurable: true, get() { __seen(this); } });`,
  arrayProtoProxyParent: `
Object.setPrototypeOf(Array.prototype, new Proxy(Object.prototype, {
  get(t, k, r) { __seen(r); return Reflect.get(t, k, r); },
  has(t, k) { __seen(t); return Reflect.has(t, k); },
  ownKeys(t) { __seen(t); return Reflect.ownKeys(t); },
  getOwnPropertyDescriptor(t, k) { __seen(t); return Reflect.getOwnPropertyDescriptor(t, k); },
  getPrototypeOf(t) { __seen(t); return Reflect.getPrototypeOf(t); },
}));`,
  constructorGetter: `
Object.defineProperty(Array.prototype, "constructor", { configurable: true, get() { __seen(this); return Array; } });`,
  isConcatSpreadableGetter: `
Object.defineProperty(Object.prototype, Symbol.isConcatSpreadable, { configurable: true, get() { __seen(this); return undefined; } });`,
  speciesGetter: `
Object.defineProperty(Array, Symbol.species, { configurable: true, get() { __seen(this); return Array; } });`,
  hasInstanceClass: `
class __H { static [Symbol.hasInstance](v) { __seen(v); return false; } }`,
  toJSONOnObjectProto: `
Object.prototype.toJSON = function () { __seen(this); return 1; };`,
};

// Each use: one statement of the shape the classifier exempts today.
const READ_METHODS = [
  "at", "concat", "entries", "flat", "includes", "indexOf", "join", "keys",
  "lastIndexOf", "slice", "toReversed", "toSorted", "toSpliced", "toString",
  "values", "with",
];
const methodCall = (m) => {
  const table = { at: "0", with: "0, 'x'", toSpliced: "0, 0", includes: "'x'", indexOf: "'x'", lastIndexOf: "'x'", join: "':'" };
  const args = Object.hasOwn(table, m) ? table[m] : "";
  return `module.paths.${m}(${args});`;
};

const cases = [];
for (const m of READ_METHODS) {
  cases.push([`method.${m}`, "none", T.none, methodCall(m)]);
  cases.push([`method.${m}`, "replaceMethod", T.replaceMethod(m), methodCall(m)]);
  cases.push([`method.${m}`, "accessorMethod", T.accessorMethod(m), methodCall(m)]);
  for (const t of ["constructorGetter", "isConcatSpreadableGetter", "speciesGetter", "arrayProtoProxyParent", "objectProtoNamedGetter"]) {
    cases.push([`method.${m}`, t, T[t], methodCall(m)]);
  }
}
// toString's internal `join` lookup.
cases.push(["method.toString", "replaceMethod(join)", T.replaceMethod("join"), methodCall("toString")]);
// values()/keys()/entries() then iterate the result: next() sees only the iterator.
for (const m of ["values", "keys", "entries"]) {
  cases.push([`iterate.${m}()`, "replaceArrayIteratorNext", T.replaceArrayIteratorNext, `for (const _ of module.paths.${m}()) {}`]);
}

const ITER = [
  ["forOf", `for (const d of module.paths) {}`],
  ["forIn", `for (const i in module.paths) {}`],
];
for (const [n, u] of ITER) {
  for (const t of ["none", "replaceIterator", "replaceArrayIteratorNext", "arrayProtoProxyParent", "objectProtoNamedGetter", "arrayProtoIndexGetter"]) {
    cases.push([`iter.${n}`, t, T[t], u]);
  }
  cases.push([`iter.${n}`, "accessorMethod(Symbol.iterator)", `
const __o = Array.prototype[Symbol.iterator];
Object.defineProperty(Array.prototype, Symbol.iterator, { configurable: true, get() { __seen(this); return __o; } });`, u]);
}

const PRIM = [
  ["template", "`${module.paths}`;"],
  ["plusString", "module.paths + '';"],
  ["unaryPlus", "+module.paths;"],
  ["looseEqString", "module.paths == 'x';"],
  ["lessThan", "module.paths < 1;"],
  ["inLeft", "(module.paths in {});"],
  ["inRight", "('x' in module.paths);"],
  ["strictEq", "module.paths === 1;"],
  ["typeof", "typeof module.paths;"],
  ["not", "!module.paths;"],
  ["void", "void module.paths;"],
  ["compoundPlus", "let __s = ''; __s += module.paths;"],
  ["bitNot", "~module.paths;"],
];
for (const [n, u] of PRIM) {
  for (const t of ["none", "replaceMethod(join)", "replaceMethod(toString)", "arrayProtoToPrimitive", "objectProtoToPrimitive", "objectProtoValueOf", "arrayProtoProxyParent"]) {
    const tamper = t.startsWith("replaceMethod(") ? T.replaceMethod(t.slice(14, -1)) : T[t];
    cases.push([`prim.${n}`, t, tamper, u]);
  }
}
cases.push(["prim.instanceof", "none(plain class)", `class __F {}`, "module.paths instanceof __F;"]);
cases.push(["prim.instanceof", "hasInstanceClass (no builtin replaced)", T.hasInstanceClass, "module.paths instanceof __H;"]);

const READS = [
  ["length", "module.paths.length;"],
  ["ownIndex0", "module.paths[0];"],
  ["index77777", "module.paths[77777];"],
  ["named.foo", "module.paths.foo;"],
  ["methodValue.includes", "module.paths.includes;"],
  ["optional.length", "module.paths?.length;"],
];
for (const [n, u] of READS) {
  for (const t of ["none", "arrayProtoIndexGetter", "objectProtoIndexGetter", "objectProtoNamedGetter", "arrayProtoProxyParent", "accessorMethod(includes)"]) {
    const tamper = t === "accessorMethod(includes)" ? T.accessorMethod("includes") : T[t];
    cases.push([`read.${n}`, t, tamper, u]);
  }
}

const dir = mkdtempSync(join(tmpdir(), "bl096-probe-"));
const rows = [];
let i = 0;
for (const [use, tamper, tamperSrc, useSrc] of cases) {
  const file = join(dir, `c${i++}.js`);
  writeFileSync(file, `${PRELUDE}\n${tamperSrc}\n${useSrc}\nprocess.stdout.write(__hit ? "HANDED" : "no");\n`);
  let out;
  try {
    out = execFileSync(process.execPath, [file], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = `ERROR ${String(e.stderr).split("\n").find((l) => /Error/.test(l)) ?? ""}`;
  }
  rows.push({ use, tamper, out });
}
const json = process.argv.includes("--json");
if (json) {
  console.log(JSON.stringify({ node: process.version, rows }, null, 1));
} else {
  console.log(`node ${process.version}; ${rows.length} cases`);
  for (const r of rows) console.log(`${r.out.padEnd(7)} ${r.use.padEnd(26)} ${r.tamper}`);
}
