import { NO_LOAD_REACHES_BACK } from "../testing/load-reach.js";
import { describe, expect, it } from "vitest";
import {
  buildModuleModel,
  exportAliasIdentifierIndexBuilds,
  exportAliasSummaryWalks,
  mapExportsToFunctions,
  type ExportBinding,
} from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * Task E-1 (ADR 0009 § 1, § 2, § 4; VT-INV-E-write-set): an export is
 * attributed to one declaration only when the file's complete write set
 * determines one effective write, and the declaration is found by lexical
 * identity, never by name.
 *
 * Real-Node ground truth for every shape is in
 * `tests/oracle/e1-export-write-set.test.ts`; this file pins the relation's
 * parts one at a time: lexical identity, the literal rule, lexical
 * computed-key constants, the final-object ordering, and each
 * `ExportWriteKind` of the census, with the un-enumerable default.
 */

/** Declarations every case shares: two callables. */
const HEAD =
  'const lib = require("lib");\nfunction dangerous() { return lib.parse(); }\nfunction safe() { return lib.safe(); }\n';

function attributed(
  text: string,
  name = "run",
  file = "/pkg/index.js",
): string | undefined {
  const index = indexSourceFile(file, text);
  return mapExportsToFunctions(
    index,
    buildModuleModel(index, NO_LOAD_REACHES_BACK),
  ).get(name)?.name;
}

function bindingsOf(text: string, file = "/pkg/index.js"): ExportBinding[] {
  const index = indexSourceFile(file, text);
  return [...buildModuleModel(index, NO_LOAD_REACHES_BACK).exports];
}

function expectWithdrawn(text: string, name = "run"): void {
  expect(attributed(text, name)).toBeUndefined();
  const bindings = bindingsOf(text).filter(
    (binding) => (binding.exportedName ?? "default") === name,
  );
  expect(bindings.length, "the export still exists").toBeGreaterThan(0);
  expect(
    bindings.every((binding) => binding.exportAttributionWithdrawn === true),
    "and is marked withdrawn",
  ).toBe(true);
}

describe("E-1: lexical identity (PRM-26)", () => {
  it("binds the declaration the local denotes, not a class method of its name", () => {
    expect(
      attributed(
        `${HEAD}class A { run() { return lib.safe(); } }\nvoid A;\nfunction run() { return lib.parse(); }\nexports.run = run;\n`,
      ),
    ).toBe("run");
    const index = indexSourceFile(
      "/pkg/index.js",
      `${HEAD}class A { run() { return lib.safe(); } }\nvoid A;\nfunction run() { return lib.parse(); }\nexports.run = run;\n`,
    );
    const fn = mapExportsToFunctions(
      index,
      buildModuleModel(index, NO_LOAD_REACHES_BACK),
    ).get("run");
    expect(
      fn?.memberOf,
      "the module-scope function, not A#run",
    ).toBeUndefined();
  });

  it("binds the module-scope declaration, not a nested function of its name", () => {
    const text = `${HEAD}function outer() { function run() { return lib.safe(); } return run; }\nvoid outer;\nfunction run() { return lib.parse(); }\nmodule.exports = { run };\n`;
    const index = indexSourceFile("/pkg/index.js", text);
    const fn = mapExportsToFunctions(
      index,
      buildModuleModel(index, NO_LOAD_REACHES_BACK),
    ).get("run");
    expect(fn?.location.line).toBe(6);
  });

  it("attributes nothing to a name nothing in scope declares", () => {
    expect(
      attributed(
        `${HEAD}const o = {};\no.run = function () {};\nexports.run = run;\n`,
      ),
    ).toBeUndefined();
  });

  it("an ES module export is a live binding: its order is not asked", () => {
    expect(
      attributed(
        `export { run };\nconst run = function () {};\n`,
        "run",
        "/pkg/index.mjs",
      ),
    ).toBe("run");
  });
});

describe("E-1: an ES module's reassigned binding (PRM-62)", () => {
  it("withdraws an `export let` assigned at module scope", () => {
    const text = `export let run = function () {};\nrun = function other() {};\n`;
    expect(attributed(text, "run", "/pkg/index.mjs")).toBeUndefined();
    expect(
      bindingsOf(text, "/pkg/index.mjs").find((b) => b.exportedName === "run")
        ?.exportAttributionWithdrawn,
    ).toBe(true);
  });

  it("withdraws an `export let` assigned in an exported function", () => {
    expect(
      attributed(
        `export let run = function () {};\nexport function configure() { run = function other() {}; }\n`,
        "run",
        "/pkg/index.mjs",
      ),
    ).toBeUndefined();
  });

  it("keeps an `export let` never assigned again", () => {
    expect(
      attributed(`export let run = function () {};\n`, "run", "/pkg/index.mjs"),
    ).toBe("run");
  });
});

