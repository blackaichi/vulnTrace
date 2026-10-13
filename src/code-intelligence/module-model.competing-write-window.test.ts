import { describe, expect, it } from "vitest";
import {
  buildModuleModel,
  calleeCompletionEvaluationCount,
  mapExportsToFunctions,
} from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * BL-064 (RWF-094; ADR 0009 § 1 clause 4, as amended): the LAST write of
 * an export keeps its authority only when every evaluation between the
 * first competing write and its own completion is proven to complete
 * normally, or nothing can observe the module's export objects at all.
 *
 * Real-Node ground truth for the verdict-level shapes is in
 * `tests/oracle/rwf094-may-throw-statement.test.ts`; this file pins the
 * relation's parts one at a time: the observability census, the competing
 * writes, and the completion grammar.
 */

function exportName(text: string, name = "run"): string | undefined {
  const index = indexSourceFile("/pkg/index.js", text);
  return mapExportsToFunctions(index, buildModuleModel(index)).get(name)?.name;
}

function defaultName(text: string): string | undefined {
  return exportName(text, "default");
}

/** Declarations every case shares: two callables and an observer. */
const HEAD =
  'const lib = require("lib");\nfunction dangerous() { return lib.parse(); }\nfunction safe() { return lib.safe(); }\n';

/** `exports.run` written twice, with `between` between. */
function twice(between: string, head = HEAD): string {
  return `${head}exports.run = dangerous;\n${between}exports.run = safe;\n`;
}

function expectWithdrawn(text: string, name = "run"): void {
  expect(exportName(text, name)).toBeUndefined();
}

function expectKept(text: string, name = "run", value = "safe"): void {
  expect(exportName(text, name)).toBe(value);
}

describe("BL-064: the window between competing writes", () => {
  it("withdraws the last write across a call no proof reaches", () => {
    expectWithdrawn(twice("JSON.parse(input);\n"));
  });

  it("keeps it when nothing lies between the writes", () => {
    expectKept(twice(""));
  });

  it("keeps it when every statement between completes", () => {
    expectKept(
      twice(
        'function helper() {}\nconst k = 1;\nlet m;\nvar n = "x";\nexports.other = safe;\n',
      ),
    );
  });

  it("withdraws it when the last write's own value may throw", () => {
    expectWithdrawn(
      `${HEAD}exports.run = dangerous;\nexports.run = require("./safe").run;\n`,
    );
  });

  it("withdraws it when the last write's own chain writes a target that may throw", () => {
    // `lib.cache = safe` runs before `exports.run` is written: a setter,
    // a frozen object. Without the window this is attributed to `safe`.
    expectWithdrawn(
      `${HEAD}exports.run = dangerous;\nexports.run = lib.cache = safe;\n`,
    );
    expectKept(`${HEAD}exports.run = lib.cache = safe;\n`);
  });

  it("withdraws it when the first write's statement continues past the write", () => {
    expectWithdrawn(
      `${HEAD}if (lib) { exports.run = dangerous; JSON.parse(input); }\nexports.run = safe;\n`,
    );
  });

  it("withdraws it for a competing write in the same statement outside the chain", () => {
    expectWithdrawn(
      `${HEAD}exports.run = (exports.run = dangerous, JSON.parse(input), safe);\n`,
    );
  });

  it("keeps a chained write whose links are the same statement", () => {
    expect(
      exportName(`${HEAD}exports.parse = exports.run = safe;\n`, "parse"),
    ).toBe("safe");
  });

  it("opens the window at the start of the file for a write inside a function body", () => {
    expectWithdrawn(
      `${HEAD}function set() { exports.run = dangerous; }\nset();\nexports.run = safe;\n`,
    );
  });
});

