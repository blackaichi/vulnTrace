import type { OracleCase } from "../../src/testing/oracle/case.js";
import {
  simpleConfigFile,
  simplePackageFiles,
  simpleRuleFile,
} from "../../src/testing/oracle/config-files.js";
import { nodeEntryCommand } from "../../src/testing/oracle/ground-truth.js";
import {
  HIT_HELPER_SOURCE,
  hitFunction,
} from "../../src/testing/oracle/hit.js";
import type { ProjectSpec } from "../../src/testing/oracle/project.js";
import { syntheticProvider } from "../../src/testing/oracle/provider.js";

/**
 * Task BL-109 (docs/tasks/BL-109-join-protocol-member.md): a method a
 * builtin invokes on its receiver, by name, from an operation with no call
 * in the program -- against real Node (FINDINGS RWF-151).
 *
 * Coercing an object whose chain reaches `Array.prototype.toString` calls
 * the object's `join`; `JSON.stringify` of one reaching
 * `Date.prototype.toJSON` calls its `toISOString`; coercing one reaching
 * Node's `Buffer.prototype.toString` calls its `utf8Slice`; `for await`
 * over one reaching a Node stream's `Symbol.asyncIterator` calls its `on`.
 * None of the four names was a protocol member, so a definition or store
 * under one got no edge -- nor did a member of a derived class, whose
 * `prototype` inherits such a builtin with no call (`derived.*`, RWF-153,
 * found by BL-109's independent audit). The names are the ones
 * `scripts/bl109-implicit-receiver-methods.mjs` measures, over every
 * prototype and object Node's globals and builtin modules expose.
 *
 * One shared LOUD fixture, task A-4's: `vuln-lib` exports `parse` (the
 * rule's target) and `safe` (its inert sibling), both bound names.
 *
 * THE VERDICT. A protocol member is reached by a POSSIBLE edge from the
 * owner that evaluates its definition (ADR 0008 § 2), so `UNKNOWN` is the
 * one sound verdict for every case, whether real Node calls the target or
 * not.
 *
 * THE CONTROLS are task A-4's: the negative control is the program with
 * the hook calling `lib.safe` -- the possible edge stands, the region
 * behind it is searched and complete, `NOT_AFFECTED`; the positive control
 * is the negative one preceded by one direct `lib.parse("x")`.
 *
 * `base` is the analyzer's verdict on BL-109's base `b256b6d` (BL-094's
 * merge), measured. A case with `base: "NOT_AFFECTED"` and `called: true`
 * is a live false `NOT_AFFECTED` this task closes; `guard.*` were already
 * `UNKNOWN` on the base by another account (the escape row: a store onto
 * an object not proven the program's own, a prototype changed by a call or
 * a `__proto__` store, a derived class), and are kept so that account's
 * loss is caught; `control.*` keep their precision (a `__proto__` proven
 * ordinary); `cost.*` is the precision BL-109 gives up, measured: real Node
 * never calls the target, and the sound verdict the analyzer can give is
 * `UNKNOWN`.
 */

export const ADVISORY_ID = "GHSA-bl109-implicit-receiver-methods";
export const TARGET_MARKER = "parse";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

export type Bl109Verdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

export interface Bl109Case {
  readonly id: string;
  /** The implicitly invoked name. */
  readonly name: "join" | "toISOString" | "utf8Slice" | "on";
  /** One line: the mechanism. */
  readonly mechanism: string;
  /** The application entry, after the `vuln-lib` binding. `CALL` is the hook's vulnerable call. */
  readonly source: string;
  /** The entry file (default `src/index.js`); an `.mjs` entry binds `lib` with `import`. */
  readonly entry?: string;
  /**
   * Why no negative control can be `NOT_AFFECTED` (task H-0's
   * `ControlsDeclaration`): the program fails closed on the base by
   * another account than this task's, whatever the hook calls.
   */
  readonly controlsInapplicable?: string;
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /** The analyzer's verdict on the base commit, measured before the fix. */
  readonly base: Bl109Verdict;
  /**
   * The verdict asserted: `UNKNOWN` wherever the member may be invoked;
   * `NOT_AFFECTED` for a `control.*` whose prototype is proven ordinary.
   */
  readonly expected: Bl109Verdict;
}