describe("E-1: the literal rule (PRM-27; ADR 0009 § 4)", () => {
  it("publishes the last plain definition, whatever its key form", () => {
    expect(
      attributed(`${HEAD}module.exports = { run: safe, "run": dangerous };\n`),
    ).toBe("dangerous");
    expect(
      attributed(`${HEAD}module.exports = { run: dangerous, "run": safe };\n`),
    ).toBe("safe");
    expect(
      attributed(`${HEAD}module.exports = { run: dangerous, run: safe };\n`),
    ).toBe("safe");
    expect(attributed(`${HEAD}module.exports = { 0: safe };\n`, "0")).toBe(
      "safe",
    );
  });

  it("withdraws a name with a getter or a setter among its definitions", () => {
    expectWithdrawn(
      `${HEAD}module.exports = { run: safe, get run() { return dangerous; } };\n`,
    );
    expectWithdrawn(
      `${HEAD}module.exports = { get run() { return dangerous; }, run: safe };\n`,
    );
    expectWithdrawn(`${HEAD}module.exports = { run: safe, set run(v) {} };\n`);
  });

  it("withdraws a name defined before a spread or a key nothing names", () => {
    expectWithdrawn(
      `${HEAD}const extra = { run: dangerous };\nmodule.exports = { run: safe, ...extra };\n`,
    );
    expectWithdrawn(
      `${HEAD}module.exports = { run: safe, [["r", "un"].join("")]: dangerous };\n`,
    );
  });

  it("withdraws every name of a literal with a spread anywhere (ADR 0009 § 4)", () => {
    // Real Node publishes `safe` here; keeping it is a precision the ADR's
    // text does not grant (an amendment for the project owner).
    expectWithdrawn(
      `${HEAD}const extra = { run: dangerous };\nmodule.exports = { ...extra, run: safe };\n`,
    );
  });

  it("publishes no export named `__proto__`", () => {
    expect(
      bindingsOf(
        `${HEAD}module.exports = { __proto__: lib, run: safe };\n`,
      ).map((b) => b.exportedName),
    ).toEqual(["run"]);
  });

  it("binds a method by position, never its name", () => {
    expect(
      attributed(
        `function run() { return 1; }\nexports = module.exports = { run() { return 2; } };\n`,
      ),
    ).not.toBe("run");
  });
});

describe("E-1: lexical computed-key constants (PRM-28)", () => {
  it("resolves the constant the key binds to, not the first one so spelled", () => {
    expect(
      attributed(
        `${HEAD}function f() { const K = "other"; return K; }\nvoid f;\nconst K = "run";\nmodule.exports = { run: safe, [K]: dangerous };\n`,
      ),
    ).toBe("dangerous");
    expect(
      attributed(
        `${HEAD}{ const K = "other"; void K; }\nconst K = "run";\nmodule.exports = { run: safe, [K]: dangerous };\n`,
      ),
    ).toBe("dangerous");
  });

  it("keeps a module-scope constant key (ADV2-028)", () => {
    expect(
      attributed(
        `${HEAD}const K = "run";\nmodule.exports = { [K]: dangerous };\n`,
      ),
    ).toBe("dangerous");
  });

  it("treats a `let` key and a `const` declared after the key as dynamic", () => {
    expectWithdrawn(
      `${HEAD}let K = "run";\nmodule.exports = { run: safe, [K]: dangerous };\n`,
    );
    expectWithdrawn(
      `${HEAD}function later() { return { run: safe, [K]: dangerous }; }\nmodule.exports = { run: safe, [K]: dangerous };\nconst K = "run";\nvoid later;\n`,
    );
  });

  it("names a numeric key by the property it denotes", () => {
    // TypeScript reads `1e3` as the property name "1000".
    expect(
      attributed(`${HEAD}module.exports = { run: safe, [1e3]: dangerous };\n`),
    ).toBe("safe");
    expect(
      attributed(
        `${HEAD}module.exports = { run: safe, [1e3]: dangerous };\n`,
        "1000",
      ),
    ).toBe("dangerous");
  });
});

describe("E-1: the final export object (PRM-30)", () => {
  it("a member write on the final object after the literal is the effective write", () => {
    expect(
      attributed(
        `${HEAD}module.exports = { run: safe };\nmodule.exports.run = dangerous;\n`,
      ),
    ).toBe("dangerous");
    expect(
      attributed(
        `${HEAD}module.exports = { run: dangerous };\nmodule.exports.run = safe;\n`,
      ),
    ).toBe("safe");
  });

  it("`exports = module.exports = …` points `exports` at the final object", () => {
    expect(
      attributed(
        `${HEAD}exports = module.exports = { run: safe };\nexports.run = dangerous;\n`,
      ),
    ).toBe("dangerous");
  });

  it("a write to the replaced (stale) object is no write of the export", () => {
    expect(
      attributed(
        `${HEAD}exports.run = dangerous;\nmodule.exports = { run: safe };\n`,
      ),
    ).toBe("safe");
    expect(
      attributed(
        `${HEAD}module.exports = { run: safe };\nexports.run = dangerous;\n`,
      ),
    ).toBe("safe");
    expect(
      bindingsOf(
        `${HEAD}function main() {}\nexports.run = dangerous;\nmodule.exports = main;\n`,
      ).some((b) => b.exportedName === "run"),
      "a stale write publishes no binding at all",
    ).toBe(false);
  });

  it("a whole-module function keeps the properties written on it", () => {
    expect(
      attributed(
        `${HEAD}module.exports = function main() {};\nmodule.exports.run = safe;\n`,
      ),
    ).toBe("safe");
  });

  it("withdraws a write whose object the walk cannot place", () => {
    expectWithdrawn(
      `${HEAD}if (lib.flag) { exports = {}; }\nexports.run = safe;\n`,
    );
  });

  it("collapses each name to one binding", () => {
    const run = bindingsOf(
      `${HEAD}exports.run = dangerous;\nexports.run = safe;\n`,
    ).filter((b) => b.exportedName === "run");
    expect(run).toHaveLength(1);
  });
});

