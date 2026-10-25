// BL-096 premise probe, round 2: further conversions and lookups.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRELUDE = `let __hit = false; const __P = module.paths;
function __seen() { for (let i = 0; i < arguments.length; i++) if (arguments[i] === __P) __hit = true; }\n`;
const T = {
  toString: `const __o = Array.prototype.toString; Array.prototype.toString = function () { __seen(this); return __o.call(this); };`,
  thenGetter: `Object.defineProperty(Object.prototype, "then", { configurable: true, get() { __seen(this); } });`,
  thenMethod: `Object.prototype.then = function (r) { __seen(this); delete Object.prototype.then; r(1); };`,
  hasInstanceGetter: `Object.defineProperty(Object.prototype, Symbol.hasInstance, { configurable: true, get() { __seen(this); } });`,
  toPrimitive: `Object.prototype[Symbol.toPrimitive] = function () { __seen(this); return "s"; };`,
};
const cases = [
  ["key.element", "toString", "({})[module.paths];"],
  ["key.computedName", "toString", "({ [module.paths]: 1 });"],
  ["key.classMember", "toString", "(class { [module.paths]() {} });"],
  ["await.getter", "thenGetter", "(async () => { await module.paths; })();"],
  ["await.method", "thenMethod", "(async () => { await module.paths; })();"],
  ["instanceofRight", "hasInstanceGetter", "try { ({}) instanceof module.paths; } catch {}"],
  ["looseEqNull", "toPrimitive", "module.paths == null;"],
  ["looseEqObject", "toPrimitive", "module.paths == {};"],
  ["switchCase", "toPrimitive", "switch (module.paths) { case 'x': break; }"],
  ["ifTest", "toPrimitive", "if (module.paths) {}"],
  ["nullish", "toPrimitive", "module.paths ?? 1;"],
];
const dir = mkdtempSync(join(tmpdir(), "bl096-probe2-"));
let i = 0;
console.log(`node ${process.version}`);
for (const [use, t, src] of cases) {
  const f = join(dir, `c${i++}.js`);
  writeFileSync(
    f,
    `${PRELUDE}${T[t]}\n${src}\nsetImmediate(() => process.stdout.write(__hit ? "HANDED" : "no"));\n`,
  );
  let out;
  try {
    out = execFileSync(process.execPath, [f], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    out = "ERROR " + String(e.stderr).split("\n").find((l) => /Error/.test(l));
  }
  console.log(out.padEnd(7), use.padEnd(18), t);
}