describe("BL-064: who can observe the export objects", () => {
  // No `require`: nothing can hold this module's objects after a throw.
  const QUIET =
    "function dangerous() {}\nfunction safe() {}\nexports.run = dangerous;\nJSON.parse(input);\nexports.run = safe;\n";

  it("keeps the last write when nothing in the file can hand the objects out", () => {
    expectKept(QUIET);
  });

  it.each([
    ["a `require` anywhere", 'function f() { require("x"); }\n'],
    ["a dynamic `import()`", 'function f() { return import("x"); }\n'],
    ["`eval`", "function f(s) { return eval(s); }\n"],
    ["the wrapper's `arguments`", "void arguments;\n"],
    ["module-scope `this`", "void this;\n"],
    ["an arrow's module-scope `this`", "const t = () => this;\n"],
    ["`exports` passed to a call", "Object.freeze(exports);\n"],
    ["a read of `exports`", "function f() { return exports.run; }\n"],
    ["a read of `module`", "const m = module;\n"],
    ["a read of `module.exports`", "const e = module.exports;\n"],
  ])("withdraws it once %s can hand them out", (_label, extra) => {
    expectWithdrawn(`${extra}${QUIET}`);
  });

  it("does not count a function's own `this` or `arguments`", () => {
    expectKept(
      `function f() { return [this, arguments]; }\nclass C { m() { return this; } }\n${QUIET}`,
    );
  });

  it("does not count a property merely named `exports` or `module`", () => {
    expectKept(
      `const o = { exports: 1, module: 2 };\nvoid o.exports;\n${QUIET}`,
    );
  });
});

describe("BL-064: which writes compete", () => {
  it("does not count a primitive first write (TypeScript's `exports.x = void 0`)", () => {
    expectKept(
      `${HEAD}exports.run = void 0;\nJSON.parse(input);\nexports.run = safe;\n`,
    );
  });

  it("counts a whole-module literal that spells the name", () => {
    // Asserted on the property write's own binding: the literal's
    // unpacked `run` is a second binding of the same name, PRM-30's
    // last-write defect, which E-1 owns.
    const index = indexSourceFile(
      "/pkg/index.js",
      `${HEAD}module.exports = { run: dangerous };\nJSON.parse(input);\nmodule.exports.run = safe;\n`,
    );
    const write = buildModuleModel(index).exports.find(
      (exp) => exp.exportedName === "run" && exp.location.line === 6,
    );
    expect(write?.exportAttributionWithdrawn).toBe(true);
    expect(write?.localName).toBeUndefined();
  });

  it("does not count a whole-module literal that cannot carry the name", () => {
    expectKept(
      `${HEAD}exports = module.exports = {};\nJSON.parse(input);\nmodule.exports.run = safe;\n`,
    );
  });

  it("counts a whole-module literal with a spread", () => {
    expectWithdrawn(
      `${HEAD}module.exports = { ...lib };\nJSON.parse(input);\nmodule.exports.run = safe;\n`,
    );
  });

  it("does not count a whole-module function that only carries its intrinsics and own writes", () => {
    expectKept(
      `${HEAD}function main() {}\nexports = module.exports = main;\nmain.other = safe;\nJSON.parse(input);\nexports.run = safe;\n`,
    );
  });

  it("counts a whole-module function whose own writes name the export", () => {
    expectWithdrawn(
      `${HEAD}function main() {}\nmain.run = dangerous;\nmodule.exports = main;\nJSON.parse(input);\nmodule.exports.run = safe;\n`,
    );
  });

  it("counts a whole-module function a method may write through `this`", () => {
    // `main.setup()` runs `setup` with `this === main`.
    expectWithdrawn(
      `${HEAD}function main() {}\nmain.setup = function () { this.run = dangerous; };\nmain.setup();\nmodule.exports = main;\nJSON.parse(input);\nmodule.exports.run = safe;\n`,
    );
    expectWithdrawn(
      `${HEAD}function main() {}\nfunction setup() { Object.assign(this, lib); }\nmodule.exports = main;\nJSON.parse(input);\nmodule.exports.run = safe;\n`,
    );
  });

  it("counts a whole-module function that escapes (any name can be set on it)", () => {
    expectWithdrawn(
      `${HEAD}function main() {}\nlib.register(main);\nmodule.exports = main;\nJSON.parse(input);\nmodule.exports.run = safe;\n`,
    );
  });

  it("counts every write for the whole-module value itself", () => {
    expect(
      defaultName(
        `${HEAD}exports.run = dangerous;\nJSON.parse(input);\nmodule.exports = safe;\n`,
      ),
    ).toBeUndefined();
    expect(
      defaultName(
        `${HEAD}module.exports = dangerous;\nmodule.exports = safe;\n`,
      ),
    ).toBe("safe");
  });
});