describe("E-1: the census (PRM-29, PRM-63; ADR 0009 § 2)", () => {
  // property-write: enumerated and ordered.
  it("orders the bracket spellings with the dotted ones", () => {
    expect(
      attributed(`${HEAD}exports.run = safe;\nexports["run"] = dangerous;\n`),
    ).toBe("dangerous");
    expect(
      attributed(
        `${HEAD}exports.run = safe;\nmodule.exports["run"] = dangerous;\n`,
      ),
    ).toBe("dangerous");
  });

  it("module-scope `this.x =` writes the original object: a later write the binding does not carry withdraws", () => {
    expectWithdrawn(`${HEAD}exports.run = safe;\nthis.run = dangerous;\n`);
  });

  // property-other-write.
  it.each([
    ["a logical assignment", "exports.run &&= dangerous;\n"],
    ["a compound assignment", "exports.run += 1;\n"],
    ["a destructuring target", "[exports.run] = [dangerous];\n"],
    [
      "an object destructuring target",
      "({ x: exports.run } = { x: dangerous });\n",
    ],
    ["a for-of head", "for (exports.run of [dangerous]) {}\n"],
    ["a delete", "delete exports.run;\n"],
  ])("withdraws the name on %s", (_label, write) => {
    expectWithdrawn(`${HEAD}exports.run = safe;\n${write}`);
  });

  // method-this-write.
  it("withdraws the name on a `this` write in a function called as a method", () => {
    expectWithdrawn(
      `${HEAD}exports.run = safe;\nexports.configure = function () { this.run = dangerous; };\n`,
    );
    expectWithdrawn(
      `${HEAD}module.exports = { run: safe, configure() { this.run = dangerous; } };\n`,
    );
  });

  it("a class constructor's and a field's `this` is a fresh instance", () => {
    expect(
      attributed(
        `${HEAD}class C { x = (this.run = 1); constructor() { this.run = dangerous; } }\nexports.C = C;\nexports.run = safe;\n`,
      ),
    ).toBe("safe");
  });

  // define-property.
  it("withdraws a name `Object.defineProperty` or `Object.assign` sets, and only that name", () => {
    const text = `${HEAD}Object.defineProperty(exports, "__esModule", { value: true });\nexports.run = safe;\nObject.assign(exports, { other: dangerous });\n`;
    expect(attributed(text)).toBe("safe");
    // `other` is written only by `Object.assign`: it has no binding at
    // all, hence an unresolved target.
    expect(attributed(text, "other")).toBeUndefined();
    expectWithdrawn(
      `${HEAD}exports.other = safe;\nObject.assign(exports, { other: dangerous });\n`,
      "other",
    );
    expectWithdrawn(
      `${HEAD}exports.run = safe;\nObject.defineProperty(exports, "run", { value: dangerous });\n`,
    );
  });

  // require-result-member-write.
  it("withdraws a name written on a `require(…)` result (a self-require)", () => {
    expectWithdrawn(
      `${HEAD}exports.run = safe;\nrequire("./index").run = dangerous;\n`,
    );
    expectWithdrawn(
      `${HEAD}exports.run = safe;\nconst self = require("./index");\nself.run = dangerous;\n`,
    );
  });

  // read.
  it.each([
    ["a member read", "void exports.other;\n"],
    [
      "a call of the file's own function",
      "exports.other = safe;\nexports.other();\n",
    ],
    ["typeof", 'void (typeof exports === "object");\n'],
    ["module.id", "void module.id;\n"],
    ["require.main === module", "void (require.main === module);\n"],
    [
      "a parameter named exports handed on",
      "function h(exports) { patch(exports); }\nfunction patch() {}\nvoid h;\n",
    ],
  ])("keeps attribution across %s", (_label, use) => {
    expect(attributed(`${HEAD}exports.run = safe;\n${use}`)).toBe("safe");
  });

  // unenumerable: the default.
  it.each([
    ["an alias of exports", "const e = exports;\ne.run = dangerous;\n"],
    [
      "an alias of module.exports",
      "const api = module.exports;\napi.run = dangerous;\n",
    ],
    [
      "an alias of module",
      "const m = module;\nm.exports = { run: dangerous };\n",
    ],
    ['module["exports"]', 'module["exports"].run = dangerous;\n'],
    [
      "exports handed to a call",
      "function patch(t) { t.run = dangerous; }\npatch(exports);\n",
    ],
    [
      "module-scope this handed to a call",
      "(function (t) { t.run = dangerous; })(this);\n",
    ],
    ["Object.freeze", "Object.freeze(exports);\n"],
    ["a write through a key nothing names", "exports[lib.key] = dangerous;\n"],
    ["the wrapper's arguments", "arguments[0].run = dangerous;\n"],
    ["eval", 'eval("exports.run = dangerous");\n'],
    ["require.cache", "void require.cache;\n"],
    ["module.children", "const kids = module.children;\nvoid kids;\n"],
    [
      "a with statement reaching exports",
      "with (lib) { exports.run = dangerous; }\n",
    ],
    [
      "a deferred rebinding of exports",
      "function f() { exports = {}; }\nvoid f;\n",
    ],
    [
      "a method's this handed on",
      "exports.init = function () { lib.patch(this); };\n",
    ],
  ])("withdraws every name on %s", (_label, use) => {
    expectWithdrawn(`${HEAD}exports.run = safe;\n${use}`);
  });

  it("withdraws the whole-module export too when un-enumerable", () => {
    expectWithdrawn(
      `${HEAD}module.exports = safe;\nconst m = module;\nm.exports = dangerous;\n`,
      "default",
    );
  });
});

