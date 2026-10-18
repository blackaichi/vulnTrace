import type { E1Case } from "./e1-export-write-set.cases.js";

/**
 * Task BL-081 (docs/tasks/BL-081-builtin-replaced-without-name.md; ADR
 * 0008 § 2's escape row and § 4's builtin table): a store that may land on
 * a builtin object is an escape, whatever route reached the object, against
 * real Node.
 *
 * THE MECHANISM. The call graph trusts a call of a builtin Node supplies
 * (`Object.keys({})`: a no-edge proof; `setTimeout(cb, 0)`: a resolved
 * edge to `cb`) on the strength of the builtin's identity at the call
 * site. A-3a's escape row saw a replacement of the builtin only when the
 * store spelled its name. Builtins are shared by every module of the
 * process, and a builtin object reaches a user binding through routes no
 * spelling shows -- a parameter, a container, a returned value, a load,
 * `constructor`, a sloppy call's `this` (RWF-110, RWF-063) -- or is written
 * by a store form the escape row did not read: a `with` body, a `for…of`
 * head (RWF-120).
 *
 * LOUD FIXTURE. E-1's (`e1-export-write-set.cases.ts`): `vuln-lib` exports
 * `parse` (the rule's target) and `safe`; `wrap/index.js` defines
 * `dangerousOp` (calls `parse`) and `safeOp` (calls `safe`), and its own
 * export `run` is `safeOp`, which the entry calls. The replacement calls
 * `dangerousOp` (or, in a sibling or the entry, a `danger` calling
 * `parse`), and nothing else does: the target is reached only if the
 * replaced builtin runs it.
 *
 * THE CONTROLS. E-1's: the negative control writes `exports.run = safeOp`
 * once (`NOT_AFFECTED`); the positive control adds a direct call of
 * `parse` in the entry (`AFFECTED`).
 *
 * `base` is the analyzer's verdict on BL-081's base `5db3c81` (BL-089's
 * merge), measured. `rwf110.*`, `rwf063.*` and `rwf120.*` with `base:
 * "NOT_AFFECTED"` and `called: true` are the live false `NOT_AFFECTED`s
 * BL-081 closes; `fresh.*` attack a proof that an object is the
 * program's own, each making the object a builtin through a store the
 * proof must see (live on the base too, unless `base` says `UNKNOWN`);
 * `masked.*` were already `UNKNOWN` through another account; `control.*`
 * keep their precision, one per proof of `isProvenFreshObject`
 * (`escape-row.ts`); `cost.*` is precision BL-081 gives up.
 */

/** The replacement, in `wrap/index.js`: runs the target, returns what `Object.keys` would. */
const F = `function (o) { dangerousOp(o); return []; }`;

/** A sibling or entry prelude: a function calling the target. */
const DANGER =
  `const lib = require("vuln-lib");\n` +
  `function danger(x) { return lib.parse(x); }\n`;

/** The replacement, in a sibling or the entry. */
const G = `function (o) { danger(o); return []; }`;

/** `wrap`'s own export, then a call of `Object.keys` the call graph trusts. */
const KEYS = `exports.run = safeOp;\nObject.keys({});\n`;