describe("BL-064: the completion grammar", () => {
  it.each([
    [
      "a `try` with a `catch`",
      "try { JSON.parse(input); } catch (e) { void e; }\n",
    ],
    [
      "a `try`/`catch`/`finally` of completing blocks",
      "try { JSON.parse(input); } catch {} finally { void 0; }\n",
    ],
    [
      "an `if` of completing branches",
      'if (typeof window === "undefined") { const z = 1; } else { void 0; }\n',
    ],
    ["`typeof` of an undeclared name", "void typeof window;\n"],
    ["a `let` read after its declaration", "let late = 1;\nvoid late;\n"],
    ["a call of a completing callee", "function ok(v) { return v; }\nok(1);\n"],
    [
      "a call two levels down",
      "function a1(v) { return v; }\nfunction a2(v) { return a1(v); }\nfunction a3(v) { return a2(v); }\na3(1);\n",
    ],
    [
      "an `async` callee that throws",
      "async function am() { throw new Error(); }\nvoid am();\n",
    ],
    [
      "a supplied default",
      "function dp(a, b = JSON.parse(input)) { return a; }\ndp(1, 2);\n",
    ],
    [
      "a tagged template of a completing tag",
      "function tag() { return 1; }\ntag`x`;\n",
    ],
    [
      "a class without heritage, its static field completing",
      "class C { static k = 1; m() { JSON.parse(input); } f = JSON.parse(input); }\n",
    ],
    [
      "an object literal with a getter",
      "const o = { get v() { return JSON.parse(input); }, k: [1, safe] };\n",
    ],
    ["`false && e`", "void (false && JSON.parse(input));\n"],
    [
      "a non-intrinsic member write on a module function",
      "function main() {}\nmain.extra = 1;\n",
    ],
  ])("proves %s completes", (_label, between) => {
    expectKept(twice(between));
  });

  it.each([
    [
      "a `try`/`finally` whose `try` may throw",
      "try { JSON.parse(input); } finally {}\n",
    ],
    [
      "a `catch` that rethrows",
      "try { JSON.parse(input); } catch (e) { throw e; }\n",
    ],
    [
      "a destructuring `catch` binding",
      "try { void 0; } catch ({ message }) { void message; }\n",
    ],
    ["a read in the temporal dead zone", "void late;\nlet late = 1;\n"],
    ["a read of an undeclared global", "void window;\n"],
    ["a property read", "void lib.safe;\n"],
    ["a construction", "new Map();\n"],
    ["an arithmetic operator (a `valueOf`)", "void (safe + 1);\n"],
    ["a template with a substitution (a `toString`)", "void `${safe}`;\n"],
    ["a spread", "void [...safe];\n"],
    ["a destructuring declaration", "const { k } = safe;\n"],
    ["a class with heritage", "class C extends Object {}\n"],
    ["a class with a computed key", "class C { [Symbol.iterator]() {} }\n"],
    ["a static block", "class C { static { void 0; } }\n"],
    ["a loop", "for (;;) { break; }\n"],
    [
      "a callee that throws on a path",
      "function maybe(f) { if (f) throw new Error(); return 1; }\nmaybe(input);\n",
    ],
    [
      "a recursive callee (a `RangeError`)",
      "function rec() { return rec(); }\nrec();\n",
    ],
    [
      "a call four levels down",
      "function a1(v) { return v; }\nfunction a2(v) { return a1(v); }\nfunction a3(v) { return a2(v); }\nfunction a4(v) { return a3(v); }\na4(1);\n",
    ],
    [
      "a callee reassigned anywhere",
      "function ok() {}\nfunction swap() { ok = JSON.parse; }\nok();\n",
    ],
    [
      "an omitted argument whose default may throw",
      "function dp(a, b = JSON.parse(input)) { return a; }\ndp(1);\n",
    ],
    [
      "a destructuring parameter",
      "function dd({ a }) { return a; }\ndd({});\n",
    ],
    [
      "a generator whose default may throw",
      "function* g(a = JSON.parse(input)) {}\ng();\n",
    ],
    [
      "an intrinsic member write on a function (`name` is read-only)",
      'function main() {}\nmain.name = "x";\n',
    ],
    [
      "a member write on an escaping function",
      "function main() {}\nObject.freeze(main);\nmain.extra = 1;\n",
    ],
  ])("does not prove %s completes", (_label, between) => {
    expectWithdrawn(twice(between));
  });
});