describe("E-1: what the census does not count (precision, each sound)", () => {
  it.each([
    [
      "TypeScript's helper test",
      "var __h = (this && this.__h) || function (m) { return m; };\nvoid __h;\n",
    ],
    ["a condition", "if (exports) { void 0; }\n"],
    ["an instanceof", "function F() { return this instanceof F; }\nvoid F;\n"],
    ["a key `in` it", 'void ("run" in exports);\n'],
    [
      "a symbol-keyed write",
      'Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n',
    ],
    [
      "a destructuring property named module",
      "const { module: m2 } = lib;\nvoid m2;\n",
    ],
    ["a with body that names no export object", "with (lib) { void 0; }\n"],
    [
      "an instance method handing `this` on",
      "class C { m() { return lib.patch(this); } }\nexports.C = C;\n",
    ],
    [
      "a plain helper handing `this` on, never an export's method",
      "function helper() { return lib.patch(this); }\nvoid helper;\n",
    ],
    [
      "a dynamic-key `this` write in an instance method",
      "class C { m(k) { this[k] = 1; } }\nexports.C = C;\n",
    ],
  ])("keeps attribution across %s", (_label, use) => {
    expect(attributed(`${HEAD}exports.run = safe;\n${use}`)).toBe("safe");
  });

  it.each([
    [
      "lodash's environment probe",
      "var freeExports = typeof exports == 'object' && exports && !exports.nodeType && exports;\n" +
        "var freeModule = freeExports && typeof module == 'object' && module && !module.nodeType && module;\n" +
        "var moduleExports = freeModule && freeModule.exports === freeExports;\n" +
        "var types = freeModule && freeModule.require && freeModule.require('util').types;\nvoid moduleExports; void types;\n",
    ],
    ["an indirect eval", 'void (0, eval)("1");\nconst e2 = eval;\nvoid e2;\n'],
  ])("keeps attribution across %s", (_label, use) => {
    expect(attributed(`${HEAD}exports.run = safe;\n${use}`)).toBe("safe");
  });

  it.each([
    [
      "a write through a local holding exports",
      "var freeExports = typeof exports == 'object' && exports;\nfreeExports.run = dangerous;\n",
    ],
    [
      "a write through a local holding module",
      "var freeModule = typeof module == 'object' && module;\nfreeModule.exports.run = dangerous;\n",
    ],
    [
      "a whole-module write through a local holding module",
      "var freeModule = typeof module == 'object' && module;\nfreeModule.exports = { run: dangerous };\n",
    ],
    ["a direct eval", 'eval("exports.run = dangerous");\n'],
  ])("withdraws on %s", (_label, use) => {
    expectWithdrawn(`${HEAD}exports.run = safe;\n${use}`);
  });

  it.each([
    [
      "a local bound to require, only called",
      "const r = require;\nr(lib.name);\n",
    ],
    ["require.main.require", "require.main.require(lib.name);\n"],
    ["module.constructor._load", "module.constructor._load(lib.name);\n"],
  ])("keeps attribution across a loader call: %s", (_label, use) => {
    expect(attributed(`${HEAD}exports.run = safe;\n${use}`)).toBe("safe");
  });

  it.each([
    [
      "a local bound to require",
      'const r = require;\nr("./index").run = dangerous;\n',
    ],
    [
      "require.main.require",
      'require.main.require("./index").run = dangerous;\n',
    ],
    [
      "module.constructor._load",
      'module.constructor._load("./index").run = dangerous;\n',
    ],
    [
      "a local bound to require, handed on",
      "const r = require;\nlib.use(r);\n",
    ],
    [
      "require.main read as a value",
      "const main = require.main;\nvoid main;\n",
    ],
  ])("withdraws on a self-load write or loader escape: %s", (_label, use) => {
    expectWithdrawn(`${HEAD}exports.run = safe;\n${use}`);
  });

  it("a method this file never writes is another module's (E-4): calling it is a read", () => {
    expect(
      attributed(`${HEAD}exports.run = safe;\nexports.useColors();\n`),
    ).toBe("safe");
    // debug@2's `node.js`: the whole-module value is another module's
    // object, and its methods that module's. The re-export origin stands.
    const whole = bindingsOf(
      `${HEAD}exports = module.exports = require("./debug");\nexports.humanize(1);\n`,
    ).find((binding) => binding.kind === "default");
    expect(whole?.exportAttributionWithdrawn).toBeUndefined();
    expect(whole?.commonJsReExport?.specifier).toBe("./debug");
  });

  it("a method this file writes with a value it does not prove is its own function withdraws", () => {
    expectWithdrawn(
      `${HEAD}exports.run = safe;\nexports.m = lib.m;\nexports.m();\n`,
    );
  });

  it("keeps attribution across a call of the file's own literal method", () => {
    expect(
      attributed(
        `${HEAD}module.exports = { run: safe, other() { return 1; } };\nmodule.exports.other();\n`,
      ),
    ).toBe("safe");
  });

  it("counts a `this` handed on from a function that is an export's method", () => {
    expectWithdrawn(
      `${HEAD}exports.run = safe;\nexports.init = function () { lib.patch(this); };\n`,
    );
    expectWithdrawn(
      `${HEAD}module.exports = { run: safe, init() { lib.patch(this); } };\n`,
    );
    expectWithdrawn(
      `${HEAD}function init() { lib.patch(this); }\nexports.init = init;\nexports.run = safe;\n`,
    );
  });

  it("counts every function when an export's value is one it cannot follow", () => {
    expectWithdrawn(
      `${HEAD}function helper() { return lib.patch(this); }\nexports.made = lib.pick(helper2);\nfunction helper2() {}\nexports.other = lib.registry.current;\nexports.got = choose();\nfunction choose() { return lib.any; }\nexports.run = safe;\nvoid helper;\nexports.param = (function (p) { return p; })[0];\n`,
    );
  });

  it("follows a call of the file's own function to what it returns", () => {
    expect(
      attributed(
        `${HEAD}function helper() { return lib.patch(this); }\nvoid helper;\nconst E = ((E2) => { E2.a = 1; return E2; })(E || {});\nexports.E = E;\nexports.run = safe;\n`,
      ),
    ).toBe("safe");
    expectWithdrawn(
      `${HEAD}function helper() { return lib.patch(this); }\nfunction make() { return helper; }\nexports.made = make();\nexports.run = safe;\n`,
    );
  });

  it("counts a whole-module class's static members", () => {
    expectWithdrawn(
      `${HEAD}class C { static init() { lib.patch(this); } }\nmodule.exports = C;\nmodule.exports.run = safe;\n`,
    );
  });
});

