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
import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";

/**
 * Task A-4 (docs/tasks/A-4-protocol-members.md): implicit invocations of
 * protocol members (PRM-38, PRM-112, PRM-113, and the iterator methods
 * RWF-068 adds) and accessor bodies (PRM-118), each against real Node.
 *
 * One shared LOUD fixture, the one tasks A-0 to A-3b use: `vuln-lib`
 * exports `parse` (the rule's target) and `safe` (its inert sibling), both
 * marked with the `hit()` convention and both declared as bound names.
 *
 * THE VERDICT. A protocol member or an accessor is reached by a POSSIBLE
 * edge from the owner that evaluates its definition (ADR 0008 § 2,
 * Amendment A-0 part B), so the target behind it is `UNKNOWN` -- never
 * `AFFECTED` (no concrete path exists in the graph), never `NOT_AFFECTED`
 * (the code behind the edge is searched). `UNKNOWN` is the only sound
 * verdict for every case here, whether real Node calls the target (the
 * member is invoked) or not (a getter nobody reads).
 *
 * THE CONTROLS. The negative control is the same program with the hook
 * calling `lib.safe` instead -- the possible edge stands, the region
 * behind it is searched and complete, and `parse` is unreachable:
 * `NOT_AFFECTED`. Where the account is an UNKNOWN edge (a value the graph
 * cannot attribute), that would be `UNKNOWN` too, so the negative control
 * drops the store and keeps the function. The positive control is the
 * negative control preceded by one direct `lib.parse("x")`.
 */

export const ADVISORY_ID = "GHSA-a4-protocol-members";
export const TARGET_MARKER = "parse";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

export type Finding =
  | "PRM-38"
  | "PRM-112"
  | "PRM-113"
  | "PRM-118"
  | "RWF-068"
  | "RWF-069"
  | "RWF-070";

export interface A4Case {
  readonly id: string;
  readonly finding: Finding;
  /** One line: the mechanism. */
  readonly mechanism: string;
  /** The application entry, after `const lib = require("vuln-lib");`. `CALL` is the hook's vulnerable call. */
  readonly source: string;
  /** The negative control's source, when it is not `source` with `CALL` calling `lib.safe`. */
  readonly negative?: string;
  /** The entry file (default `src/index.js`); an `.mjs` entry binds `lib` with `import`. */
  readonly entry?: string;
  /** Further project files, `CALL` substituted as in the source. */
  readonly files?: Readonly<Record<string, string>>;
  /** The controls' further files, when they are not `files` with `CALL` calling `lib.safe`. */
  readonly negativeFiles?: Readonly<Record<string, string>>;
  /**
   * Set when the analyzer's live verdict is still wrong, for a reason this
   * task does not own: an open-soundness-defect record, never an
   * expectation (`expected` stays standing).
   */
  readonly openDefect?: {
    readonly rwf: string;
    readonly observed: VerdictObservation;
  };
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /**
   * The analyzer's verdict on the base commit, measured before the fix (the
   * task file records it). `UNKNOWN` for a regression guard added after
   * the audit, whose shape the base already failed closed on.
   */
  readonly base: "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";
  /** The only sound verdict. */
  readonly expected: "UNKNOWN";
}

const PARSE = `lib.parse("x");`;
const SAFE = `lib.safe("x");`;

function project(
  kase: A4Case,
  app: string,
  call: string,
  files: Readonly<Record<string, string>> = kase.files ?? {},
): ProjectSpec {
  const entry = kase.entry ?? "src/index.js";
  const prelude = entry.endsWith(".mjs")
    ? `import lib from "vuln-lib";\n`
    : `const lib = require("vuln-lib");\n`;
  const extra = Object.fromEntries(
    Object.entries(files).map(([file, text]) => [
      file,
      text.replaceAll("CALL", call),
    ]),
  );
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
      ...extra,
      [entry]: prelude + app,
      "vulntrace.yml": simpleConfigFile({ entrypoints: [entry] }),
    },
  };
}

export function sourceOf(kase: A4Case): string {
  return kase.source.replaceAll("CALL", PARSE);
}

export function negativeOf(kase: A4Case): string {
  return (kase.negative ?? kase.source).replaceAll("CALL", SAFE);
}

export function oracleCase(kase: A4Case): OracleCase {
  const negative = negativeOf(kase);
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(kase.entry ?? "src/index.js"),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(
            kase,
            `${PARSE}\n${negative}`,
            SAFE,
            kase.negativeFiles ?? kase.files,
          ),
        },
        negative: {
          name: "negative-control",
          project: project(
            kase,
            negative,
            SAFE,
            kase.negativeFiles ?? kase.files,
          ),
        },
      },
    },
    variant: { name: "case", project: project(kase, sourceOf(kase), PARSE) },
  };
}