describe("BL-064's independent audit: the shapes it broke", () => {
  it("(1) a withdrawn whole-module write withdraws the stale property writes it may replace", () => {
    // Real Node: `module.exports = { run: dangerous }` is published on
    // every load; the earlier `exports.run = safe` is on the old object.
    expect(
      exportName(
        `${HEAD}exports.run = safe;\nJSON.parse(input);\nmodule.exports = { run: dangerous };\n`,
      ),
    ).toBeUndefined();
  });

  it("(2) checks the outer links of the opening chain", () => {
    expectWithdrawn(
      `"use strict";\n${HEAD}let holder;\nholder.y = exports.run = dangerous;\nexports.run = safe;\n`,
    );
  });

  it("(3) does not take an `async function*`'s parameters as completing", () => {
    expectWithdrawn(
      twice("async function* g(a = JSON.parse(input)) {}\ng();\n"),
    );
  });

  it("(4) refuses a function declaration in a block (Annex B rebinds the name)", () => {
    expectWithdrawn(
      twice(
        "{ function helper() { throw new Error(); } }\nhelper();\n",
        `${HEAD}function helper() {}\n`,
      ),
    );
    expectWithdrawn(
      `${HEAD}function helper() {}\n{ function helper() { throw new Error(); } }\nexports.run = dangerous;\nhelper();\nexports.run = safe;\n`,
    );
    expectWithdrawn(
      twice(
        "function f() { { function h() { throw new Error(); } } h(); }\nf();\n",
      ),
    );
  });

  it("(5a) counts `this` in an `extends` clause or a computed key as the module's", () => {
    const quiet = "function dangerous() {}\nfunction safe() {}\n";
    expectWithdrawn(
      `${quiet}const leak = (o) => class {};\nclass A extends leak(this) {}\nexports.run = dangerous;\nJSON.parse(input);\nexports.run = safe;\n`,
    );
    expectWithdrawn(
      `${quiet}class B { [String(this)]() {} }\nexports.run = dangerous;\nJSON.parse(input);\nexports.run = safe;\n`,
    );
  });

  it("(5c) counts TypeScript's `import x = require()` as a load", () => {
    const index = indexSourceFile(
      "/pkg/index.ts",
      'import lib = require("vuln-lib");\nfunction dangerous() {}\nfunction safe() {}\nexports.run = dangerous;\nJSON.parse(input);\nexports.run = safe;\n',
    );
    expect(
      mapExportsToFunctions(index, buildModuleModel(index)).get("run")?.name,
    ).toBeUndefined();
  });

  it.each([
    [
      "`Object.seal(exports)` before the window",
      '"use strict";\nexports.run = void 0;\nObject.seal(exports);\nexports.run = dangerous;\nexports.other = 1;\nexports.run = safe;\n',
    ],
    [
      "a prototype setter before the window",
      'Object.defineProperty(Object.prototype, "other", { set() { throw new Error(); } });\nexports.run = dangerous;\nexports.other = 1;\nexports.run = safe;\n',
    ],
    [
      "`try { Object.freeze(exports) } catch {}` in the window",
      "exports.run = dangerous;\ntry { Object.freeze(exports); } catch {}\nexports.run = safe;\n",
    ],
    [
      "a method called on `exports` (`this === exports`)",
      "exports.run = dangerous;\ntry { exports.lock(); } catch {}\nexports.run = safe;\n",
    ],
  ])(
    "(6) withdraws when code may make a later write fail: %s",
    (_label, body) => {
      expectWithdrawn(`${HEAD}${body}`);
    },
  );

  it("(7) does not take a property-export alias of the function as contained", () => {
    expectWithdrawn(
      `${HEAD}function fn() {}\nexports.helper = fn;\nexports.helper.run = dangerous;\nmodule.exports = fn;\nJSON.parse(input);\nmodule.exports.run = safe;\n`,
    );
  });
});