describe("E-1: the whole-module binding is an alias of the final object", () => {
  it("withdraws a name written through it", () => {
    expectWithdrawn(
      `${HEAD}function main() {}\nmodule.exports = main;\nmodule.exports.run = safe;\nmain.run = dangerous;\n`,
    );
  });

  it("withdraws a name written through a named function or class expression's own name", () => {
    expectWithdrawn(
      `${HEAD}module.exports = function main() { main.run = dangerous; };\nmodule.exports.run = safe;\n`,
    );
    expectWithdrawn(
      `${HEAD}module.exports = class C { static init() { C.run = dangerous; } };\nmodule.exports.run = safe;\n`,
    );
  });

  it("counts a function written through it as one of the final object's methods", () => {
    expectWithdrawn(
      `${HEAD}function main() {}\nmodule.exports = main;\nmain.helper = function () { lib.patch(this); };\nmodule.exports.run = safe;\n`,
    );
  });

  it("follows a further alias, declared or assigned, to its writes", () => {
    expectWithdrawn(
      `${HEAD}function main() {}\nmodule.exports = main;\nmodule.exports.run = safe;\nconst again = main;\nagain.run = dangerous;\n`,
    );
    expectWithdrawn(
      `${HEAD}function main() {}\nmodule.exports = alias = main;\nmodule.exports.run = safe;\nalias.run = dangerous;\n`,
    );
  });

  it("withdraws every name when it is handed on", () => {
    expectWithdrawn(
      `${HEAD}function main() {}\nmodule.exports = main;\nmodule.exports.run = safe;\nlib.register(main);\n`,
    );
  });

  it("keeps attribution across reads, calls, and a write of itself into itself", () => {
    expect(
      attributed(
        `${HEAD}function main() {}\nmodule.exports = main;\nmodule.exports.run = safe;\nmain.default = main;\nvoid main.name;\nmain();\nvoid (typeof main);\n`,
      ),
    ).toBe("safe");
  });
});

describe("E-1: a named whole-module class expression", () => {
  it("is identified by its constructor, not by its name", () => {
    const index = indexSourceFile(
      "/pkg/index.js",
      "function Cursor() {}\nvoid Cursor;\nmodule.exports = class Cursor { constructor() {} };\n",
    );
    const fn = mapExportsToFunctions(
      index,
      buildModuleModel(index, NO_LOAD_REACHES_BACK),
    ).get("default");
    expect(fn?.kind).toBe("constructor");
    expect(fn?.location.line).toBe(3);
  });
});