const PARSE = `lib.parse("x");`;
const SAFE = `lib.safe("x");`;

function project(kase: Bl109Case, app: string): ProjectSpec {
  const entry = kase.entry ?? "src/index.js";
  const prelude = entry.endsWith(".mjs")
    ? `import lib from "vuln-lib";\n`
    : `const lib = require("vuln-lib");\n`;
  return {
    files: {
      ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/vuln-lib/index.js": LIB_SOURCE,
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      [entry]: prelude + app,
      "vulntrace.yml": simpleConfigFile({ entrypoints: [entry] }),
    },
  };
}

export function oracleCase(kase: Bl109Case): OracleCase {
  const negative = kase.source.replaceAll("CALL", SAFE);
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(kase.entry ?? "src/index.js"),
    controls:
      kase.controlsInapplicable !== undefined
        ? { kind: "inapplicable", reason: kase.controlsInapplicable }
        : {
            kind: "controls",
            controls: {
              positive: {
                name: "positive-control",
                project: project(kase, `${PARSE}\n${negative}`),
              },
              negative: {
                name: "negative-control",
                project: project(kase, negative),
              },
            },
          },
    variant: {
      name: "case",
      project: project(kase, kase.source.replaceAll("CALL", PARSE)),
    },
  };
}

/** A `join` that runs the hook; a stored or defined value of the case. */
const JOIN_FN = `function () { CALL return ""; }`;

/** `for await` over `s`, its rejection caught: the fake stream has no state. */
const FOR_AWAIT = `async function main() { try { for await (const c of s) break; } catch {} }\nmain();\n`;