export const BL081_CASES: readonly E1Case[] = [
  // RWF-110: the recorded spellings.
  {
    id: "rwf110.constructor-of-a-literal",
    finding: "RWF-110",
    mechanism:
      "`({}).constructor.keys = function (o) { dangerousOp(o); … }; Object.keys({})`",
    wrap: `({}).constructor.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf110.sibling-constructor-of-a-literal",
    finding: "RWF-110",
    mechanism:
      '`require("./patch")` (`({}).constructor.keys = …`); `Object.keys({})`',
    wrap: `require("./patch");\n${KEYS}`,
    wrapFiles: { "patch.js": DANGER + `({}).constructor.keys = ${G};\n` },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf110.sibling-install-object",
    finding: "RWF-110",
    mechanism:
      '`require("./patch")` (`function install(O) { O.keys = …; } install(Object)`); `Object.keys({})`',
    wrap: `require("./patch");\n${KEYS}`,
    wrapFiles: {
      "patch.js":
        DANGER + `function install(O) { O.keys = ${G}; }\ninstall(Object);\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-110, wider than recorded: every other route to the object.
  {
    id: "rwf110.install-object-same-file",
    finding: "RWF-110",
    mechanism: "`function install(O) { O.keys = …; } install(Object)`",
    wrap: `function install(O) { O.keys = ${F}; }\ninstall(Object);\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf110.entry-before-loading",
    finding: "RWF-110",
    mechanism:
      "the entry, outside `wrap`, replaces `Object.keys` through `({}).constructor` before it loads `wrap`",
    wrap: KEYS,
    app:
      DANGER +
      `({}).constructor.keys = ${G};\n` +
      `const w = require("wrap");\nw.run("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf110.destructured-constructor",
    finding: "RWF-110",
    mechanism: "`const { constructor: C } = {}; C.keys = …`",
    wrap: `const { constructor: C } = {};\nC.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf110.constructor-of-exports",
    finding: "RWF-110",
    mechanism: "`exports.constructor.keys = …`",
    wrap: `exports.constructor.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf110.opaque-value-through-a-parameter",
    finding: "RWF-110",
    mechanism:
      "`function install(O, g) { O.keys = g; } install(Object, function (o) { dangerousOp(o); … })`",
    wrap: `function install(O, g) { O.keys = g; }\ninstall(Object, ${F});\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-063 (backlog BL-039, folded in): a builtin object in a container,
  // returned, loaded, or a builtin module or the global object handed to a
  // parameter.
  {
    id: "rwf063.container",
    finding: "RWF-063",
    mechanism: "`const box = [Object]; box[0].keys = …`",
    wrap: `const box = [Object];\nbox[0].keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.returned",
    finding: "RWF-063",
    mechanism: "`function get() { return Object; } get().keys = …`",
    wrap: `function get() { return Object; }\nget().keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.load-result",
    finding: "RWF-063",
    mechanism:
      '`./o.js` is `module.exports = Object`; `require("./o").keys = …`',
    wrap: `require("./o").keys = ${F};\n${KEYS}`,
    wrapFiles: { "o.js": `module.exports = Object;\n` },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.path-through-a-parameter",
    finding: "RWF-063",
    mechanism:
      '`const path = require("path"); install(path)` writes `p.join`; `path.join("a", "b")`',
    wrap:
      `const path = require("path");\n` +
      `function install(p) { p.join = function () { dangerousOp("x"); return ""; }; }\n` +
      `install(path);\nexports.run = safeOp;\npath.join("a", "b");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.fs-through-a-parameter",
    finding: "RWF-063",
    mechanism:
      '`const fs = require("fs"); install(fs)` writes `m.readFileSync`; `fs.readFileSync("x")`',
    wrap:
      `const fs = require("fs");\n` +
      `function install(m) { m.readFileSync = function () { dangerousOp("x"); return ""; }; }\n` +
      `install(fs);\nexports.run = safeOp;\nfs.readFileSync("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.global-object-through-a-parameter",
    finding: "RWF-063",
    mechanism:
      "`function patch(g) { g.setTimeout = …; } patch(globalThis); setTimeout(function () {}, 0)`",
    wrap:
      `function patch(g) { g.setTimeout = function () { dangerousOp("x"); }; }\n` +
      `patch(globalThis);\nexports.run = safeOp;\nsetTimeout(function () {}, 0);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.sloppy-this-is-the-global-object",
    finding: "RWF-063",
    mechanism:
      "`function patch() { this.setTimeout = …; } patch(); setTimeout(function () {}, 0)`",
    wrap:
      `function patch() { this.setTimeout = function () { dangerousOp("x"); }; }\n` +
      `patch();\nexports.run = safeOp;\nsetTimeout(function () {}, 0);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-120: two store forms A-3a's escape row never read, even by name.
  {
    id: "rwf120.with-body",
    finding: "RWF-120",
    mechanism: "`with (Object) { keys = …; }`",
    wrap: `with (Object) { keys = ${F}; }\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.for-of-head-by-name",
    finding: "RWF-120",
    mechanism: "`for (Object.keys of [function (o) { dangerousOp(o); … }]) {}`",
    wrap: `for (Object.keys of [${F}]) {}\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.for-of-head-through-a-parameter",
    finding: "RWF-120",
    mechanism:
      "`function install(O) { for (O.keys of [function (o) { … }]) {} } install(Object)`",
    wrap: `function install(O) { for (O.keys of [${F}]) {} }\ninstall(Object);\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-120, from BL-081's independent audit: what an iteration stores is
  // what the iterator yields, and a `var` in a `with` body is a store.
  {
    id: "rwf120.for-of-over-an-iterable-object",
    finding: "RWF-120",
    mechanism:
      "`for (Object.keys of { *[Symbol.iterator]() { yield function (o) { … }; } }) {}`",
    wrap: `for (Object.keys of { *[Symbol.iterator]() { yield ${F}; } }) {}\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.array-pattern-over-an-iterable-object-through-a-parameter",
    finding: "RWF-120",
    mechanism:
      "`function install(O) { [O.keys] = { *[Symbol.iterator]() { yield …; } }; } install(Object)`",
    wrap: `function install(O) { [O.keys] = { *[Symbol.iterator]() { yield ${F}; } }; }\ninstall(Object);\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.var-in-a-with-body",
    finding: "RWF-120",
    mechanism: "`with (Object) { var keys = …; }`",
    wrap: `with (Object) { var keys = ${F}; }\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.var-pattern-in-a-with-body",
    finding: "RWF-120",
    mechanism: "`with (Object) { var [keys] = [function (o) { … }]; }`",
    wrap: `with (Object) { var [keys] = [${F}]; }\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.for-var-in-a-with-body",
    finding: "RWF-120",
    mechanism: "`with (Object) { for (var keys of [function (o) { … }]) {} }`",
    wrap: `with (Object) { for (var keys of [${F}]) {} }\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.var-in-a-with-body-through-a-parameter",
    finding: "RWF-120",
    mechanism:
      "`function install(O) { with (O) { var keys = …; } } install(Object)`",
    wrap: `function install(O) { with (O) { var keys = ${F}; } }\ninstall(Object);\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // BL-081's own regression, found by its audit: a protocol-keyed array
  // pattern through a parameter was A-4's always-unknown `pattern_store`,
  // and the escape's account must not replace it with the iterable's
  // members.
  {
    id: "audit.protocol-array-pattern-over-an-iterable-object",
    finding: "RWF-120",
    mechanism:
      "`function install(o) { [o.toString] = { *[Symbol.iterator]() { yield …; } }; } const t = {}; install(t); String(t)`",
    wrap:
      `function install(o) { [o.toString] = { *[Symbol.iterator]() { yield function () { dangerousOp("x"); return "s"; }; } }; }\n` +
      `const t = {};\ninstall(t);\nString(t);\nexports.run = safeOp;\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "audit.protocol-for-of-over-an-iterable-object",
    finding: "RWF-120",
    mechanism:
      "`function install(o) { for (o.toString of { *[Symbol.iterator]() { yield …; } }) {} } …; String(t)`",
    wrap:
      `function install(o) { for (o.toString of { *[Symbol.iterator]() { yield function () { dangerousOp("x"); return "s"; }; } }) {} }\n` +
      `const t = {};\ninstall(t);\nString(t);\nexports.run = safeOp;\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.derived-class-field",
    finding: "RWF-110",
    mechanism:
      "`class Base { constructor(o) { return o; } } class D extends Base { keys = …; } new D(Object)` (a field is defined onto what the base constructor returned)",
    wrap:
      `class Base { constructor(o) { return o; } }\n` +
      `class D extends Base { keys = ${F}; }\nnew D(Object);\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // A proof that an object is the program's own, attacked: each makes the
  // object a builtin through a store the proof must see.
  {
    id: "fresh.module-exports-through-an-alias",
    finding: "RWF-110",
    mechanism:
      "`const m = module; m.exports = Object; module.exports.keys = …; m.exports = exports` (the alias's store must be checked)",
    wrap:
      `const m = module;\nm.exports = Object;\nmodule.exports.keys = ${F};\n` +
      `m.exports = exports;\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.exports-reassigned",
    finding: "RWF-110",
    mechanism:
      "`exports = Object; exports.keys = …` (`exports` no longer holds the wrapper's object)",
    wrap:
      `exports = Object;\nexports.keys = ${F};\n` +
      `module.exports.run = safeOp;\nObject.keys({});\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.function-prototype-replaced",
    finding: "RWF-110",
    mechanism: "`function P() {} P.prototype = Object; P.prototype.keys = …`",
    wrap: `function P() {}\nP.prototype = Object;\nP.prototype.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.function-prototype-replaced-through-an-alias",
    finding: "RWF-110",
    mechanism:
      "`function P() {} const Q = P; Q.prototype = Object; P.prototype.keys = …`",
    wrap:
      `function P() {}\nconst Q = P;\nQ.prototype = Object;\n` +
      `P.prototype.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.function-prototype-written-by-a-builtin",
    finding: "RWF-110",
    mechanism:
      '`Object.assign(P, { prototype: fs.promises }); P.prototype.readFile = …; fs.promises.readFile("x")` (a builtin module\'s value handed to a builtin that stores it)',
    wrap:
      `const fs = require("fs");\nfunction P() {}\n` +
      `Object.assign(P, { prototype: fs.promises });\n` +
      `P.prototype.readFile = function () { dangerousOp("x"); return Promise.resolve(""); };\n` +
      `exports.run = safeOp;\nfs.promises.readFile("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.builtin-function-in-a-mixed-store",
    finding: "RWF-110",
    mechanism:
      "`Object.keys = Date.now() > 0 ? timers.setTimeout : function () {}`, then `Object.keys(cb)` with `cb` a parameter (a builtin stored over a builtin, beside the program's function)",
    wrap:
      `const timers = require("timers");\n` +
      `Object.keys = Date.now() > 0 ? timers.setTimeout : function () { return []; };\n` +
      `function call(cb) { Object.keys(cb); }\ncall(dangerousOp);\n` +
      `exports.run = safeOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.class-reassigned",
    finding: "RWF-110",
    mechanism:
      "`class C {} C = Object; C.keys = …` (a class binding is mutable)",
    wrap: `class C {}\nC = Object;\nC.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.this-in-a-computed-member-name",
    finding: "RWF-110",
    mechanism:
      '`function g() { class K { [(this.keys = …, "k")] = 1; } } g.call(Object)` (a computed name evaluates in the enclosing scope)',
    wrap:
      `function g() { class K { [(this.keys = ${F}, "k")] = 1; } void K; }\n` +
      `g.call(Object);\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // From BL-081's second audit round.
  {
    id: "fresh.function-prototype-through-an-assignment-value",
    finding: "RWF-110",
    mechanism:
      "`function Fn() {} let a; (a = Fn).prototype = Object; Fn.prototype.keys = …`",
    wrap: `function Fn() {}\nlet a;\n(a = Fn).prototype = Object;\nFn.prototype.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.function-expression-own-name",
    finding: "RWF-110",
    mechanism:
      "`const Fn = function Self() { Self.prototype = Object; }; Fn(); Fn.prototype.keys = …`",
    wrap: `const Fn = function Self() { Self.prototype = Object; };\nFn();\nFn.prototype.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.var-pattern-default-in-a-with-body",
    finding: "RWF-120",
    mechanism: "`with (Object) { var { keys = … } = 0; }`",
    wrap: `with (Object) { var { keys = ${F} } = 0; }\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.for-var-pattern-default-in-a-with-body",
    finding: "RWF-120",
    mechanism: "`with (Object) { for (var { keys = … } of [0]) {} }`",
    wrap: `with (Object) { for (var { keys = ${F} } of [0]) {} }\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.object-pattern-reads-a-member-through-a-parameter",
    finding: "RWF-120",
    mechanism:
      "`fn.a = …; function install(O) { ({ a: O.keys } = fn); } install(Object)`",
    wrap: `function fn() {}\nfn.a = ${F};\nfunction install(O) { ({ a: O.keys } = fn); }\ninstall(Object);\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.object-pattern-reads-a-member-by-name",
    finding: "RWF-120",
    mechanism: "`fn.a = …; ({ a: Object.keys } = fn)`",
    wrap: `function fn() {}\nfn.a = ${F};\n({ a: Object.keys } = fn);\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.class-with-a-static-method-stored-as-a-builtin",
    finding: "RWF-063",
    mechanism:
      "`class K { static max(a) { … } } function install(G) { G.Math = K; } install(globalThis); Math.max(1, 2)`",
    wrap: `class K { static max(a) { dangerousOp(a); return 0; } }\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.function-with-a-stored-member-stored-as-a-builtin",
    finding: "RWF-063",
    mechanism:
      "`fn.max = …; function install() { this.Math = fn; } install(); Math.max(1, 2)`",
    wrap: `function fn() {}\nfn.max = function (a) { dangerousOp(a); return 0; };\nfunction install() { this.Math = fn; }\ninstall();\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.var-pattern-default-over-an-object-literal-in-a-with-body",
    finding: "RWF-120",
    mechanism:
      "`with (Object) { var { keys = … } = {}; }` (the default is the store)",
    wrap: `with (Object) { var { a, keys = ${F} } = { a: function () {} }; }\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // From BL-081's third audit round: own members across files, and
  // through every route a freshness proof accepts.
  {
    id: "rwf063.imported-function-with-a-member-stored-as-a-builtin",
    finding: "RWF-063",
    mechanism:
      "`k.js`: `function K() {} K.max = …; exports.K = K`; `function install(G) { G.Math = k.K; } install(globalThis); Math.max(1, 2)`",
    wrap: `const k = require("./k");\nfunction install(G) { G.Math = k.K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    wrapFiles: {
      "k.js": `const lib = require("vuln-lib");\nfunction K() {}\nK.max = function (a) { lib.parse(a); return 0; };\nexports.K = K;\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.destructured-class-with-a-static-method-stored-as-a-builtin",
    finding: "RWF-063",
    mechanism:
      '`k.js`: `class K { static max(a) { … } }`; `const { K } = require("./k"); install(globalThis)` storing `G.Math = K`',
    wrap: `const { K } = require("./k");\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    wrapFiles: {
      "k.js": `const lib = require("vuln-lib");\nclass K { static max(a) { lib.parse(a); return 0; } }\nexports.K = K;\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.member-stored-through-an-assignment-value",
    finding: "RWF-063",
    mechanism:
      "`function K() {} let a; (a = K).max = …; install(globalThis)` storing `G.Math = K`",
    wrap: `function K() {}\nlet a;\n(a = K).max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.member-stored-through-a-prototype-route",
    finding: "RWF-063",
    mechanism:
      "`function K() {} function Fn() {} Fn.prototype = K; Fn.prototype.max = …; install(globalThis)` storing `G.Math = K`",
    wrap: `function K() {}\nfunction Fn() {}\nFn.prototype = K;\nFn.prototype.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf120.shorthand-default-in-a-with-body",
    finding: "RWF-120",
    mechanism:
      "`with (Object) { ({ keys = … } = { a: function () {} }); }` (a shorthand default is no assignment expression)",
    wrap: `with (Object) { ({ keys = ${F} } = { a: function () {} }); }\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // From BL-081's fourth audit round: a stable name bound to any route
  // a freshness proof accepts.
  {
    id: "rwf063.member-stored-through-a-const-bound-to-a-prototype",
    finding: "RWF-063",
    mechanism:
      "`function K() {} function F() {} F.prototype = K; const p = F.prototype; p.max = …; install(globalThis)`",
    wrap: `function K() {}\nfunction F() {}\nF.prototype = K;\nconst p = F.prototype;\np.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.member-stored-through-a-const-bound-to-an-assignment",
    finding: "RWF-063",
    mechanism:
      "`function K() {} let b; const a = (b = K); a.max = …; install(globalThis)`",
    wrap: `function K() {}\nlet b;\nconst a = (b = K);\na.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.member-stored-through-a-const-bound-to-module-exports",
    finding: "RWF-063",
    mechanism:
      '`k.js`: `module.exports = K; const m = module.exports; m.max = …`; `G.Math = require("./k")`',
    wrap: `const K = require("./k");\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    wrapFiles: {
      "k.js": `const lib = require("vuln-lib");\nfunction K() {}\nmodule.exports = K;\nconst m = module.exports;\nm.max = function (a) { lib.parse(a); return 0; };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.prototype-replaced-through-a-const-bound-to-an-assignment",
    finding: "RWF-110",
    mechanism:
      "`function P() {} let b; const q = (b = P); q.prototype = Object; P.prototype.keys = …`",
    wrap: `function P() {}\nlet b;\nconst q = (b = P);\nq.prototype = Object;\nP.prototype.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // From BL-081's fifth audit round: a `prototype` set through a route no
  // store spells, then members stored through it.
  {
    id: "rwf063.prototype-set-through-a-parameter",
    finding: "RWF-063",
    mechanism:
      "`function setP(X) { X.prototype = K; } setP(F); F.prototype.max = …; install(globalThis)` storing `G.Math = K`",
    wrap: `function K() {}\nfunction F() {}\nfunction setP(X) { X.prototype = K; }\nsetP(F);\nF.prototype.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-set-by-object-assign",
    finding: "RWF-063",
    mechanism:
      "`Object.assign(F, { prototype: K }); F.prototype.max = …; install(globalThis)` storing `G.Math = K`",
    wrap: `function K() {}\nfunction F() {}\nObject.assign(F, { prototype: K });\nF.prototype.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-set-by-define-property",
    finding: "RWF-063",
    mechanism:
      '`Object.defineProperty(F, "prototype", { value: K }); F.prototype.max = …; install(globalThis)`',
    wrap: `function K() {}\nfunction F() {}\nObject.defineProperty(F, "prototype", { value: K });\nF.prototype.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-set-in-a-for-of",
    finding: "RWF-063",
    mechanism:
      "`for (const Q of [F]) Q.prototype = K; F.prototype.max = …; install(globalThis)`",
    wrap: `function K() {}\nfunction F() {}\nfor (const Q of [F]) Q.prototype = K;\nF.prototype.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-set-from-another-file",
    finding: "RWF-063",
    mechanism:
      "`f.js`: `function F() {} exports.F = F; exports.later = function () { F.prototype.max = …; }`; `f.F.prototype = K; f.later(); install(globalThis)`",
    wrap: `const f = require("./f");\nfunction K() {}\nf.F.prototype = K;\nf.later();\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    wrapFiles: {
      "f.js": `const lib = require("vuln-lib");\nfunction F() {}\nexports.F = F;\nexports.later = function () { F.prototype.max = function (a) { lib.parse(a); return 0; }; };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-set-by-a-builtin-under-a-computed-key",
    finding: "RWF-063",
    mechanism:
      '`const k = ["proto", "type"].join(""); Reflect.set(F, k, K); F.prototype.max = …; install(globalThis)` (F handed on: its prototype cannot be followed)',
    wrap: `function K() {}\nfunction F() {}\nconst k = process.argv.length >= 0 ? "prototype" : "x";\nReflect.set(F, k, K);\nF.prototype.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-of-another-file-set-by-object-assign",
    finding: "RWF-063",
    mechanism:
      "`Object.assign(f.F, { prototype: K }); f.later(); install(globalThis)`, `f.js` storing `F.prototype.max = …`",
    wrap: `const f = require("./f");\nfunction K() {}\nObject.assign(f.F, { prototype: K });\nf.later();\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    wrapFiles: {
      "f.js": `const lib = require("vuln-lib");\nfunction F() {}\nexports.F = F;\nexports.later = function () { F.prototype.max = function (a) { lib.parse(a); return 0; }; };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // From BL-081's sixth audit round: a `prototype` set under another
  // name, from an ES module, or through a `with` body.
  {
    id: "rwf063.prototype-set-through-an-alias-by-define-property",
    finding: "RWF-063",
    mechanism:
      '`function F() {} const G = F; Object.defineProperty(F, "prototype", { value: K }); G.prototype.max = …; install(globalThis)`',
    wrap: `function K() {}\nfunction F() {}\nconst G = F;\nObject.defineProperty(F, "prototype", { value: K });\nG.prototype.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-of-an-es-module-export-set-by-define-property",
    finding: "RWF-063",
    mechanism:
      '`f.js`: `export function F() {} export function later() { F.prototype.max = …; }`; `Object.defineProperty(F, "prototype", { value: K }); later(); install(globalThis)`',
    esm: true,
    wrap: `import { F, later } from "./f.js";\nfunction K() {}\nObject.defineProperty(F, "prototype", { value: K });\nlater();\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexport const run = function (x) { return safeOp(x); };\nMath.max(1, 2);\n`,
    wrapFiles: {
      "f.js": `import { parse } from "vuln-esm";\nexport function F() {}\nexport function later() { F.prototype.max = function (a) { parse(a); return 0; }; }\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-set-in-a-with-body",
    finding: "RWF-063",
    mechanism:
      "`with (F.prototype.constructor) { prototype = K; } F.prototype.max = …; install(globalThis)`",
    wrap: `function K() {}\nfunction F() {}\nwith (F.prototype.constructor) { prototype = K; }\nF.prototype.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-declared-in-a-with-body",
    finding: "RWF-063",
    mechanism:
      "`with (F.prototype.constructor) { var prototype = K; } F.prototype.max = …; install(globalThis)`",
    wrap: `function K() {}\nfunction F() {}\nwith (F.prototype.constructor) { var prototype = K; }\nF.prototype.max = function (x) { dangerousOp(x); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // From BL-081's seventh audit round: an inherited `prototype`, and a
  // [[Prototype]] changed to the global object, whose setters store into it.
  {
    id: "fresh.async-function-prototype-inherited",
    finding: "RWF-110",
    mechanism:
      "`async function A() {} A.__proto__ = { prototype: Object }; A.prototype.keys = …`",
    wrap: `async function A() {}\nA.__proto__ = { prototype: Object };\nA.prototype.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.literal-with-global-prototype",
    finding: "RWF-110",
    mechanism:
      "`const o = { __proto__: globalThis }; o.Buffer = { isBuffer: … }; Buffer.isBuffer(1)` (the global's own setter stores it)",
    wrap: `const o = { __proto__: globalThis };\no.Buffer = { isBuffer: function (x) { dangerousOp(x); return false; } };\nexports.run = safeOp;\nBuffer.isBuffer(1);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.prototype-changed-to-the-global",
    finding: "RWF-110",
    mechanism:
      "`const o = {}; o.__proto__ = globalThis; o.Buffer = { isBuffer: … }; Buffer.isBuffer(1)`",
    wrap: `const o = {};\no.__proto__ = globalThis;\no.Buffer = { isBuffer: function (x) { dangerousOp(x); return false; } };\nexports.run = safeOp;\nBuffer.isBuffer(1);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.function-prototype-changed-to-the-global",
    finding: "RWF-110",
    mechanism:
      "`function F() {} F.__proto__ = globalThis; F.Buffer = { isBuffer: … }; Buffer.isBuffer(1)`",
    wrap: `function F() {}\nF.__proto__ = globalThis;\nF.Buffer = { isBuffer: function (x) { dangerousOp(x); return false; } };\nexports.run = safeOp;\nBuffer.isBuffer(1);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.class-instance-prototype-changed-to-the-global",
    finding: "RWF-110",
    mechanism:
      "`class C { constructor() { this.Buffer = … } } C.prototype.__proto__ = globalThis; new C(); Buffer.isBuffer(1)`",
    wrap: `class C { constructor() { this.Buffer = { isBuffer: function (x) { dangerousOp(x); return false; } }; } }\nC.prototype.__proto__ = globalThis;\nnew C();\nexports.run = safeOp;\nBuffer.isBuffer(1);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // From BL-081's eighth audit round: a `Symbol.x` that is no well-known
  // symbol holds whatever the program stored there.
  {
    id: "fresh.symbol-member-holding-proto",
    finding: "RWF-110",
    mechanism:
      '`Symbol.foo = "__proto__"; const o = {}; o[Symbol.foo] = globalThis; o.Buffer = { isBuffer: … }; Buffer.isBuffer(1)`',
    wrap: `Symbol.foo = "__proto__";\nconst o = {};\no[Symbol.foo] = globalThis;\no.Buffer = { isBuffer: function (x) { dangerousOp(x); return false; } };\nexports.run = safeOp;\nBuffer.isBuffer(1);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.symbol-member-holding-prototype",
    finding: "RWF-110",
    mechanism:
      '`Symbol.foo = "prototype"; function F() {} F[Symbol.foo] = Object; F.prototype.keys = …; Object.keys({})`',
    wrap: `Symbol.foo = "prototype";\nfunction F() {}\nF[Symbol.foo] = Object;\nF.prototype.keys = ${F};\n${KEYS}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.symbol-for-replaced-with-proto",
    finding: "RWF-110",
    mechanism:
      '`Symbol.for = "__proto__"; const o = {}; o[Symbol.for] = globalThis; o.Buffer = { isBuffer: … }; Buffer.isBuffer(1)`',
    wrap: `Symbol.for = "__proto__";\nconst o = {};\no[Symbol.for] = globalThis;\no.Buffer = { isBuffer: function (x) { dangerousOp(x); return false; } };\nexports.run = safeOp;\nBuffer.isBuffer(1);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // From BL-081's ninth audit round: even a well-known symbol is read off
  // the global `Symbol`, which another module may replace by a primitive.
  {
    id: "fresh.well-known-symbol-key-after-symbol-replaced",
    finding: "RWF-110",
    mechanism:
      '`s.js`: `globalThis.Symbol = ""; String.prototype.toStringTag = "__proto__"`; `const o = {}; o[Symbol.toStringTag] = globalThis; o.Buffer = { isBuffer: … }; Buffer.isBuffer(1)`',
    wrap: `require("./s");\nconst o = {};\no[Symbol.toStringTag] = globalThis;\no.Buffer = { isBuffer: function (x) { dangerousOp(x); return false; } };\nexports.run = safeOp;\nBuffer.isBuffer(1);\n`,
    wrapFiles: {
      "s.js": `globalThis.Symbol = "";\nString.prototype.toStringTag = "__proto__";\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.well-known-symbol-key-naming-prototype",
    finding: "RWF-110",
    mechanism:
      '`s.js`: `function S() {} S.toStringTag = "prototype"; globalThis.Symbol = S`; `function F() {} F[Symbol.toStringTag] = Object; F.prototype.keys = …; Object.keys({})`',
    wrap: `require("./s");\nfunction F() {}\nF[Symbol.toStringTag] = Object;\nF.prototype.keys = ${F};\n${KEYS}`,
    wrapFiles: {
      "s.js": `function S() {}\nS.toStringTag = "prototype";\nglobalThis.Symbol = S;\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.builtin-module-function-handed-to-a-builtin",
    finding: "RWF-110",
    mechanism:
      "`Object.assign(F, { keys: timers.setTimeout }); install(globalThis)` storing `G.Object = F`, then `Object.keys(cb)` (a builtin module's function handed to a builtin that stores it)",
    wrap: `const timers = require("timers");\nfunction F() {}\nObject.assign(F, { keys: timers.setTimeout });\nfunction install(G) { G.Object = F; }\ninstall(globalThis);\nfunction call(cb) { Object.keys(cb); }\ncall(dangerousOp);\nexports.run = safeOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // From BL-081's tenth audit round: a key read through a conditional,
  // and a lookup from a `with` body.
  {
    id: "rwf063.prototype-set-by-object-assign-under-a-conditional",
    finding: "RWF-063",
    mechanism:
      "`Object.assign(F, c ? { prototype: K } : {}); F.prototype.max = …; install(globalThis)` storing `G.Math = K`",
    wrap: `function F() {}\nfunction K() {}\nconst c = [1].length === 1;\nObject.assign(F, c ? { prototype: K } : {});\nF.prototype.max = function (a, b) { dangerousOp(a); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf063.prototype-set-by-object-assign-under-a-spread-conditional",
    finding: "RWF-063",
    mechanism:
      "`Object.assign(F, { ...(c ? { prototype: K } : {}) }); F.prototype.max = …; install(globalThis)`",
    wrap: `function F() {}\nfunction K() {}\nconst c = [1].length === 1;\nObject.assign(F, { ...(c ? { prototype: K } : {}) });\nF.prototype.max = function (a, b) { dangerousOp(a); return 0; };\nfunction install(G) { G.Math = K; }\ninstall(globalThis);\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "fresh.prototype-proof-looked-up-from-a-with-body",
    finding: "RWF-110",
    mechanism:
      "`function F() {} const A = F; with ({}) { F.prototype.z = function () {}; } A.prototype = Math; F.prototype.max = …; Math.max(1, 2)`",
    wrap: `function F() {}\nconst A = F;\nwith ({}) { F.prototype.z = function () {}; }\nA.prototype = Math;\nF.prototype.max = function (a, b) { dangerousOp(a); return 0; };\nexports.run = safeOp;\nMath.max(1, 2);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Masked on the base: already UNKNOWN through another account.
  {
    id: "masked.sloppy-this-member",
    finding: "RWF-110",
    mechanism: "`(function () { return this; })().Object.keys = …`",
    wrap: `(function () { return this; })().Object.keys = ${F};\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.array-prototype-through-proto",
    finding: "RWF-110",
    mechanism: "`[].__proto__.map = …; [1].map(function (x) { return x; })`",
    wrap:
      `[].__proto__.map = function () { dangerousOp("x"); return []; };\n` +
      `exports.run = safeOp;\n[1].map(function (x) { return x; });\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.get-prototype-of",
    finding: "RWF-110",
    mechanism:
      "`Object.getPrototypeOf([]).forEach = …; [1].forEach(function () {})`",
    wrap:
      `Object.getPrototypeOf([]).forEach = function () { dangerousOp("x"); };\n` +
      `exports.run = safeOp;\n[1].forEach(function () {});\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.define-property-through-a-parameter",
    finding: "RWF-110",
    mechanism:
      '`function install(O) { Object.defineProperty(O, "keys", { value: … }); } install(Object)`',
    wrap: `function install(O) { Object.defineProperty(O, "keys", { value: ${F} }); }\ninstall(Object);\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.assign-through-a-parameter",
    finding: "RWF-110",
    mechanism:
      "`function install(O) { Object.assign(O, { keys: … }); } install(Object)`",
    wrap: `function install(O) { Object.assign(O, { keys: ${F} }); }\ninstall(Object);\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.computed-key-through-a-parameter",
    finding: "RWF-110",
    mechanism:
      '`function install(O, k) { O[k] = …; } install(Object, "keys")` (ADR 0008\'s `protocol_value`)',
    wrap: `function install(O, k) { O[k] = ${F}; }\ninstall(Object, "keys");\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.reflect-set-through-a-parameter",
    finding: "RWF-110",
    mechanism:
      '`function install(O) { Reflect.set(O, "keys", …); } install(Object)`',
    wrap: `function install(O) { Reflect.set(O, "keys", ${F}); }\ninstall(Object);\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.opaque-descriptor-through-a-parameter",
    finding: "RWF-110",
    mechanism:
      '`function install(O, d) { Object.defineProperty(O, "keys", d); } install(Object, { value: … })`',
    wrap: `function install(O, d) { Object.defineProperty(O, "keys", d); }\ninstall(Object, { value: ${F} });\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.this-of-call-object",
    finding: "RWF-110",
    mechanism:
      "`const o = { install() { this.keys = …; } }; o.install.call(Object)`",
    wrap: `const o = { install() { this.keys = ${F}; } };\no.install.call(Object);\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.reflect-get-prototype-of-a-derived-class",
    finding: "RWF-110",
    mechanism: "`class X extends Object {} Reflect.getPrototypeOf(X).keys = …`",
    wrap: `class X extends Object {}\nReflect.getPrototypeOf(X).keys = ${F};\n${KEYS}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.promise-prototype-through-constructor",
    finding: "RWF-110",
    mechanism:
      "`Promise.resolve().constructor.prototype.then = …; Promise.resolve().then(function () {})`",
    wrap:
      `Promise.resolve().constructor.prototype.then = function () { dangerousOp("x"); };\n` +
      `exports.run = safeOp;\nPromise.resolve().then(function () {});\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Kept: one control per proof that an object is the program's own.
  {
    id: "control.object-literal",
    finding: "control",
    mechanism: "`const o = {}; o.keys = …; Object.keys({})`",
    wrap: `const o = {};\no.keys = ${F};\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.exports",
    finding: "control",
    mechanism: "`exports.keys = …` (the CommonJS wrapper's own object)",
    wrap: `exports.keys = ${F};\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.module-exports",
    finding: "control",
    mechanism:
      "`module.exports = { run: safeOp }; module.exports.keys = …` (every store onto `module.exports` is the program's object)",
    wrap: `module.exports = { run: safeOp };\nmodule.exports.keys = ${F};\nObject.keys({});\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.module-top-this",
    finding: "control",
    mechanism:
      "`this.keys = …` at a CommonJS module's top level (its exports object)",
    wrap: `this.keys = ${F};\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.base-class-constructor-this",
    finding: "control",
    mechanism:
      "`class K { constructor() { this.keys = …; } } new K()` (a fresh instance)",
    wrap: `class K { constructor() { this.keys = ${F}; } }\nnew K();\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.static-block-this",
    finding: "control",
    mechanism: "`class S { static { this.keys = …; } }` (the class itself)",
    wrap: `class S { static { this.keys = ${F}; } }\nvoid S;\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.function-object",
    finding: "control",
    mechanism: "`function P() {} P.keys = …` (the function itself)",
    wrap: `function P() {}\nP.keys = ${F};\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.function-prototype",
    finding: "control",
    mechanism:
      "`function P() {} P.prototype.keys = …` (nothing in the file stores another `prototype`)",
    wrap: `function P() {}\nP.prototype.keys = ${F};\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.class-prototype",
    finding: "control",
    mechanism:
      "`class C {} C.prototype.keys = …` (a class's `prototype` is non-writable)",
    wrap: `class C {}\nC.prototype.keys = ${F};\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.base-class-field",
    finding: "control",
    mechanism:
      "`class K { keys = …; } new K()` (a base class's instance is fresh)",
    wrap: `class K { keys = ${F}; }\nnew K();\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "cost.for-of-primitives",
    finding: "control",
    mechanism:
      '`for (Object.keys of ["a"]) {}` (stores a string here, but an iterator may be replaced to yield anything)',
    wrap: `try { for (Object.keys of ["a"]) {} } catch (e) {}\nexports.run = safeOp;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The precision BL-081 gives up: a store onto an object the analyzer
  // cannot prove is the program's own, though here it is.
  {
    id: "cost.es5-constructor-this",
    finding: "control",
    mechanism:
      "`function K() { this.keys = …; } new K()` (a plain function's `this` is its receiver, whatever it is called with)",
    wrap: `function K() { this.keys = ${F}; }\nnew K();\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.parameter-holding-a-literal",
    finding: "control",
    mechanism: "`function set(o) { o.keys = …; } set({})`",
    wrap: `function set(o) { o.keys = ${F}; }\nset({});\n${KEYS}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];