describe("E-1's independent audit: each finding, at the model", () => {
  // Finding 1: a load that may load this file is an alias of its exports.
  it.each([
    [
      "assigned",
      'var self;\nself = require("./index.js");\nself.run = dangerous;\n',
    ],
    [
      "aliased twice",
      'var self = require("./index.js");\nvar alias = self;\nalias.run = dangerous;\n',
    ],
    [
      "returned",
      'function load() { return require("./index.js"); }\nload().run = dangerous;\n',
    ],
    [
      "in an object",
      'var o = { s: require("./index.js") };\no.s.run = dangerous;\n',
    ],
    ["through ||", '(require("./index.js") || 0).run = dangerous;\n'],
    [
      "through a conditional",
      'var s = lib.f ? require("./index") : require("./index.js");\ns.run = dangerous;\n',
    ],
    [
      "destructured",
      'var [self] = [require("./index.js")];\nself.run = dangerous;\n',
    ],
    ["by its directory", 'require(".").run = dangerous;\n'],
    ["by a dynamic specifier", "require(lib.name).run = dangerous;\n"],
    ["by the package's own name", 'require("pkg").run = dangerous;\n'],
    [
      "returned by a base constructor",
      'class Base { constructor() { return require("./index.js"); } }\nclass D extends Base { run = dangerous; }\nnew D();\n',
    ],
  ])("withdraws a self-load %s", (_label, use) => {
    expectWithdrawnIn(
      `${HEAD}exports.run = safe;\n${use}`,
      "/x/node_modules/pkg/index.js",
    );
  });

  it("keeps attribution across a load that cannot be this file", () => {
    expect(
      attributed(
        `${HEAD}const other = require("./other");\nother.extra = dangerous;\nlib.use(require("lib2"));\nexports.run = safe;\n`,
        "run",
        "/x/node_modules/pkg/index.js",
      ),
    ).toBe("safe");
  });

  // Finding 2: `module` members other than the inert ones reach modules.
  it.each([
    [
      "module.parent.children",
      "var c = module.parent.children;\nc[0].exports.run = dangerous;\n",
    ],
    [
      "module.parent.require",
      'module.parent.require("pkg").run = dangerous;\n',
    ],
    ["process.mainModule", "var m = process.mainModule;\nvoid m;\n"],
  ])("withdraws on %s", (_label, use) => {
    expectWithdrawn(`${HEAD}exports.run = safe;\n${use}`);
  });

  // Finding 3: coercions and instanceof run code with the object.
  it.each([
    ["a loose comparison with a value", "void (exports == 1);\n"],
    ["a template literal", "void `${exports}`;\n"],
    [
      "instanceof a class of this file",
      "class C { static [Symbol.hasInstance](o) { o.run = dangerous; return true; } }\nvoid (exports instanceof C);\n",
    ],
    // BL-075 (RWF-104): any module may define a builtin's
    // `Symbol.hasInstance`.
    ["instanceof a builtin", "void (exports instanceof Object);\n"],
    // BL-075's audit (RWF-112): on the right, the object's own
    // `Symbol.hasInstance` is inherited from `Object.prototype`, which any
    // module may write.
    [
      "the object on the right of instanceof",
      "void (({}) instanceof exports);\n",
    ],
    [
      "module-scope `this` on the right of instanceof",
      "void (({}) instanceof this);\n",
    ],
    [
      "the object on the right of instanceof in a function",
      "function check(x) { return x instanceof exports; }\ncheck({});\n",
    ],
  ])("withdraws on %s", (_label, use) => {
    expectWithdrawn(`${HEAD}exports.run = safe;\n${use}`);
  });

  it.each([
    ["a loose comparison with null", "void (exports == null);\n"],
    ["a loose comparison with undefined", "void (exports != undefined);\n"],
  ])("keeps attribution across %s", (_label, use) => {
    expect(attributed(`${HEAD}exports.run = safe;\n${use}`)).toBe("safe");
  });

  // Finding 4: what every object inherits, and the loader.
  it.each([
    [
      "Object.prototype written through",
      "Object.prototype.m = function () { lib.patch(this); };\n",
    ],
    [
      "an accessor defined on Object.prototype",
      'Object.defineProperty(Object.prototype, "run", { get() { return dangerous; } });\n',
    ],
    ["exports.__proto__ written", "exports.__proto__ = { m: dangerous };\n"],
    [
      'exports["__proto__"] written',
      'exports["__proto__"] = { m: dangerous };\n',
    ],
    [
      "__defineGetter__",
      'exports.__defineGetter__("run", function () { return dangerous; });\n',
    ],
    [
      "Object.setPrototypeOf on exports",
      "Object.setPrototypeOf(exports, null);\n",
    ],
    [
      "a __proto__ write through an alias",
      "const e = exports;\ne.__proto__ = { m: dangerous };\n",
    ],
    [
      "the module builtin",
      'require("module")._load(__filename).run = dangerous;\n',
    ],
  ])("withdraws on %s", (_label, use) => {
    expectWithdrawn(`${HEAD}exports.run = safe;\n${use}`);
  });

  it("keeps attribution across a read of a builtin prototype", () => {
    expect(
      attributed(
        `${HEAD}exports.run = safe;\nvoid Object.prototype.hasOwnProperty.call(lib, "x");\n` +
          'var has = Object.prototype.hasOwnProperty;\nvoid has.call(Object.prototype, "x");\n' +
          'void Object.getOwnPropertyDescriptor(Map.prototype, "size");\n',
      ),
    ).toBe("safe");
  });

  it("keeps attribution across a prototype change of a local object", () => {
    expect(
      attributed(
        `${HEAD}const table = {};\nObject.setPrototypeOf(table, null);\nconst o = { __proto__: null };\ndelete o.__proto__;\nexports.run = safe;\n`,
      ),
    ).toBe("safe");
  });

  it.each([
    [
      "a class that extends another (an inherited static setter)",
      "class B { static set run(v) {} }\nclass C extends B {}\nmodule.exports = C;\nmodule.exports.run = safe;\n",
    ],
    [
      "a class with a static setter of the name",
      "class C { static set run(v) {} }\nmodule.exports = C;\nmodule.exports.run = safe;\n",
    ],
  ])("withdraws a write on %s", (_label, use) => {
    expect(attributed(`${HEAD}${use}`)).toBeUndefined();
  });

  it("keeps a write on a plain function", () => {
    // (A class value is withdrawn on the base already, by BL-064's window.)
    expect(
      attributed(
        `${HEAD}function C() {}\nmodule.exports = C;\nmodule.exports.run = safe;\n`,
      ),
    ).toBe("safe");
  });

  it("withdraws on a builtin prototype handed to an unknown call", () => {
    expectWithdrawn(
      `${HEAD}exports.run = safe;\nlib.patch(Object.prototype);\n`,
    );
  });

  // The follow-up: a write on a final object this file did not make plainly.
  it.each([
    [
      "a call's result",
      "module.exports = lib.make();\nmodule.exports.run = safe;\n",
    ],
    [
      "another module's object",
      'module.exports = require("./frozen");\nmodule.exports.run = safe;\n',
    ],
    [
      "a literal with a setter",
      "module.exports = { set run(v) {} };\nmodule.exports.run = safe;\n",
    ],
    [
      "a function's own name",
      "module.exports = function main() {};\nmodule.exports.name = safe;\n",
    ],
  ])("withdraws a write on %s", (_label, use) => {
    const name = use.includes(".name =") ? "name" : "run";
    expect(attributed(`${HEAD}${use}`, name)).toBeUndefined();
  });

  // Finding 5: the alias censuses are linear in the file.
  it("builds one identifier index per file, however many aliases", () => {
    const aliases = Array.from(
      { length: 400 },
      (_, i) =>
        `var e${i} = typeof exports == "object" && exports;\nvoid e${i}.x;\n`,
    ).join("");
    const before = exportAliasIdentifierIndexBuilds();
    expect(attributed(`${HEAD}${aliases}exports.run = safe;\n`)).toBe("safe");
    expect(exportAliasIdentifierIndexBuilds() - before).toBe(1);
  });
});

