import type { E1Case } from "./e1-export-write-set.cases.js";

/**
 * Task BL-075 (docs/tasks/BL-075-builtin-reader-trust.md; ADR 0009 § 1):
 * no builtin is trusted to only read an export object, against real Node.
 *
 * THE MECHANISM. E-1's census took `Object.keys(exports)`, the other
 * `Object` / `Reflect` readers, `Object.prototype.hasOwnProperty.call(
 * exports, …)` and `exports instanceof Object` for reads, unless THIS file
 * replaced the builtin by name. Builtins are shared by every module of the
 * process: this file through a spelling no census sees (`({}).constructor
 * .keys = …`), a sibling, or the entry itself may replace one, and the
 * replacement receives the export object and writes onto it (RWF-104).
 *
 * LOUD FIXTURE. E-1's (`e1-export-write-set.cases.ts`): `vuln-lib` exports
 * `parse` (the rule's target) and `safe`; `wrap/index.js` writes
 * `exports.run = safeOp`, and the replacement writes a `run` calling
 * `parse` onto the object it is handed.
 *
 * THE CONTROLS. E-1's: the negative control writes `exports.run = safeOp`
 * once (`NOT_AFFECTED`); the positive control adds a direct call of
 * `parse` in the entry (`AFFECTED`).
 *
 * `base` is the analyzer's verdict on BL-075's base `0113347` (BL-074's
 * merge), measured. `rwf104.*` with `base: "NOT_AFFECTED"` and `called:
 * true` are the live false `NOT_AFFECTED`s BL-075 closes; `masked.*` were
 * already `UNKNOWN` through the call graph's escape backstop (wrong at the
 * export model, right at the verdict); `cost.*` is the precision BL-075
 * gives up; `control.*` keeps its precision.
 */

/** A sibling or entry prelude: a function calling the target. */
const DANGER =
  `const lib = require("vuln-lib");\n` +
  `function danger(x) { return lib.parse(x); }\n`;

const ENTRY_RUN = `const w = require("wrap");\nw.run("x");\n`;

/** Defines `Object.prototype[Symbol.hasInstance]` without naming `Object`, writing `run` onto its `this`. */
const PATCH = `({}).__proto__[Symbol.hasInstance] = function () { this.run = danger; return false; };\n`;

/** The entry replaces a builtin, keeps what it is handed, and writes `run` onto it once `wrap` is loaded. */
function entryHolds(replacement: string): string {
  return (
    DANGER +
    `let held;\n${replacement}\n` +
    `const w = require("wrap");\nheld.run = danger;\nw.run("x");\n`
  );
}

