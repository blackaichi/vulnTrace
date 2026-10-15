import type { E1Case } from "./e1-export-write-set.cases.js";

/**
 * Task BL-084 (docs/tasks/BL-084-function-own-object.md; ADR 0009 § 1):
 * every route to a function's own object is a use of the export object it
 * is the value of, against real Node.
 *
 * THE MECHANISM. E-1's census of the final export object's binding
 * (`module.exports = Api`) visits only identifiers spelled `Api`. The
 * function's own object is also `arguments.callee` in its sloppy frame
 * (RWF-114), `new.target` when it is constructed and the `constructor` of
 * its `prototype` and of every instance (RWF-115), `X.caller` for a sloppy
 * function it calls (RWF-116), and a `super` property write in a method
 * writes onto `this` (RWF-117). A name written through any of them is
 * attributed to the file's own write.
 *
 * LOUD FIXTURE. E-1's (`e1-export-write-set.cases.ts`): `vuln-lib`
 * exports `parse` (the rule's target) and `safe`; `wrap/index.js` writes
 * `module.exports.run = safeOp`, and the route writes a `run` calling
 * `parse`. The `lazy.*` cases replace `wrap`'s entry with one that loads
 * `vuln-lib` inside its functions, so no statement before the export's
 * write is unproven and BL-064's taint withdraws nothing: what remains is
 * E-1's census alone.
 *
 * THE CONTROLS. E-1's: the negative control writes `exports.run = safeOp`
 * once (`NOT_AFFECTED`); the positive control adds a direct call of
 * `parse` in the entry (`AFFECTED`).
 *
 * `base` is the analyzer's verdict on BL-084's base `e7cb576` (BL-075's
 * merge), measured. A case with `base: "NOT_AFFECTED"` and `called: true`
 * is a live false `NOT_AFFECTED` BL-084 closes; `masked.*` were already
 * `UNKNOWN` (through BL-064's taint or the call graph's escape backstop);
 * `strict.*` ground the routes strict code does not have; `cost.*` is the
 * precision BL-084 gives up; `control.*` keeps its precision.
 */

/** The entry calls the export first. */
const CALL_APP = `const w = require("wrap");\nw();\nw.run("x");\n`;
/** The entry constructs the export first. */
const NEW_APP = `const w = require("wrap");\nnew w();\nw.run("x");\n`;
/** The entry calls a member of the export first. */
function memberApp(call: string): string {
  return `const w = require("wrap");\n${call};\nw.run("x");\n`;
}

/**
 * `wrap`'s entry swapped for `api.js`, which loads `vuln-lib` only inside
 * its functions: no top-level statement before the export's write is
 * unproven, so BL-064's competing-write taint does not apply.
 */
function lazy(body: string): Readonly<Record<string, string>> {
  return {
    "package.json": JSON.stringify({
      name: "wrap",
      version: "1.0.0",
      main: "api.js",
    }),
    "api.js":
      `function dangerousOp(x) { return require("vuln-lib").parse(x); }\n` +
      `function safeOp(x) { return require("vuln-lib").safe(x); }\n` +
      body,
  };
}

/** A strict `wrap` entry. */
function strict(body: string): Readonly<Record<string, string>> {
  return {
    "package.json": JSON.stringify({
      name: "wrap",
      version: "1.0.0",
      main: "strict.js",
    }),
    "strict.js":
      `"use strict";\n` +
      `const lib = require("vuln-lib");\n` +
      `function dangerousOp(x) { return lib.parse(x); }\n` +
      `function safeOp(x) { return lib.safe(x); }\n` +
      body,
  };
}

/** Catches what the export throws, so the entry still calls `run`. */
function tolerant(first: string): string {
  return `const w = require("wrap");\ntry { ${first}; } catch (e) { void e; }\nw.run("x");\n`;
}

const EXPORT = `module.exports = Api;\nmodule.exports.run = safeOp;\n`;