describe("E-1's re-audit: each finding, at the model", () => {
  // F1: a member write through ANY load's result writes the name -- the
  // loaded module may hand this file's exports object back (a cycle, an
  // `imports` alias, a self-name). The pre-audit rule, restored and widened.
  it.each([
    ["a load's member", 'require("./other").run = dangerous;\n'],
    ["a member chain", 'require("./other").self.run = dangerous;\n'],
    ["a declared binding", 'const o = require("#self");\no.run = dangerous;\n'],
    [
      "an assigned binding",
      'var o;\no = require("wrap-real");\no.run = dangerous;\n',
    ],
    [
      "a destructured binding",
      'const { self } = require("./other");\nself.run = dangerous;\n',
    ],
    ["`require.call`", 'require.call(null, "./index").run = dangerous;\n'],
    ["`require.bind`", 'require.bind(null)("./index").run = dangerous;\n'],
  ])("withdraws a write through %s", (_label, use) => {
    expectWithdrawnIn(
      `${HEAD}exports.run = safe;\n${use}`,
      "/x/node_modules/pkg/index.js",
    );
  });

  it("keeps attribution across a load's write of another name", () => {
    expect(
      attributed(`${HEAD}require("lib").extra = 1;\nexports.run = safe;\n`),
    ).toBe("safe");
  });

  // F2: a reader the file replaces is no reader.
  it.each([
    [
      "`Object.keys`",
      "Object.keys = function (o) { return []; };\nObject.keys(exports);\n",
    ],
    [
      "`Reflect.get` through the global object",
      'globalThis.Reflect.get = function (o) { return o; };\nReflect.get(exports, "x");\n',
    ],
    [
      "a builtin prototype's reader",
      'Object.prototype.hasOwnProperty = function () { return true; };\nObject.prototype.hasOwnProperty.call(exports, "run");\n',
    ],
    [
      "`Object` handed to `defineProperty`",
      "Object.defineProperty(Object, Symbol.hasInstance, { value: function () { return true; } });\nif (exports instanceof Object) {}\n",
    ],
    [
      "an alias of `Object`",
      "const O = Object;\nO.keys = function () { return []; };\nObject.keys(exports);\n",
    ],
    [
      "any receiver's `hasOwnProperty`",
      'const evil = { hasOwnProperty() { return true; } };\nevil.hasOwnProperty.call(exports, "run");\n',
    ],
  ])("withdraws a read by %s", (_label, use) => {
    expect(attributed(`${HEAD}exports.run = safe;\n${use}`)).toBeUndefined();
  });

  it.each([
    ["a class extending a builtin", "class E extends Error {}\nvoid E;\n"],
    ["a builtin alias only constructed", 'const F = Function;\nnew F("");\n'],
    [
      "a builtin prototype alias only tested",
      'var hasMap = typeof Map === "function" && Map.prototype;\nif (hasMap) {}\n',
    ],
    [
      "a conditional builtin alias only constructed",
      "var U = Math.random() ? Uint8Array : Array;\nnew U(1);\n",
    ],
    [
      "a builtin's methods destructured",
      "const { keys, freeze } = Object;\nvoid keys;\nvoid freeze;\n",
    ],
    [
      "a unary read of a builtin member",
      "var m = -Number.MAX_VALUE;\nvar w = !globalThis.window;\n",
    ],
  ])(
    "keeps another name's `defineProperty` a define across %s",
    (_label, use) => {
      expect(
        attributed(
          `${HEAD}${use}exports.run = safe;\nObject.defineProperty(exports, "other", { value: 1 });\n`,
        ),
      ).toBe("safe");
    },
  );

  it.each([
    [
      "a builtin alias written",
      "var U = Math.random() ? Uint8Array : Array;\nU.from = null;\n",
    ],
    [
      "`prototype` destructured",
      "const { prototype } = Object;\nvoid prototype;\n",
    ],
    ["an increment of a builtin member", "Number.MAX_VALUE++;\n"],
  ])("withdraws another name's `defineProperty` across %s", (_label, use) => {
    expect(
      attributed(
        `${HEAD}${use}exports.run = safe;\nObject.defineProperty(exports, "other", { value: 1 });\n`,
      ),
    ).toBeUndefined();
  });

  // BL-075 (RWF-104): no builtin reader is trusted with an export object,
  // even one the file never replaces: builtins are shared by every module
  // of the process, and one reached without its name (`({}).constructor`)
  // or replaced by another module writes onto what it is handed.
  it.each([
    ["`Object.keys`", "Object.keys(exports);\n"],
    ["`Reflect.ownKeys`", "Reflect.ownKeys(exports);\n"],
    [
      "a builtin prototype's reader",
      'Object.prototype.hasOwnProperty.call(exports, "run");\n',
    ],
    [
      "an alias of a builtin prototype's reader",
      'var has = Object.prototype.hasOwnProperty;\nhas.call(exports, "run");\n',
    ],
    [
      "`Object.keys` reached through `({}).constructor` and replaced",
      "({}).constructor.keys = function (o) { o.run = dangerous; return []; };\nObject.keys(exports);\n",
    ],
    [
      "`Object.keys` reached through `exports.constructor` and replaced",
      "exports.constructor.keys = function (o) { o.run = dangerous; return []; };\nObject.keys(exports);\n",
    ],
  ])("withdraws attribution across %s", (_label, use) => {
    expect(attributed(`${HEAD}exports.run = safe;\n${use}`)).toBeUndefined();
  });

  // The final object's alias (`main`), in a file nothing can observe from
  // outside (no `require`): the alias census used to exempt a reader too.
  it.each([
    ["`Object.keys(main)`", "Object.keys(main);\n"],
    ["`main instanceof Object`", "void (main instanceof Object);\n"],
  ])(
    "withdraws attribution of the final object handed to a builtin by %s",
    (_label, use) => {
      const text = `function safe() {}\nfunction main() {}\nmodule.exports = main;\nmodule.exports.run = safe;\n`;
      expect(attributed(text)).toBe("safe");
      expect(attributed(`${text}${use}`)).toBeUndefined();
    },
  );

  // On the right of `instanceof`, a function or a base class this file
  // declares inherits `Function.prototype[Symbol.hasInstance]`, which is
  // non-writable and non-configurable: no other module can replace it.
  it.each([
    ["a function declaration", "function main() {}\n", "main"],
    ["a base class", "class Main {}\n", "Main"],
  ])(
    "keeps attribution of %s exported and on the right of instanceof",
    (_label, declaration, name) => {
      const text = `function safe() {}\n${declaration}module.exports = ${name};\nmodule.exports.run = safe;\n`;
      expect(attributed(text)).toBe("safe");
      expect(
        attributed(
          `${text}function check(x) { return x instanceof ${name}; }\ncheck({});\n`,
        ),
      ).toBe("safe");
    },
  );

  // A derived class, a reassigned binding and a class with a computed
  // member are withdrawn by the census before any `instanceof`; an async
  // function is not, and its `[[Prototype]]` (`AsyncFunction.prototype`)
  // is writable by any module.
  it("withdraws attribution of an async function exported and on the right of instanceof", () => {
    const text = `function safe() {}\nasync function main() {}\nmodule.exports = main;\nmodule.exports.run = safe;\n`;
    expect(attributed(text)).toBe("safe");
    expect(attributed(`${text}void (({}) instanceof main);\n`)).toBeUndefined();
  });

  it("keeps attribution across a builtin reader handed no export object", () => {
    expect(
      attributed(
        `${HEAD}exports.run = safe;\nObject.getOwnPropertyDescriptor(Map.prototype, "size");\nObject.keys({});\n`,
      ),
    ).toBe("safe");
  });

  // F3: `process` other than through an inert member reaches the loader.
  it.each([
    ["an alias", "const p = process;\nvar m = p.mainModule;\n"],
    ["the global object", "var m = globalThis.process.mainModule;\n"],
    [
      "a binding of the global object",
      'var root = typeof global == "object" && global;\nvar m = root.process.mainModule;\n',
    ],
    ["`getBuiltinModule`", 'process.getBuiltinModule("module");\n'],
    [
      "a destructured `mainModule`",
      "const { mainModule } = process;\nvoid mainModule;\n",
    ],
    [
      "the `process` builtin",
      'const p = require("node:process");\nvar m = p.mainModule;\n',
    ],
    ["a computed member", 'var k = "mainModule";\nvoid process[k];\n'],
    [
      "a computed member of the global object",
      'var k = "process";\nvoid globalThis[k];\n',
    ],
  ])("withdraws every name on `process` reached through %s", (_label, use) => {
    expect(attributed(`${HEAD}exports.run = safe;\n${use}`)).toBeUndefined();
  });

  it("keeps attribution across inert `process` uses (lodash's `freeProcess`)", () => {
    expect(
      attributed(
        `${HEAD}var freeGlobal = typeof global == "object" && global && global.Object === Object && global;\n` +
          `var freeProcess = freeGlobal.process;\n` +
          `var nodeUtil = (function () { try { return freeProcess && freeProcess.binding && freeProcess.binding("util"); } catch (e) {} })();\n` +
          `if (typeof process !== "undefined" && process.env.DEBUG) {}\n` +
          `process.nextTick(function () {});\n` +
          `const { env } = process;\nprocess.send?.("ready");\n` +
          `exports.run = safe;\n`,
      ),
    ).toBe("safe");
  });
});