export const BL109_CASES: readonly Bl109Case[] = [
  // -------------------------------------------------------------------------
  // `join`: `Array.prototype.toString` (RWF-151's record)
  // -------------------------------------------------------------------------
  {
    id: "join.store.String",
    name: "join",
    mechanism: "`a.join = f` on an array literal, `String(a)`",
    source: `const a = [];\na.join = ${JOIN_FN};\nString(a);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.plus",
    name: "join",
    mechanism: '`a.join = f` on an array literal, `"" + a`',
    source: `const a = [];\na.join = ${JOIN_FN};\nconst s = "" + a;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.template",
    name: "join",
    mechanism: "`a.join = f` on an array literal, a template literal",
    source: `const a = [];\na.join = ${JOIN_FN};\nconst s = \`\${a}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.Math-max",
    name: "join",
    mechanism: "`a.join = f`, `Math.max(a)` (an admitted builtin position)",
    source: `const a = [];\na.join = ${JOIN_FN};\nMath.max(a);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.loose-equality",
    name: "join",
    mechanism: "`a.join = f`, `a == 1`",
    source: `const a = [];\na.join = ${JOIN_FN};\nconst b = a == 1;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.computed-key",
    name: "join",
    mechanism: "`a.join = f`, `{ [a]: 1 }`",
    source: `const a = [];\na.join = ${JOIN_FN};\nconst o = { [a]: 1 };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.outer-array",
    name: "join",
    mechanism: "`a.join = f`, an outer array `[a]` coerced",
    source: `const a = [];\na.join = ${JOIN_FN};\nconst s = "" + [a];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.element-key",
    name: "join",
    mechanism: '`a["join"] = f`, coerced',
    source: `const a = [];\na["join"] = ${JOIN_FN};\nString(a);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.declaration",
    name: "join",
    mechanism: "a function declaration stored as `join`, coerced",
    source: `function j() { CALL return ""; }\nconst a = [];\na.join = j;\nString(a);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.in-function",
    name: "join",
    mechanism: "the store made inside a called function, coerced outside",
    source: `const a = [];\nfunction g() { a.join = ${JOIN_FN}; }\ng();\nString(a);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.function-prototype",
    name: "join",
    mechanism: "`A.prototype = []`, `A.prototype.join = f`, `String(new A())`",
    source: `function A() {}\nA.prototype = [];\nA.prototype.join = ${JOIN_FN};\nString(new A());\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.store.esm",
    name: "join",
    mechanism: "`a.join = f` in an ES module, coerced",
    entry: "src/index.mjs",
    source: `const a = [];\na.join = ${JOIN_FN};\nString(a);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.literal.method",
    name: "join",
    mechanism: "`{ __proto__: [], join() {} }`, coerced",
    source: `const o = { __proto__: [], join() { CALL return ""; } };\nString(o);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.literal.value",
    name: "join",
    mechanism: "`{ __proto__: Array.prototype, join: f }`, coerced",
    source: `const o = { __proto__: Array.prototype, join: ${JOIN_FN} };\nconst s = "" + o;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "join.literal.function-prototype",
    name: "join",
    mechanism: '`A.prototype = { __proto__: [], join() {} }`, `"" + new A()`',
    source: `function A() {}\nA.prototype = { __proto__: [], join() { CALL return ""; } };\nconst s = "" + new A();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "guard.join.class-prototype-store",
    name: "join",
    mechanism:
      "a plain class's `join` method on an instance whose prototype is set to an array's",
    source: `class C { join() { CALL return ""; } }\nC.prototype.__proto__ = [];\nString(new C());\n`,
    controlsInapplicable:
      "`C.prototype.__proto__ = []` is an escape on the base (`escaped_value`), an unknown edge whatever the hook calls",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.join.typed-array-store",
    name: "join",
    mechanism:
      "`t.join = f` on `new Uint8Array(1)`, coerced: a builtin's result, an escape",
    source: `const t = new Uint8Array(1);\nt.join = ${JOIN_FN};\nString(t);\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.join.derived-class",
    name: "join",
    mechanism: "`class A extends Array { join() {} }`, coerced",
    source: `class A extends Array { join() { CALL return ""; } }\nString(new A());\n`,
    controlsInapplicable:
      "the class's inherited constructor or prototype write is an escape on the base (`escaped_value`), an unknown edge whatever the hook calls",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // -------------------------------------------------------------------------
  // `toISOString`: `Date.prototype.toJSON` under `JSON.stringify`
  // -------------------------------------------------------------------------
  {
    id: "toISOString.literal.method",
    name: "toISOString",
    mechanism:
      "`{ __proto__: Date.prototype, valueOf, toISOString() {} }`, `JSON.stringify`",
    source: `const d = { __proto__: Date.prototype, valueOf() { return 1; }, toISOString() { CALL return ""; } };\nJSON.stringify(d);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "toISOString.literal.nested",
    name: "toISOString",
    mechanism: "the same object as a property value, `JSON.stringify({ d })`",
    source: `const d = { __proto__: Date.prototype, valueOf() { return 1; }, toISOString: ${JOIN_FN} };\nJSON.stringify({ d });\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "guard.toISOString.store",
    name: "toISOString",
    mechanism: "`o.toISOString = f` on a literal inheriting `Date.prototype`",
    source: `const d = { __proto__: Date.prototype, valueOf() { return 1; } };\nd.toISOString = ${JOIN_FN};\nJSON.stringify(d);\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.toISOString.derived-class",
    name: "toISOString",
    mechanism:
      "`class D extends Date { toISOString() {} }`, `JSON.stringify(new D(0))`",
    source: `class D extends Date { toISOString() { CALL return ""; } }\nJSON.stringify(new D(0));\n`,
    controlsInapplicable:
      "the class's inherited constructor or prototype write is an escape on the base (`escaped_value`), an unknown edge whatever the hook calls",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // -------------------------------------------------------------------------
  // `utf8Slice`: Node's `Buffer.prototype.toString` on coercion
  // -------------------------------------------------------------------------
  {
    id: "utf8Slice.literal.method",
    name: "utf8Slice",
    mechanism:
      "`{ __proto__: Buffer.prototype, length: 0, utf8Slice() {} }`, coerced",
    source: `const b = { __proto__: Buffer.prototype, length: 0, utf8Slice() { CALL return ""; } };\nString(b);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // -------------------------------------------------------------------------
  // `on`: a Node stream's `Symbol.asyncIterator` under `for await`
  // -------------------------------------------------------------------------
  {
    id: "on.literal.method",
    name: "on",
    mechanism:
      "`{ __proto__: stream.Readable.prototype, on() {} }`, `for await`",
    source: `const { Readable } = require("stream");\nconst s = { __proto__: Readable.prototype, on() { CALL return this; } };\n${FOR_AWAIT}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "on.literal.instance-proto.read",
    name: "on",
    mechanism: "`{ __proto__: new Readable(), read() {} }`, `for await`",
    source: `const { Readable } = require("stream");\nconst s = { __proto__: new Readable(), read() { CALL return null; } };\n${FOR_AWAIT}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "on.literal.alias-proto.destroy",
    name: "on",
    mechanism:
      "`const r = new Readable(); { __proto__: r, destroy() {} }`, `for await`",
    source: `const { Readable } = require("stream");\nconst r = new Readable();\nconst s = { __proto__: r, destroy() { CALL return this; } };\n${FOR_AWAIT}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "guard.on.setPrototypeOf.read",
    name: "on",
    mechanism:
      "`const s = { read() {} }; Object.setPrototypeOf(s, new Readable())`, `for await`",
    source: `const { Readable } = require("stream");\nconst s = { read() { CALL return null; } };\nObject.setPrototypeOf(s, new Readable());\n${FOR_AWAIT}`,
    controlsInapplicable:
      "the prototype change is an escape on the base (`escaped_value`), an unknown edge whatever the hook calls",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.on.proto-store.read",
    name: "on",
    mechanism:
      "`const s = { read() {} }; s.__proto__ = new Readable()`, `for await`",
    source: `const { Readable } = require("stream");\nconst s = { read() { CALL return null; } };\ns.__proto__ = new Readable();\n${FOR_AWAIT}`,
    controlsInapplicable:
      "the prototype change is an escape on the base (`escaped_value`), an unknown edge whatever the hook calls",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.on.function-prototype.read",
    name: "on",
    mechanism:
      "`A.prototype = new Readable(); A.prototype.read = f`, `for await` over `new A()`",
    source: `const { Readable } = require("stream");\nfunction A() {}\nA.prototype = new Readable();\nA.prototype.read = function () { CALL return null; };\nconst s = new A();\n${FOR_AWAIT}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.on.class-setPrototypeOf.read",
    name: "on",
    mechanism:
      "a class's `read`, `Object.setPrototypeOf(C.prototype, new Readable())`, `for await`",
    source: `const { Readable } = require("stream");\nclass C { read() { CALL return null; } }\nObject.setPrototypeOf(C.prototype, new Readable());\nconst s = new C();\n${FOR_AWAIT}`,
    controlsInapplicable:
      "the prototype change is an escape on the base (`escaped_value`), an unknown edge whatever the hook calls",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.join.setPrototypeOf",
    name: "join",
    mechanism:
      "`const o = { join() {} }; Object.setPrototypeOf(o, [])`, coerced",
    source: `const o = { join() { CALL return ""; } };\nObject.setPrototypeOf(o, []);\nString(o);\n`,
    controlsInapplicable:
      "the prototype change is an escape on the base (`escaped_value`), an unknown edge whatever the hook calls",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.toISOString.setPrototypeOf",
    name: "toISOString",
    mechanism:
      "`const d = { valueOf, toISOString() {} }; Object.setPrototypeOf(d, Date.prototype)`, `JSON.stringify`",
    source: `const d = { valueOf() { return 1; }, toISOString() { CALL return ""; } };\nObject.setPrototypeOf(d, Date.prototype);\nJSON.stringify(d);\n`,
    controlsInapplicable:
      "the prototype change is an escape on the base (`escaped_value`), an unknown edge whatever the hook calls",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.on.constructor-this.read",
    name: "on",
    mechanism:
      "`this.read = f` in `A`, `A.prototype = { __proto__: new Readable() }`, `for await` over `new A()`",
    source: `const { Readable } = require("stream");\nfunction A() { this.read = function () { CALL return null; }; }\nA.prototype = { __proto__: new Readable() };\nconst s = new A();\n${FOR_AWAIT}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.join.constructor-this",
    name: "join",
    mechanism: "`this.join = f` in `A`, `A.prototype = []`, `String(new A())`",
    source: `function A() { this.join = ${JOIN_FN}; }\nA.prototype = [];\nString(new A());\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "guard.on.class-constructor-this.read",
    name: "on",
    mechanism:
      "`this.read = f` in a class constructor, `C.prototype` changed to a stream's",
    source: `const { Readable } = require("stream");\nclass C { constructor() { this.read = function () { CALL return null; }; } }\nObject.setPrototypeOf(C.prototype, new Readable());\nconst s = new C();\n${FOR_AWAIT}`,
    controlsInapplicable:
      "the prototype change is an escape on the base (`escaped_value`), an unknown edge whatever the hook calls",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // -------------------------------------------------------------------------
  // Precision: a prototype proven ordinary, and what the change gives up
  // -------------------------------------------------------------------------
  {
    id: "control.proto-null.read",
    name: "on",
    mechanism:
      "`{ __proto__: null, read() {} }`, `for await`: no builtin in the chain",
    source: `const s = { __proto__: null, read() { CALL return null; } };\n${FOR_AWAIT}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "cost.join.proto-literal",
    name: "join",
    mechanism:
      "`{ __proto__: { a: 1 }, join() {} }`, coerced: `Object.prototype` calls no `join`",
    source: `const o = { __proto__: { a: 1 }, join() { CALL return ""; } };\nconst s = "" + o;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.join.class-method",
    name: "join",
    mechanism:
      "a plain class's `join`, its instance coerced: `Object.prototype.toString` runs",
    source: `class P { join() { CALL return ""; } }\nconst s = "" + new P();\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.join.object-method",
    name: "join",
    mechanism: "an object literal's `join`, never coerced through an array",
    source: `const path = { join() { CALL return ""; } };\nconst s = "" + path;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.proto-ambient.method",
    name: "on",
    mechanism:
      "`{ __proto__: Object.prototype, m() {} }`, coerced: an ambient prototype is not proven ordinary",
    source: `const o = { __proto__: Object.prototype, m() { CALL return ""; } };\nconst s = "" + o;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "control.proto-literal.read",
    name: "on",
    mechanism:
      "`{ __proto__: { a: 1 }, read() {} }`, `for await`: a plain literal's chain calls no `read`",
    source: `const s = { __proto__: { a: 1 }, read() { CALL return null; } };\n${FOR_AWAIT}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "derived.toISOString.prototype-stringified",
    name: "toISOString",
    mechanism:
      "`class D extends Date { valueOf, toISOString() {} }`, `JSON.stringify(D.prototype)`",
    source: `class D extends Date { valueOf() { return 1; } toISOString() { CALL return ""; } }\nJSON.stringify(D.prototype);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "derived.on.prototype-for-await",
    name: "on",
    mechanism:
      "`class S extends Readable { on() {} }`, `for await` over `S.prototype`",
    source: `const { Readable } = require("stream");\nclass S extends Readable { on() { CALL return this; } }\nconst s = S.prototype;\n${FOR_AWAIT}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "derived.utf8Slice.proto-literal",
    name: "utf8Slice",
    mechanism:
      "`class B extends Buffer { utf8Slice() {} }`, `{ __proto__: B.prototype, length: 0 }` coerced",
    source: `class B extends Buffer { utf8Slice() { CALL return ""; } }\nconst o = { __proto__: B.prototype, length: 0 };\nString(o);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "derived.toISOString.nested-esm",
    name: "toISOString",
    mechanism:
      "the same in an ES module, `JSON.stringify({ when: D.prototype })`",
    entry: "src/index.mjs",
    source: `class D extends Date { valueOf() { return 1; } toISOString() { CALL return ""; } }\nconst s = JSON.stringify({ when: D.prototype });\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "derived.toISOString.static-block",
    name: "toISOString",
    mechanism:
      "`JSON.stringify(this.prototype)` in the derived class's own static block",
    source: `class D extends Date { valueOf() { return 1; } static { JSON.stringify(this.prototype); } toISOString() { CALL return ""; } }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "control.extends-null.toISOString",
    name: "toISOString",
    mechanism:
      "`class N extends null { toISOString() {} }`, `JSON.stringify(N.prototype)`: no builtin in the chain",
    source: `class N extends null { toISOString() { CALL return ""; } }\nJSON.stringify(N.prototype);\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "cost.derived-from-program-class.method",
    name: "on",
    mechanism:
      "`class B {} class D extends B { m() {} }`, `D.prototype` coerced: no builtin calls `m`",
    source: `class B {}\nclass D extends B { m() { CALL return ""; } }\nconst s = "" + D.prototype;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];