export const BL075_CASES: readonly E1Case[] = [
  // RWF-104: the recorded same-file spellings.
  {
    id: "rwf104.constructor-of-a-literal",
    finding: "RWF-104",
    mechanism:
      "`({}).constructor.keys = function (o) { o.run = dangerousOp; … }; exports.run = safeOp; Object.keys(exports)`",
    wrap: `({}).constructor.keys = function (o) { o.run = dangerousOp; return []; };\nexports.run = safeOp;\nObject.keys(exports);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf104.constructor-of-exports",
    finding: "RWF-104",
    mechanism:
      "`exports.constructor.keys = function (o) { o.run = dangerousOp; … }; exports.run = safeOp; Object.keys(exports)`",
    wrap: `exports.constructor.keys = function (o) { o.run = dangerousOp; return []; };\nexports.run = safeOp;\nObject.keys(exports);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-104: another module replaces the builtin.
  {
    id: "rwf104.sibling-replaces-by-name",
    finding: "RWF-104",
    mechanism:
      '`require("./patch")` (`Object.keys = function (o) { o.run = danger; … }`); `exports.run = safeOp; Object.keys(exports)`',
    wrap: `require("./patch");\nexports.run = safeOp;\nObject.keys(exports);\n`,
    wrapFiles: {
      "patch.js":
        DANGER + `Object.keys = function (o) { o.run = danger; return []; };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf104.sibling-replaces-through-constructor",
    finding: "RWF-104",
    mechanism:
      '`require("./patch")` (`({}).constructor.keys = …`); `exports.run = safeOp; Object.keys(exports)`',
    wrap: `require("./patch");\nexports.run = safeOp;\nObject.keys(exports);\n`,
    wrapFiles: {
      "patch.js":
        DANGER +
        `({}).constructor.keys = function (o) { o.run = danger; return []; };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf104.entry-replaces-before-loading",
    finding: "RWF-104",
    mechanism:
      "the entry, outside `wrap`'s closure, sets `Object.keys = function (o) { o.run = danger; … }` before loading `wrap`",
    wrap: `exports.run = safeOp;\nObject.keys(exports);\n`,
    app:
      DANGER +
      `Object.keys = function (o) { o.run = danger; return []; };\n` +
      ENTRY_RUN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf104.entry-holds-object-keys",
    finding: "RWF-104",
    mechanism:
      "the entry's `Object.keys` keeps the object it is handed; the entry writes `run` onto it after loading `wrap`",
    wrap: `exports.run = safeOp;\nObject.keys(exports);\n`,
    app: entryHolds(`Object.keys = function (o) { held = o; return []; };`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-112 (BL-075's audit): the export object on the RIGHT of
  // `instanceof` runs its inherited `Symbol.hasInstance` with itself as
  // `this`, and any module may define `Object.prototype[Symbol.hasInstance]`.
  {
    id: "rwf112.sibling-defines-inherited-has-instance",
    finding: "RWF-112",
    mechanism:
      '`require("./patch")` (`({}).__proto__[Symbol.hasInstance] = function () { this.run = danger; … }`); `exports.run = safeOp; ({}) instanceof exports`',
    wrap: `require("./patch");\nexports.run = safeOp;\nif (({}) instanceof exports) {}\n`,
    wrapFiles: { "patch.js": DANGER + PATCH },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf112.sibling-by-name",
    finding: "RWF-112",
    mechanism:
      '`require("./patch")` (`Object.prototype[Symbol.hasInstance] = …`); `exports.run = safeOp; ({}) instanceof exports`',
    wrap: `require("./patch");\nexports.run = safeOp;\nif (({}) instanceof exports) {}\n`,
    wrapFiles: {
      "patch.js":
        DANGER +
        `Object.prototype[Symbol.hasInstance] = function () { this.run = danger; return false; };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf112.entry-before-loading",
    finding: "RWF-112",
    mechanism:
      "the entry defines the inherited `Symbol.hasInstance` before loading `wrap`; `exports.run = safeOp; ({}) instanceof exports`",
    wrap: `exports.run = safeOp;\nif (({}) instanceof exports) {}\n`,
    app: DANGER + PATCH + ENTRY_RUN,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf112.module-exports-literal",
    finding: "RWF-112",
    mechanism:
      '`require("./patch")`; `module.exports = { run: safeOp }; ({}) instanceof module.exports`',
    wrap: `require("./patch");\nmodule.exports = { run: safeOp };\nif (({}) instanceof module.exports) {}\n`,
    wrapFiles: { "patch.js": DANGER + PATCH },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf112.inside-a-function",
    finding: "RWF-112",
    mechanism:
      '`require("./patch")`; `exports.run = safeOp; function check(x) { return x instanceof exports; } check({})`',
    wrap: `require("./patch");\nexports.run = safeOp;\nfunction check(x) { return x instanceof exports; }\ncheck({});\n`,
    wrapFiles: { "patch.js": DANGER + PATCH },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Masked on the base: the call graph answers UNKNOWN (an escape of the
  // export object into a position its builtin table does not admit as
  // non-invoking, or an unsupported receiver), whatever the export model
  // says.
  {
    id: "masked.entry-holds-reflect-reader",
    finding: "RWF-104",
    mechanism: "the same through `Reflect.ownKeys(exports)`",
    wrap: `exports.run = safeOp;\nReflect.ownKeys(exports);\n`,
    app: entryHolds(`Reflect.ownKeys = function (o) { held = o; return []; };`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.entry-holds-prototype-reader",
    finding: "RWF-104",
    mechanism:
      '`Object.prototype.hasOwnProperty.call(exports, "run")` with the entry\'s `hasOwnProperty` keeping its `this`',
    wrap: `exports.run = safeOp;\nObject.prototype.hasOwnProperty.call(exports, "run");\n`,
    app: entryHolds(
      `Object.prototype.hasOwnProperty = function () { held = this; return true; };`,
    ),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.entry-holds-has-instance",
    finding: "RWF-104",
    mechanism:
      "`exports instanceof Object` with the entry's `Object[Symbol.hasInstance]` keeping its argument",
    wrap: `exports.run = safeOp;\nif (exports instanceof Object) {}\n`,
    app: entryHolds(
      `class H { static [Symbol.hasInstance](o) { held = o; return true; } }\n` +
        `Object.defineProperty(Object, Symbol.hasInstance, Object.getOwnPropertyDescriptor(H, Symbol.hasInstance));`,
    ),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.sibling-replaces-define-property",
    finding: "RWF-104",
    mechanism:
      '`require("./patch")` (`Object.defineProperty = function (o) { o.run = danger; … }`); `exports.run = safeOp; Object.defineProperty(exports, "__esModule", …)`',
    wrap: `require("./patch");\nexports.run = safeOp;\nObject.defineProperty(exports, "__esModule", { value: true });\n`,
    wrapFiles: {
      "patch.js":
        DANGER +
        `Object.defineProperty = function (o) { o.run = danger; return o; };\n`,
    },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.entry-holds-assign",
    finding: "RWF-104",
    mechanism:
      "`Object.assign(exports, { version: 1 })` with the entry's `Object.assign` keeping its target",
    wrap: `Object.assign(exports, { version: 1 });\nexports.run = safeOp;\n`,
    app: entryHolds(`Object.assign = function (o) { held = o; return o; };`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.sibling-prototype-accessor",
    finding: "RWF-104",
    mechanism:
      '`require("./patch")` defines an accessor `run` on `Object.prototype`; a plain `exports.run = safeOp` runs its setter',
    wrap: `require("./patch");\nexports.run = safeOp;\n`,
    wrapFiles: {
      "patch.js":
        DANGER +
        `Object.defineProperty(Object.prototype, "run", { get() { return danger; }, set(v) {}, configurable: true });\n`,
    },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // The precision given up: nothing replaces the builtin.
  {
    id: "cost.object-keys-unreplaced",
    finding: "control",
    mechanism:
      "`exports.run = safeOp; Object.keys(exports)`, nothing replacing `Object.keys`",
    wrap: `exports.run = safeOp;\nObject.keys(exports);\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.instanceof-unreplaced",
    finding: "control",
    mechanism:
      "`exports.run = safeOp; exports instanceof Object`, nothing defining `Object[Symbol.hasInstance]`",
    wrap: `exports.run = safeOp;\nif (exports instanceof Object) {}\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.instanceof-right-unreplaced",
    finding: "control",
    mechanism:
      "`exports.run = safeOp; try { ({}) instanceof exports } catch {}`, nothing defining an inherited `Symbol.hasInstance` (Node throws a `TypeError`)",
    wrap: `exports.run = safeOp;\ntry { if (({}) instanceof exports) {} } catch (e) {}\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Kept: a builtin reader handed no export object.
  {
    id: "control.reader-of-another-object",
    finding: "control",
    mechanism: "`exports.run = safeOp; Object.keys({})`",
    wrap: `exports.run = safeOp;\nObject.keys({});\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