describe("E-1's audit, round 3: each finding, at the model", () => {
  // F3: an `EventEmitter` method of `process` returns `process` itself.
  it.each([
    ["`on`", 'var m = process.on("x", function () {}).mainModule;\n'],
    [
      "`once` through a binding",
      'const p = process.once("x", function () {});\nvar m = p.mainModule;\n',
    ],
    [
      "the global object's `process`",
      'var m = global.process.removeAllListeners("x").mainModule;\n',
    ],
  ])("withdraws every name on a chained %s", (_label, use) => {
    expect(attributed(`${HEAD}exports.run = safe;\n${use}`)).toBeUndefined();
  });

  it("keeps attribution across a listener call whose result is discarded", () => {
    expect(
      attributed(
        `${HEAD}process.on("exit", function () {});\nexports.run = safe;\n`,
      ),
    ).toBe("safe");
  });

  // F4: the alias summaries are memoized and bounded.
  it("fails closed, without overflowing, on a very long alias chain of `process`", () => {
    const chain = Array.from(
      { length: 3000 },
      (_, i) => `var p${i + 1} = p${i};\n`,
    ).join("");
    expect(
      attributed(
        `${HEAD}var p0 = process;\n${chain}var e = p3000.env.X;\nexports.run = safe;\n`,
      ),
    ).toBeUndefined();
  });

  it("computes each binding's alias summary once, however many writes use it", () => {
    const writes = Array.from(
      { length: 2000 },
      (_, i) => `big.k${i} = ${i};\nbig[k${i % 7}] = ${i};\n`,
    ).join("");
    const before = exportAliasSummaryWalks();
    expect(
      attributed(
        `${HEAD}var k0 = "a", k1 = "b", k2 = "c", k3 = "d", k4 = "e", k5 = "f", k6 = "g";\n` +
          `var big = (function () { return {}; })();\n${writes}exports.run = safe;\n`,
      ),
    ).toBe("safe");
    // One summary per question per binding (`big`), not one per write.
    expect(exportAliasSummaryWalks() - before).toBeLessThanOrEqual(4);
  });
});

function expectWithdrawnIn(text: string, file: string, name = "run"): void {
  expect(attributed(text, name, file)).toBeUndefined();
  const bindings = bindingsOf(text, file).filter(
    (binding) => (binding.exportedName ?? "default") === name,
  );
  expect(bindings.length, "the export still exists").toBeGreaterThan(0);
  expect(
    bindings.every((binding) => binding.exportAttributionWithdrawn === true),
    "and is marked withdrawn",
  ).toBe(true);
}