const RUN_ASYNC = (body: string): string =>
  `async function main() { ${body} }\nmain();\n`;

// ---------------------------------------------------------------------------
// PRM-38 -- coercion, thenables, the iterator protocol
// ---------------------------------------------------------------------------

export const PROTOCOL_CASES: readonly A4Case[] = [
  {
    id: "coercion.template.toString",
    finding: "PRM-38",
    mechanism: "a template literal coerces an object-literal `toString`",
    source: `const o = { toString() { CALL return "o"; } };\nconst s = \`\${o}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "coercion.plus.valueOf",
    finding: "PRM-38",
    mechanism: "`+` coerces an object-literal `valueOf`",
    source: `const o = { valueOf() { CALL return 1; } };\nconst n = o + 1;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "coercion.unary.toPrimitive",
    finding: "PRM-38",
    mechanism: "unary `+` coerces `[Symbol.toPrimitive]`",
    source: `const o = { [Symbol.toPrimitive]() { CALL return 1; } };\nconst n = +o;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "coercion.class-method.toString",
    finding: "PRM-38",
    mechanism: "string concatenation coerces a class instance's `toString`",
    source: `class C { toString() { CALL return "c"; } }\nconst s = "" + new C();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "coercion.instance-field.toString",
    finding: "PRM-38",
    mechanism: "an instance field holding an arrow, named `toString`, coerced",
    source: `class C { toString = () => { CALL return "c"; }; }\nconst s = "" + new C();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "coercion.computed-key.toString",
    finding: "PRM-38",
    mechanism: 'a method under a computed string key `"toString"`, coerced',
    source: `const k = "toString";\nconst o = { [k]() { CALL return "o"; } };\nconst s = "" + o;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "coercion.store.toString",
    finding: "PRM-38",
    mechanism: "`o.toString = function` stored, then coerced",
    source: `const o = {};\no.toString = function () { CALL return "o"; };\nconst s = "" + o;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "coercion.store.prototype",
    finding: "PRM-38",
    mechanism: "`C.prototype.valueOf = function` stored, then coerced",
    source: `function C() {}\nC.prototype.valueOf = function () { CALL return 1; };\nconst n = new C() * 2;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "coercion.store.opaque-value",
    finding: "PRM-38",
    mechanism:
      "a parameter stored as `toString`: the value cannot be attributed (an unknown edge)",
    source: `function install(target, fn) { target.toString = fn; }\nconst o = {};\ninstall(o, function () { CALL return "o"; });\nconst s = "" + o;\n`,
    negative: `function install(target, fn) { return fn; }\nconst o = {};\ninstall(o, function () { CALL return "o"; });\nconst s = "" + o;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "coercion.store.dynamic-key-opaque",
    finding: "PRM-38",
    mechanism:
      "`o[k] = v` with a key and a value the graph cannot read, then coerced",
    source: `function set(target, k, v) { target[k] = v; }\nconst o = {};\nset(o, "toString", function () { CALL return "o"; });\nconst s = "" + o;\n`,
    negative: `function set(target, k, v) { return v; }\nconst o = {};\nset(o, "toString", function () { CALL return "o"; });\nconst s = "" + o;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "thenable.await",
    finding: "PRM-38",
    mechanism: "`await` calls an object-literal `then`",
    source: RUN_ASYNC(`await { then() { CALL } };`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "thenable.async-return",
    finding: "PRM-38",
    mechanism: "an async function's `return` resolves a thenable",
    source: `const t = { then() { CALL } };\nasync function f() { return t; }\nf();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "thenable.getter-returns-function",
    finding: "PRM-38",
    mechanism:
      "`await` reads a `then` GETTER and calls the function it returns",
    source: RUN_ASYNC(`await { get then() { return function () { CALL }; } };`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "iterator.for-of.generator",
    finding: "PRM-38",
    mechanism: "`for…of` drives a `*[Symbol.iterator]` generator",
    source: `const it = { *[Symbol.iterator]() { yield CALL } };\nfor (const x of it) {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "iterator.spread",
    finding: "PRM-38",
    mechanism: "array spread drives `[Symbol.iterator]`",
    source: `const it = { *[Symbol.iterator]() { yield CALL } };\nconst a = [...it];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "iterator.destructuring",
    finding: "PRM-38",
    mechanism: "array destructuring drives `[Symbol.iterator]`",
    source: `const it = { *[Symbol.iterator]() { yield CALL } };\nconst [a] = it;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "iterator.yield-star",
    finding: "PRM-38",
    mechanism: "`yield*` delegates to `[Symbol.iterator]`",
    source: `const it = { *[Symbol.iterator]() { yield CALL } };\nfunction* g() { yield* it; }\nfor (const x of g()) {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// PRM-112, PRM-113 -- instanceof, for await
// ---------------------------------------------------------------------------

export const SYMBOL_CASES: readonly A4Case[] = [
  {
    id: "hasInstance.instanceof",
    finding: "PRM-112",
    mechanism: "`instanceof` calls a static `[Symbol.hasInstance]`",
    source: `class C { static [Symbol.hasInstance](x) { CALL return false; } }\nconst b = ({}) instanceof C;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "asyncIterator.for-await",
    finding: "PRM-113",
    mechanism: "`for await…of` drives an `async *[Symbol.asyncIterator]`",
    source: RUN_ASYNC(
      `const it = { async *[Symbol.asyncIterator]() { yield CALL } }; for await (const x of it) {}`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// RWF-068 -- the iterator's own methods (next / return / throw)
// ---------------------------------------------------------------------------

export const ITERATOR_METHOD_CASES: readonly A4Case[] = [
  {
    id: "iterator-method.class-next",
    finding: "RWF-068",
    mechanism:
      "`for…of` calls `next` on the class instance `[Symbol.iterator]` returns",
    source: `class It { [Symbol.iterator]() { return this; } next() { CALL return { done: true }; } }\nfor (const x of new It()) {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "iterator-method.literal-next",
    finding: "RWF-068",
    mechanism:
      "`for…of` calls `next` on the object literal `[Symbol.iterator]` returns",
    source: `const it = { [Symbol.iterator]() { return { next() { CALL return { done: true }; } }; } };\nfor (const x of it) {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "iterator-method.return-on-break",
    finding: "RWF-068",
    mechanism: "`break` out of `for…of` calls the iterator's `return`",
    source: `const it = { [Symbol.iterator]() { return { next() { return { value: 1, done: false }; }, return() { CALL return { done: true }; } }; } };\nfor (const x of it) { break; }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// PRM-118 -- accessor bodies
// ---------------------------------------------------------------------------

export const ACCESSOR_CASES: readonly A4Case[] = [
  {
    id: "accessor.literal-getter.unread",
    finding: "PRM-118",
    mechanism: "an object-literal getter nobody reads",
    source: `const o = { get v() { CALL return 1; } };\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "accessor.class-getter.unread",
    finding: "PRM-118",
    mechanism: "a class getter nobody reads",
    source: `class C { get v() { CALL return 1; } }\nconst c = new C();\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "accessor.literal-setter.unwritten",
    finding: "PRM-118",
    mechanism: "an object-literal setter nobody writes",
    source: `const o = { set v(x) { CALL } };\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "accessor.setter-default-parameter",
    finding: "PRM-118",
    mechanism:
      "a setter's default parameter value runs on `set`, never at definition",
    source: `const o = { set v(x = lib.parse("x")) {} };\n`,
    negative: `const o = { set v(x = lib.safe("x")) {} };\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "accessor.literal-getter.read",
    finding: "PRM-118",
    mechanism:
      "an object-literal getter read directly (`o.v`): real Node runs it; a possible edge, so UNKNOWN (the precision cost Amendment A-0 part B accepts)",
    source: `const o = { get v() { CALL return 1; } };\nconst r = o.v;\n`,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// Task A-4's independent audit: a module namespace's exports, a
// registered-symbol key, an accessor's name spelled by an export key,
// and two shapes outside the protocol list
// ---------------------------------------------------------------------------

const INSPECT_BAD = `{ __proto__: null, [Symbol.for("nodejs.util.inspect.custom")]() { CALL return "x"; } }`;

export const AUDIT_CASES: readonly A4Case[] = [
  {
    id: "namespace.export-function.toString",
    finding: "PRM-38",
    mechanism:
      "a template coerces a module namespace whose exported function is named `toString`",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function toString() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.export-function.then",
    finding: "PRM-38",
    mechanism: "`await` of a module namespace calls its exported `then`",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function then() { CALL }\n`,
    },
    source: `import * as ns from "./n.mjs";\nawait ns;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.export-specifier.toString",
    finding: "PRM-38",
    mechanism: "`export { f as toString }`, the namespace coerced",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nfunction f() { CALL return "s"; }\nexport { f as toString };\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = String(ns);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.let-assigned-later",
    finding: "PRM-38",
    mechanism:
      "an exported `let toString` assigned after its declaration (a live binding)",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport let toString;\ntoString = function () { CALL return "s"; };\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.function-reassigned",
    finding: "PRM-38",
    mechanism: "an exported `function toString` whose binding is reassigned",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function toString() { return "a"; }\ntoString = function () { CALL return "s"; };\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.object-pattern",
    finding: "PRM-38",
    mechanism: "`export const { a: toString } = { a: f }`",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nfunction f() { CALL return "s"; }\nexport const { a: toString } = { a: f };\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.array-pattern",
    finding: "PRM-38",
    mechanism: "`export const [toString] = [f]`",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nfunction f() { CALL return "s"; }\nexport const [toString] = [f];\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.assigned-in-function",
    finding: "PRM-38",
    mechanism:
      "an exported `let toString` reassigned inside a function that runs",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport let toString = () => "a";\nfunction set() { toString = function () { CALL return "s"; }; }\nset();\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.then-assigned-later",
    finding: "PRM-38",
    mechanism: "an exported `let then` assigned later, the namespace awaited",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport let then;\nthen = function () { CALL };\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nawait ns;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.var-redeclared",
    finding: "PRM-38",
    mechanism: "an exported `var toString` redeclared with another `var`",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport var toString = () => "a";\nvar toString = function () { CALL return "s"; };\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.for-var-of",
    finding: "PRM-38",
    mechanism:
      "an exported `var toString` written by a `for (var toString of …)` head",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nfunction f() { CALL return "s"; }\nexport var toString;\nfor (var toString of [f]) {}\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.var-in-block",
    finding: "PRM-38",
    mechanism: "an exported `var toString` redeclared inside a block",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport var toString;\n{ var toString = function () { CALL return "s"; }; }\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "namespace.live-binding.var-destructuring",
    finding: "PRM-38",
    mechanism: "an exported `var toString` written by a destructuring `var`",
    entry: "src/index.mjs",
    files: {
      "src/n.mjs": `import lib from "vuln-lib";\nfunction f() { CALL return "s"; }\nexport var toString;\nvar { a: toString } = { a: f };\n`,
    },
    negativeFiles: {
      "src/n.mjs": `import lib from "vuln-lib";\nexport function f() { CALL return "s"; }\n`,
    },
    source: `import * as ns from "./n.mjs";\nconst s = \`\${ns}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "registered-symbol.event-emitter-option",
    finding: "RWF-069",
    mechanism:
      '`new EventEmitter({ captureRejections })` inspects a null-prototype value in its error message, running a `Symbol.for("nodejs.util.inspect.custom")` method',
    source: `const { EventEmitter } = require("events");\nconst bad = ${INSPECT_BAD};\ntry { new EventEmitter({ captureRejections: bad }); } catch (e) {}\n`,
    negative: `const bad = ${INSPECT_BAD};\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "registered-symbol.path-join",
    finding: "RWF-069",
    mechanism:
      '`path.join` (an A-3a admission) inspects a null-prototype argument in its type error, running its `Symbol.for("nodejs.util.inspect.custom")` method',
    source: `const path = require("path");\nconst bad = ${INSPECT_BAD};\ntry { path.join(bad); } catch (e) {}\n`,
    negative: `const bad = ${INSPECT_BAD};\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "accessor.export-key-spells-its-name",
    finding: "PRM-118",
    mechanism:
      "a string export key spelling an accessor node's name (`get x`) roots nothing",
    source: `const o = { get x() { CALL return 1; } };\nmodule.exports["get x"] = 1;\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "species.promise-constructor-store",
    finding: "RWF-070",
    mechanism:
      "`await` reads a promise's `constructor` and constructs the subclass it names (SpeciesConstructor): keys outside ADR 0008's list",
    source: `function exec() {}\nclass Q extends Promise { constructor(ex) { super(ex); CALL } }\nconst x = new Promise(exec);\nx.constructor = Q;\nasync function main() { await x; }\nmain();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: {
      rwf: "RWF-070",
      observed: {
        verdict: "NOT_AFFECTED",
        proofFamily: "C",
        target: "vuln-lib#parse",
        reachableSubgraphComplete: true,
        // The `super(ex)` into `Promise`, in `Q`'s constructor, which no
        // edge reaches: outside the searched region.
        unknownEdges: 1,
      },
    },
  },
];

export const ALL_CASES: readonly A4Case[] = [
  ...PROTOCOL_CASES,
  ...SYMBOL_CASES,
  ...ITERATOR_METHOD_CASES,
  ...ACCESSOR_CASES,
  ...AUDIT_CASES,
];