describe("BL-064: the completion proof's cost is structural", () => {
  it("(8) evaluates each callee body once per calling statement, however wide its fan-out", () => {
    // `f` calls `g` K times and `g` calls `h` K times; N top-level calls
    // of `f` sit between two writes. Without the memo this is N * K^2
    // body evaluations (the audit measured 24.6 s at K=60, N=1000).
    const K = 30;
    const N = 300;
    const h = "function h(v) { return v; }\n";
    const g = `function g(v) { ${"h(v); ".repeat(K)}return v; }\n`;
    const f = `function f(v) { ${"g(v); ".repeat(K)}return v; }\n`;
    const calls = "f(1);\n".repeat(N);
    const before = calleeCompletionEvaluationCount();
    expectKept(twice(`${h}${g}${f}${calls}`));
    const evaluations = calleeCompletionEvaluationCount() - before;
    expect(evaluations).toBeLessThanOrEqual(3 * N);
  });
});

describe("BL-064: a write onto an export object this file does not shape", () => {
  it("does not prove a property write after a whole-module `require` completes", () => {
    // `./impl` may give `run` a setter, or make it read-only.
    expectWithdrawn(
      `${HEAD}module.exports = require("./impl");\nmodule.exports.run = safe;\n`,
    );
  });

  it("does not prove a property write onto a literal with an accessor completes", () => {
    expectWithdrawn(
      `${HEAD}module.exports = { set run(v) { throw new Error(); }, get run() { return dangerous; } };\nmodule.exports.run = safe;\n`,
    );
  });
});

describe("BL-064's second audit round", () => {
  it("(1) does not take a call of an `async` callee as running only proven code", () => {
    // `tamper()` completes (a promise), but its body runs synchronously
    // up to its first `await`; in sloppy mode the last write then fails.
    // Every statement before the last write is proven, so only the async
    // rule can taint the window; `load` makes the file observable.
    const proven =
      'function dangerous() {}\nfunction safe() {}\nfunction load() { return require("x"); }\n';
    expectWithdrawn(
      `${proven}async function tamper() { Object.freeze(module.exports); }\nexports.run = dangerous;\ntamper();\nexports.run = safe;\n`,
    );
    expectKept(
      `${proven}async function quiet() {}\nexports.run = dangerous;\nexports.run = safe;\n`,
    );
  });

  it("(2) counts `eval` as code that may make a later write fail", () => {
    expectWithdrawn(
      `"use strict";\n${HEAD}exports.run = void 0;\neval("0");\nexports.run = dangerous;\nexports.other = 1;\nexports.run = safe;\n`,
    );
  });

  it.each([
    [
      "`Function.prototype.run`",
      "function fn() {}\nFunction.prototype.run = dangerous;\nexports.run = safe;\nif (input) module.exports = fn;\n",
    ],
    [
      "`Object.prototype.run`",
      "Object.prototype.run = dangerous;\nexports.run = safe;\nif (input) module.exports = {};\n",
    ],
  ])(
    "(3) withdraws the stale property write when %s may be inherited",
    (_label, body) => {
      expectWithdrawn(`${HEAD}${body}`);
    },
  );
});