/** Read a stack callsite's own `getFunction()` / `getThis()` from inside a function. */
const FRAMES =
  `const o = Error.prepareStackTrace; Error.prepareStackTrace = (e, s) => s; ` +
  `const s = new Error().stack; Error.prepareStackTrace = o;`;

export const BL084_CASES: readonly E1Case[] = [
  // RWF-114: `arguments.callee` in a sloppy function that is the export.
  {
    id: "rwf114.callee-module-time",
    finding: "RWF-114",
    mechanism:
      "`function Api() { arguments.callee.run = dangerousOp; } module.exports = Api; module.exports.run = safeOp; Api();`",
    wrap: `function Api() { arguments.callee.run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.callee-entry-calls",
    finding: "RWF-114",
    mechanism: 'the same, the entry calling `w()` before `w.run("x")`',
    wrap: `function Api() { arguments.callee.run = dangerousOp; }\n${EXPORT}`,
    app: CALL_APP,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.callee-inline-value",
    finding: "RWF-114",
    mechanism: "`arguments.callee.run = function (x) { return lib.parse(x); }`",
    wrap: `function Api() { arguments.callee.run = function (x) { return lib.parse(x); }; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.callee-function-expression",
    finding: "RWF-114",
    mechanism:
      "`var Api = function () { arguments.callee.run = dangerousOp; }`",
    wrap: `var Api = function () { arguments.callee.run = dangerousOp; };\n${EXPORT}`,
    app: CALL_APP,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.arguments-handed-on",
    finding: "RWF-114",
    mechanism:
      "`function set(a) { a.callee.run = dangerousOp; } function Api() { set(arguments); }`",
    wrap: `function set(a) { a.callee.run = dangerousOp; }\nfunction Api() { set(arguments); }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.arrow-inherits-arguments",
    finding: "RWF-114",
    mechanism:
      "`function Api() { const f = () => { arguments.callee.run = dangerousOp; }; f(); }`",
    wrap: `function Api() { const f = () => { arguments.callee.run = dangerousOp; }; f(); }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.callee-alias",
    finding: "RWF-114",
    mechanism:
      "`function Api() { const self = arguments.callee; self.run = dangerousOp; }`",
    wrap: `function Api() { const self = arguments.callee; self.run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.callee-element-key",
    finding: "RWF-114",
    mechanism: '`arguments["callee"].run = dangerousOp`',
    wrap: `function Api() { arguments["callee"].run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.callee-computed-key",
    finding: "RWF-114",
    mechanism:
      '`function Api(k) { arguments[k].run = dangerousOp; }`, the entry calling `w("callee")`',
    wrap: `function Api(k) { arguments[k].run = dangerousOp; }\n${EXPORT}`,
    app: memberApp(`w("callee")`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.callee-destructured",
    finding: "RWF-114",
    mechanism: "`const { callee } = arguments; callee.run = dangerousOp;`",
    wrap: `function Api() { const { callee } = arguments; callee.run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // BL-084's independent audit (round 1): F1, F2, F3.
  {
    id: "rwf114.var-arguments",
    finding: "RWF-114",
    mechanism:
      "`function Api() { var arguments; arguments.callee.run = dangerousOp; }`: a `var` re-declares the same arguments object",
    wrap: `function Api() { var arguments; arguments.callee.run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.var-arguments-handed-on",
    finding: "RWF-114",
    mechanism:
      "`function set(a) { a.callee.run = dangerousOp; } function Api() { var arguments; set(arguments); }`",
    wrap: `function set(a) { a.callee.run = dangerousOp; }\nfunction Api() { var arguments; set(arguments); }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.assignment-value",
    finding: "RWF-114",
    mechanism: "`var b; (b = arguments.callee).run = dangerousOp;`",
    wrap: `function Api() { var b; (b = arguments.callee).run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.assignment-chain",
    finding: "RWF-114",
    mechanism: "`var a, b; a = b = arguments.callee; a.run = dangerousOp;`",
    wrap: `function Api() { var a, b; a = b = arguments.callee; a.run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.assignment-handed-on",
    finding: "RWF-114",
    mechanism:
      "`function set(o) { o.run = dangerousOp; } function Api() { var b; set(b = arguments.callee); }`",
    wrap: `function set(o) { o.run = dangerousOp; }\nfunction Api() { var b; set(b = arguments.callee); }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.shorthand-destructured-key",
    finding: "RWF-114",
    mechanism:
      '`var k = 0; ({ k } = { k: "callee" }); arguments[k].run = dangerousOp;` -- a shorthand pattern writes the counter',
    wrap: `function Api() { var k = 0; ({ k } = { k: "callee" }); arguments[k].run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.shorthand-default-key",
    finding: "RWF-114",
    mechanism:
      '`var k = 0; ({ k = "callee" } = {}); arguments[k].run = dangerousOp;`',
    wrap: `function Api() { var k = 0; ({ k = "callee" } = {}); arguments[k].run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // BL-084's independent audit (round 2): findings 1 and 2.
  {
    id: "rwf114.function-arguments-property",
    finding: "RWF-114",
    mechanism:
      "`function Api() { helper(); } function helper() { Api.arguments.callee.run = dangerousOp; }`: a sloppy function's `arguments` property is its frame's arguments object",
    wrap: `function Api() { helper(); }\nfunction helper() { Api.arguments.callee.run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.callee-arguments-callee",
    finding: "RWF-114",
    mechanism:
      "`function Api() { arguments.callee.arguments.callee.run = dangerousOp; }`",
    wrap: `function Api() { arguments.callee.arguments.callee.run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.caller-arguments-callee",
    finding: "RWF-114",
    mechanism:
      "`function helper() { helper.caller.arguments.callee.run = dangerousOp; } function Api() { helper(); }`",
    wrap: `function helper() { helper.caller.arguments.callee.run = dangerousOp; }\nfunction Api() { helper(); }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.export-write-back-value",
    finding: "RWF-114",
    mechanism:
      "`function Api() { (module.exports.self = arguments.callee).run = dangerousOp; }`: the write-back's own value",
    wrap: `function Api() { (module.exports.self = arguments.callee).run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.export-write-back-handed-on",
    finding: "RWF-114",
    mechanism:
      "`function set(f) { f.run = dangerousOp; } function Api() { set(exports.self = arguments.callee); }`",
    wrap: `function set(f) { f.run = dangerousOp; }\nfunction Api() { set(exports.self = arguments.callee); }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // BL-084's independent audit (round 3): a stored self-reference read back.
  {
    id: "rwf114.stored-self-read-back",
    finding: "RWF-114",
    mechanism:
      "`function Api() { module.exports.self = arguments.callee; module.exports.self.run = dangerousOp; }`",
    wrap: `function Api() { module.exports.self = arguments.callee; module.exports.self.run = dangerousOp; }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.stored-default-read-back",
    finding: "RWF-114",
    mechanism:
      "`function Api() { module.exports.default = arguments.callee; }` … `Api(); Api.default.run = dangerousOp;`",
    wrap: `function Api() { module.exports.default = arguments.callee; }\n${EXPORT}Api();\nApi.default.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.binding-stored-self-read-back",
    finding: "RWF-114",
    mechanism:
      "`Api.self = Api; Api.self.run = dangerousOp;` -- the binding's own census, the same gap",
    wrap: `function Api() {}\n${EXPORT}Api.self = Api;\nApi.self.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.binding-stored-self-read-through-exports",
    finding: "RWF-114",
    mechanism: "`Api.self = Api; module.exports.self.run = dangerousOp;`",
    wrap: `function Api() {}\n${EXPORT}Api.self = Api;\nmodule.exports.self.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // BL-084's independent audit (round 4): a named function expression's own name.
  {
    id: "rwf114.named-expression-own-name",
    finding: "RWF-114",
    mechanism:
      "`const Api = function Inner() { Inner.run = dangerousOp; }`: the expression's own name is a second binding to the export",
    wrap: `const Api = function Inner() { Inner.run = dangerousOp; };\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf114.named-expression-own-name-handed-on",
    finding: "RWF-114",
    mechanism:
      "`const Api = function Inner() { setup(Inner); }; function setup(f) { f.run = dangerousOp; }`",
    wrap: `function setup(f) { f.run = dangerousOp; }\nconst Api = function Inner() { setup(Inner); };\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-116 (found by BL-084): a sloppy function is the `caller` of what it calls.
  {
    id: "rwf116.caller-module-time",
    finding: "RWF-116",
    mechanism:
      "`function helper() { helper.caller.run = dangerousOp; } function Api() { helper(); }`; `Api()` at module time",
    wrap: `function helper() { helper.caller.run = dangerousOp; }\nfunction Api() { helper(); }\n${EXPORT}Api();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf116.caller-entry-calls",
    finding: "RWF-116",
    mechanism: "the same, the entry calling `w()` first",
    wrap: `function helper() { helper.caller.run = dangerousOp; }\nfunction Api() { helper(); }\n${EXPORT}`,
    app: CALL_APP,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-115: `new.target` and the `constructor` chain.
  {
    id: "rwf115.new-target-conditional",
    finding: "RWF-115",
    mechanism:
      "`function Api() { if (new.target) new.target.run = dangerousOp; }`; the entry constructs `w` first",
    wrap: `function Api() { if (new.target) new.target.run = dangerousOp; }\n${EXPORT}`,
    app: NEW_APP,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf115.new-target-alias",
    finding: "RWF-115",
    mechanism:
      "`function Api() { const C = new.target; if (C) C.run = dangerousOp; }`",
    wrap: `function Api() { const C = new.target; if (C) C.run = dangerousOp; }\n${EXPORT}`,
    app: NEW_APP,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf115.new-target-handed-on",
    finding: "RWF-115",
    mechanism:
      "`function set(C) { C.run = dangerousOp; } function Api() { if (new.target) set(new.target); }`",
    wrap: `function set(C) { C.run = dangerousOp; }\nfunction Api() { if (new.target) set(new.target); }\n${EXPORT}`,
    app: NEW_APP,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf115.prototype-computed-key",
    finding: "RWF-115",
    mechanism:
      '`module.exports.setup = function (k) { Api.prototype[k].run = dangerousOp; }`; the entry calls `w.setup("constructor")`',
    wrap: `function Api() {}\n${EXPORT}module.exports.setup = function (k) { Api.prototype[k].run = dangerousOp; };\n`,
    app: memberApp(`w.setup("constructor")`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf115.counter-written-a-string-key",
    finding: "RWF-115",
    mechanism:
      '`var k = 0; k = "constr" + "uctor"; Api.prototype[k].run = dangerousOp;` -- a counter later written a string is no number',
    wrap: `function Api() {}\n${EXPORT}module.exports.setup = function () { var k = 0; k = "constr" + "uctor"; Api.prototype[k].run = dangerousOp; };\n`,
    app: memberApp(`w.setup()`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-117 (found by BL-084): a `super` property write sets the property on `this`.
  {
    id: "rwf117.literal-method-super-write",
    finding: "RWF-117",
    mechanism:
      "`module.exports = { run: safeOp, init() { super.run = dangerousOp; } }`; the entry calls `w.init()` first",
    wrap: `module.exports = { run: safeOp, init() { super.run = dangerousOp; } };\n`,
    app: memberApp(`w.init()`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-115 without BL-064's taint: the model attributed `run`.
  {
    id: "lazy.prototype-constructor",
    finding: "RWF-115",
    mechanism:
      "lazy `wrap`: `Api.prototype.constructor.run = dangerousOp` after the export's write",
    wrap: ``,
    wrapFiles: lazy(
      `function Api() {}\n${EXPORT}Api.prototype.constructor.run = dangerousOp;\n`,
    ),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "lazy.setup-prototype-constructor",
    finding: "RWF-115",
    mechanism:
      "lazy `wrap`: `module.exports.setup = function () { Api.prototype.constructor.run = dangerousOp; }`",
    wrap: ``,
    wrapFiles: lazy(
      `function Api() {}\n${EXPORT}module.exports.setup = function () { Api.prototype.constructor.run = dangerousOp; };\n`,
    ),
    app: memberApp(`w.setup()`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "lazy.constructor-this-constructor",
    finding: "RWF-115",
    mechanism:
      "lazy `wrap`: `function Api() { this.constructor.run = dangerousOp; }`",
    wrap: ``,
    wrapFiles: lazy(
      `function Api() { this.constructor.run = dangerousOp; }\n${EXPORT}`,
    ),
    app: NEW_APP,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "lazy.prototype-handed-on",
    finding: "RWF-115",
    mechanism:
      "lazy `wrap`: `function set(p) { p.constructor.run = dangerousOp; } … set(Api.prototype);`",
    wrap: ``,
    wrapFiles: lazy(
      `function set(p) { p.constructor.run = dangerousOp; }\nfunction Api() {}\n${EXPORT}set(Api.prototype);\n`,
    ),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "lazy.reflect-get-prototype",
    finding: "RWF-115",
    mechanism:
      'lazy `wrap`: `Reflect.get(Api.prototype, k).run = dangerousOp`, the entry calling `w.setup("constructor")`',
    wrap: ``,
    wrapFiles: lazy(
      `function Api() {}\n${EXPORT}module.exports.setup = function (k) { Reflect.get(Api.prototype, k).run = dangerousOp; };\n`,
    ),
    app: memberApp(`w.setup("constructor")`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "lazy.stack-get-function",
    finding: "RWF-116",
    mechanism:
      "lazy `wrap`: a stack callsite's `getFunction()` in `Api`'s frame, written through",
    wrap: ``,
    wrapFiles: lazy(
      `function Api() { ${FRAMES} s[0].getFunction().run = dangerousOp; }\n${EXPORT}`,
    ),
    app: CALL_APP,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Masked on the base (BL-064's taint, or the call graph's escape row).
  {
    id: "masked.instance-constructor",
    finding: "RWF-115",
    mechanism: "`(new Api()).constructor.run = dangerousOp`",
    wrap: `function Api() {}\n${EXPORT}(new Api()).constructor.run = dangerousOp;\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.prototype-method-this-constructor",
    finding: "RWF-115",
    mechanism:
      "`Api.prototype.init = function () { this.constructor.run = dangerousOp; }`; the entry calls `new w().init()`",
    wrap: `function Api() {}\nApi.prototype.init = function () { this.constructor.run = dangerousOp; };\n${EXPORT}`,
    app: memberApp(`new w().init()`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.class-new-target",
    finding: "RWF-115",
    mechanism:
      "`class Api { constructor() { new.target.run = dangerousOp; } }`",
    wrap: `class Api { constructor() { new.target.run = dangerousOp; } }\n${EXPORT}`,
    app: NEW_APP,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.base-class-new-target",
    finding: "RWF-115",
    mechanism:
      "`class Base { constructor() { new.target.run = dangerousOp; } } class Api extends Base {}`",
    wrap: `class Base { constructor() { new.target.run = dangerousOp; } }\nclass Api extends Base {}\n${EXPORT}`,
    app: NEW_APP,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.static-super-write",
    finding: "RWF-117",
    mechanism:
      "`class Api extends B { static init() { super.run = dangerousOp; } }`; the entry calls `w.init()`",
    wrap: `class B {}\nclass Api extends B { static init() { super.run = dangerousOp; } }\n${EXPORT}`,
    app: memberApp(`w.init()`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.computed-instance-key",
    finding: "RWF-115",
    mechanism:
      '`const k = "constr" + "uctor"; new Api()[k].run = dangerousOp;`',
    wrap: `function Api() {}\n${EXPORT}const k = "constr" + "uctor";\nnew Api()[k].run = dangerousOp;\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Strict code has none of these routes (real Node, measured).
  {
    id: "strict.file-callee-throws",
    finding: "control",
    mechanism:
      '`"use strict"` file: `arguments.callee` throws, so `run` stays `safeOp`',
    wrap: ``,
    wrapFiles: strict(
      `function Api() { arguments.callee.run = dangerousOp; }\n${EXPORT}`,
    ),
    app: tolerant(`w()`),
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "strict.function-is-no-caller",
    finding: "control",
    mechanism:
      '`function Api() { "use strict"; helper(); }`: a strict function is no `caller`',
    wrap: `function helper() { const c = helper.caller; if (c) c.run = dangerousOp; }\nfunction Api() { "use strict"; helper(); }\n${EXPORT}`,
    app: CALL_APP,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "strict.class-constructor-callee-throws",
    finding: "control",
    mechanism:
      "`class Api { constructor() { arguments.callee.run = dangerousOp; } }`: class code is strict",
    wrap: `class Api { constructor() { arguments.callee.run = dangerousOp; } }\n${EXPORT}`,
    app: tolerant(`new w()`),
    called: false,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "strict.class-frame-has-no-this",
    finding: "control",
    mechanism:
      "a class's static method reads its own frame's `getThis()`: class code is strict, so it is `undefined`",
    wrap: `class Api { static init() { ${FRAMES} const t = s[0].getThis(); if (t) t.run = dangerousOp; } }\n${EXPORT}`,
    app: memberApp(`w.init()`),
    called: false,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Precision BL-084 keeps.
  {
    id: "control.plain-function",
    finding: "control",
    mechanism:
      "`function Api() {} module.exports = Api; module.exports.run = safeOp;`",
    wrap: `function Api() {}\n${EXPORT}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.counter-indexed-read-handed-on",
    finding: "control",
    mechanism:
      "`module.exports.each = function (xs, f) { for (var i = 0; i < xs.length; i++) f(xs[i]); }`: a number is no `constructor` key",
    wrap: `function Api() {}\n${EXPORT}module.exports.each = function (xs, f) { for (var i = 0; i < xs.length; i++) f(xs[i]); };\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.arguments-length-and-index",
    finding: "control",
    mechanism: "`function Api() { return arguments.length + arguments[0]; }`",
    wrap: `function Api() { return arguments.length + arguments[0]; }\n${EXPORT}Api(1);\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.strict-arguments-handed-on",
    finding: "control",
    mechanism:
      '`"use strict"` file: `function count(a) { return a.length; } function Api() { return count(arguments); }`',
    wrap: ``,
    wrapFiles: strict(
      `function count(a) { return a.length; }\nfunction Api() { return count(arguments); }\n${EXPORT}Api();\n`,
    ),
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // Precision BL-084 gives up.
  {
    id: "cost.sloppy-arguments-handed-on",
    finding: "control",
    mechanism:
      "sloppy `function count(a) { return a.length; } function Api() { return count(arguments); }`: the callee could read `a.callee`",
    wrap: `function count(a) { return a.length; }\nfunction Api() { return count(arguments); }\n${EXPORT}Api();\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.computed-read-returned",
    finding: "control",
    mechanism:
      "`module.exports.get = function (o, k) { return o[k]; }`: a computed read handed on may be `Api`",
    wrap: `function Api() {}\n${EXPORT}module.exports.get = function (o, k) { return o[k]; };\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];
