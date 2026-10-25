import ts from "typescript";
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
import { compileTypeScript } from "../../src/testing/oracle/typescript-compile.js";
import type { CaseVerdict, E1Case } from "./e1-export-write-set.cases.js";

/**
 * Task BL-091 (docs/tasks/BL-091-builtin-store-reaudit.md; ADR 0008's
 * decision record "BL-081"): the re-audit of BL-081's rule -- a store is an
 * escape unless the object it writes onto is proven to be the program's
 * own (`isProvenFreshObject`, `escape-row.ts`) -- against real Node.
 *
 * LOUD FIXTURE AND CONTROLS. E-1's, as in
 * `bl081-builtin-replaced-without-name.cases.ts`: `wrap/index.js` defines
 * `dangerousOp` (calls the target `parse`) and `safeOp`, and exports
 * `run = safeOp`; the replacement calls `dangerousOp`, and nothing else
 * does.
 *
 * `base` is the analyzer's verdict on BL-091's base `5de4893` (BL-081's
 * merge), measured. `rwf124.*`, `rwf126.*`, `rwf127.*` and `rwf128.*`
 * with `base: "NOT_AFFECTED"` and `called: true` are the live false
 * `NOT_AFFECTED`s this task closes; `masked.*` were already `UNKNOWN`
 * through another account; `control.*` keep their precision; `cost.*` is
 * precision this task gives up.
 */

const BUFFER = `{ isBuffer: function (x) { dangerousOp(x); return false; } }`;
const TAIL = `exports.run = safeOp;\nBuffer.isBuffer(1);\n`;
const ESM_TAIL = `export const run = function (x) { return safeOp(x); };\nBuffer.isBuffer(1);\n`;

const SORTED = `{ sorted: function (a, b) { dangerousOp(a); return 0; } }`;
const INSPECT_HEAD = `const util = require("util");\n`;
const INSPECT_TAIL = `util.inspect({ b: 1, a: 2 });\nexports.run = safeOp;\n`;

export const BL091_CASES: readonly E1Case[] = [
  // RWF-124 (the re-audit's first round, F1): a derived class's
  // `prototype` inherits from its base's, which a store onto a fresh
  // function can make the global object; the global object's own
  // setters then install what is stored as the builtin.
  {
    id: "rwf124.derived-class-prototype-inherits-the-global-object",
    finding: "RWF-124",
    mechanism:
      "`X.prototype = globalThis; class C extends X {} C.prototype.Buffer = …`, then `Buffer.isBuffer(1)`",
    wrap: `function X() {}\nX.prototype = globalThis;\nclass C extends X {}\nC.prototype.Buffer = ${BUFFER};\n${TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf124.derived-class-prototype-through-an-alias",
    finding: "RWF-124",
    mechanism:
      "`class C extends X {} const p = C.prototype; p.Buffer = …` with `X.prototype = globalThis`",
    wrap: `function X() {}\nX.prototype = globalThis;\nclass C extends X {}\nconst p = C.prototype;\np.Buffer = ${BUFFER};\n${TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf124.derived-class-expression-prototype",
    finding: "RWF-124",
    mechanism:
      "`const C = class extends X {}; C.prototype.Buffer = …` with `X.prototype = globalThis`",
    wrap: `function X() {}\nX.prototype = globalThis;\nconst C = class extends X {};\nC.prototype.Buffer = ${BUFFER};\n${TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf124.derived-class-of-a-function-expression",
    finding: "RWF-124",
    mechanism:
      "`const X = function () {}; X.prototype = globalThis; class C extends X {}`",
    wrap: `const X = function () {};\nX.prototype = globalThis;\nclass C extends X {}\nC.prototype.Buffer = ${BUFFER};\n${TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf124.derived-class-with-a-static-member",
    finding: "RWF-124",
    mechanism:
      "`class C extends X { static m() {} }`, then `C.prototype.Buffer = …`",
    wrap: `function X() {}\nX.prototype = globalThis;\nclass C extends X { static m() {} }\nC.prototype.Buffer = ${BUFFER};\n${TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf124.function-prototype-set-to-a-derived-class-prototype",
    finding: "RWF-124",
    mechanism:
      "`function F() {} F.prototype = C.prototype; F.prototype.Buffer = …` (one proof further on)",
    wrap: `function X() {}\nX.prototype = globalThis;\nclass C extends X {}\nfunction F() {}\nF.prototype = C.prototype;\nF.prototype.Buffer = ${BUFFER};\n${TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "masked.derived-class-of-a-loaded-function",
    finding: "RWF-124",
    mechanism:
      '`const X = require("./x"); class C extends X {}` where `x.js` sets `X.prototype = globalThis`',
    wrap: `const X = require("./x");\nclass C extends X {}\nC.prototype.Buffer = ${BUFFER};\n${TAIL}`,
    wrapFiles: {
      "x.js": `function X() {}\nX.prototype = globalThis;\nmodule.exports = X;\n`,
    },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "rwf124.derived-class-of-a-parameter",
    finding: "RWF-124",
    mechanism:
      "`function mk(X) { class C extends X {} C.prototype.Buffer = …; } mk(X)`: the base is not visible at the class",
    wrap: `function mk(X) { class C extends X {} C.prototype.Buffer = ${BUFFER}; }\nfunction X() {}\nX.prototype = globalThis;\nmk(X);\n${TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf124.esm-derived-class-prototype",
    finding: "RWF-124",
    mechanism: "the first case in an ES module",
    wrap: `function X() {}\nX.prototype = globalThis;\nclass C extends X {}\nC.prototype.Buffer = ${BUFFER};\n${ESM_TAIL}`,
    esm: true,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf124.esm-exported-derived-class-prototype",
    finding: "RWF-124",
    mechanism: "`export class C extends X {}`, then `C.prototype.Buffer = …`",
    wrap: `function X() {}\nX.prototype = globalThis;\nexport class C extends X {}\nC.prototype.Buffer = ${BUFFER};\n${ESM_TAIL}`,
    esm: true,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The proof a base class keeps: its `prototype` inherits from
  // `Object.prototype`, never from what the program stores.
  {
    id: "control.base-class-prototype",
    finding: "RWF-124",
    mechanism:
      "`class C {} C.prototype.Buffer = …`: a base class's `prototype` is the program's own",
    wrap: `function X() {}\nX.prototype = globalThis;\nclass C {}\nC.prototype.Buffer = ${BUFFER};\n${TAIL}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // Precision given up: a derived class's `prototype` is not proven the
  // program's own, even when its base's `prototype` is.
  {
    id: "cost.derived-class-of-a-plain-prototype",
    finding: "RWF-124",
    mechanism:
      "`X.prototype = {}; class C extends X {} C.prototype.Buffer = …`: Node keeps the member on `C.prototype`",
    wrap: `function X() {}\nX.prototype = {};\nclass C extends X {}\nC.prototype.Buffer = ${BUFFER};\n${TAIL}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-126 (the re-audit's second round, G1): a derived class's static
  // side inherits from its base constructor, which may be a builtin with an
  // accessor: `class D extends util.inspect {} D.defaultOptions = …` runs
  // Node's own setter and installs Node's inspect defaults.
  {
    id: "rwf126.derived-of-util-inspect-static-store",
    finding: "RWF-126",
    mechanism:
      "`class D extends util.inspect {} D.defaultOptions = { sorted: f }`, then `util.inspect({b:1,a:2})`",
    wrap: `${INSPECT_HEAD}class D extends util.inspect {}\nD.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.derived-static-block-this",
    finding: "RWF-126",
    mechanism: "the same through `this` in a static block of the derived class",
    wrap: `${INSPECT_HEAD}class D extends util.inspect { static { this.defaultOptions = ${SORTED}; } }\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.derived-class-expression",
    finding: "RWF-126",
    mechanism: "the same through a class expression bound to a const",
    wrap: `${INSPECT_HEAD}const D = class extends util.inspect {};\nD.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.derived-through-an-intermediate-user-class",
    finding: "RWF-126",
    mechanism: "`class B extends util.inspect {} class D extends B {}`",
    wrap: `${INSPECT_HEAD}class B extends util.inspect {}\nclass D extends B {}\nD.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.derived-of-an-alias",
    finding: "RWF-126",
    mechanism: "`const U = util.inspect; class D extends U {}`",
    wrap: `${INSPECT_HEAD}const U = util.inspect;\nclass D extends U {}\nD.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.esm-derived-of-an-imported-function",
    finding: "RWF-126",
    mechanism:
      "`import { inspect } from 'node:util'; class D extends inspect {}`",
    wrap: `import { inspect } from "node:util";\nclass D extends inspect {}\nD.defaultOptions = ${SORTED};\ninspect({ b: 1, a: 2 });\nexport const run = function (x) { return safeOp(x); };\n`,
    esm: true,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.function-prototype-set-to-a-derived-class-expression",
    finding: "RWF-126",
    mechanism:
      "`function F() {} F.prototype = class extends util.inspect {}; F.prototype.defaultOptions = …` (one proof further on)",
    wrap: `${INSPECT_HEAD}function F() {}\nF.prototype = class extends util.inspect {};\nF.prototype.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.chained-assignment-of-a-derived-class-expression",
    finding: "RWF-126",
    mechanism: "`(D = class extends util.inspect {}).defaultOptions = …`",
    wrap: `${INSPECT_HEAD}let D;\n(D = class extends util.inspect {}).defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.direct-derived-class-expression",
    finding: "RWF-126",
    mechanism: "`(class extends util.inspect {}).defaultOptions = …`",
    wrap: `${INSPECT_HEAD}(class extends util.inspect {}).defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.mixin-static-block",
    finding: "RWF-126",
    mechanism:
      "`const Mix = (Base) => class extends Base { static { this.defaultOptions = …; } }; class Z extends Mix(util.inspect) {}`",
    wrap: `${INSPECT_HEAD}const Mix = (Base) => class extends Base { static { this.defaultOptions = ${SORTED}; } };\nclass Z extends Mix(util.inspect) {}\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.conditional-extends",
    finding: "RWF-126",
    mechanism: "`class D extends (c ? util.inspect : Object) {}`",
    wrap: `${INSPECT_HEAD}const c = process.argv.length > 0;\nclass D extends (c ? util.inspect : Object) {}\nD.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf126.extends-a-call-result",
    finding: "RWF-126",
    mechanism:
      "`function mk() { return util.inspect; } class D extends mk() {}`",
    wrap: `${INSPECT_HEAD}function mk() { return util.inspect; }\nclass D extends mk() {}\nD.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The proofs a derived class keeps: its base is the program's own.
  {
    id: "control.direct-store-onto-util-inspect",
    finding: "RWF-126",
    mechanism:
      "`util.inspect.defaultOptions = { sorted: f }`: the escape row's builtin root",
    wrap: `${INSPECT_HEAD}util.inspect.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "control.derived-of-a-user-class",
    finding: "RWF-126",
    mechanism:
      "`class B {} class D extends B {} D.defaultOptions = …`: the base is the program's own, so Node keeps the member on D",
    wrap: `${INSPECT_HEAD}class B {}\nclass D extends B {}\nD.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.derived-of-a-user-function",
    finding: "RWF-126",
    mechanism: "`function B() {} class D extends B {} D.defaultOptions = …`",
    wrap: `${INSPECT_HEAD}function B() {}\nclass D extends B {}\nD.defaultOptions = ${SORTED};\n${INSPECT_TAIL}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "cost.derived-of-an-ambient-constructor-other-key",
    finding: "RWF-126",
    mechanism:
      "`class D extends Map {} D.k = …`: Node keeps the member on D; the base is not the program's own, so the store is an escape",
    wrap: `${INSPECT_HEAD}class D extends Map {}\nD.k = ${SORTED};\n${INSPECT_TAIL}`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

/**
 * RWF-127 and RWF-128 (the re-audit's third round, H1 and H2): TypeScript
 * sources, whose emit runs a class differently from the source the
 * analyzer reads. The ground truth runs the source compiled by the
 * repository's own TypeScript (`src/testing/oracle/typescript-compile.ts`)
 * at the case's target. The controls, as task A-1's: the positive control
 * prefixes a direct `lib.parse("x")`; the negative control is the case
 * with the stored function calling `lib.safe` instead of `lib.parse`.
 */
export interface Bl091TypeScriptCase {
  readonly id: string;
  readonly finding: string;
  readonly mechanism: string;
  /** The program after `import lib = require("vuln-lib");`; `HOOK` names the export the stored function calls. */
  readonly program: (hook: "parse" | "safe") => string;
  /** The compile target: `es2020` emits a class field as an assignment, `es5` a class as a function. */
  readonly target: "es5" | "es2020" | "es2022";
  readonly called: boolean;
  readonly base: CaseVerdict;
  readonly expected: CaseVerdict;
}

export const TS_ADVISORY_ID = "GHSA-bl091-typescript-emit";

const TS_LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

const TS_TARGETS: Record<Bl091TypeScriptCase["target"], ts.ScriptTarget> = {
  es5: ts.ScriptTarget.ES5,
  es2020: ts.ScriptTarget.ES2020,
  es2022: ts.ScriptTarget.ES2022,
};

function typeScriptProject(
  kase: Bl091TypeScriptCase,
  body: string,
): ProjectSpec {
  const source = `import lib = require("vuln-lib");\n${body}export {};\n`;
  const options: ts.CompilerOptions = { target: TS_TARGETS[kase.target] };
  return {
    files: {
      ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/vuln-lib/index.js": TS_LIB_SOURCE,
      "rules.yml": simpleRuleFile({
        id: TS_ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "commonjs", target: kase.target },
      }),
      "src/index.ts": source,
      "dist/index.js": compileTypeScript(source, "index.ts", options),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.ts"] }),
    },
  };
}

export function typeScriptOracleCase(kase: Bl091TypeScriptCase): OracleCase {
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: TS_ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand("dist/index.js"),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: typeScriptProject(
            kase,
            `lib.parse("x");\n` + kase.program("safe"),
          ),
        },
        negative: {
          name: "negative-control",
          project: typeScriptProject(kase, kase.program("safe")),
        },
      },
    },
    variant: {
      name: "case",
      project: typeScriptProject(kase, kase.program("parse")),
    },
  };
}

const sorted = (hook: string) =>
  `{ sorted: function (a: any, b: any) { lib.${hook}(a); return 0; } } as any`;
const isBuffer = (hook: string) =>
  `{ isBuffer: function (x: any) { lib.${hook}(x); return false; } }`;

export const BL091_TYPESCRIPT_CASES: readonly Bl091TypeScriptCase[] = [
  // RWF-127 (H1): below target ES2022 (`useDefineForClassFields: false`)
  // a static field compiles to an assignment after the class, which runs
  // a setter the class inherits from its base constructor.
  {
    id: "rwf127.static-field-of-a-class-derived-from-util-inspect",
    finding: "RWF-127",
    mechanism:
      "`class D extends util.inspect { static defaultOptions = … }` at target ES2020: `D.defaultOptions = …` runs the inherited setter",
    program: (hook) =>
      `import util = require("util");\nclass D extends util.inspect { static defaultOptions = ${sorted(hook)}; }\nutil.inspect({ b: 1, a: 2 });\n`,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf127.static-field-of-a-derived-class-expression",
    finding: "RWF-127",
    mechanism: "`const D = class extends (util.inspect as any) { static … }`",
    program: (hook) =>
      `import util = require("util");\nconst D = class extends (util.inspect as any) { static defaultOptions = ${sorted(hook)}; };\nutil.inspect({ b: 1, a: 2 });\n`,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf127.static-field-with-the-base-through-a-variable",
    finding: "RWF-127",
    mechanism: "`const Base = util.inspect; class D extends Base { static … }`",
    program: (hook) =>
      `import util = require("util");\nconst Base = util.inspect;\nclass D extends Base { static defaultOptions = ${sorted(hook)}; }\nutil.inspect({ b: 1, a: 2 });\n`,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "control.static-field-of-a-base-class",
    finding: "RWF-127",
    mechanism:
      "`class D { static defaultOptions = … }`: a base class inherits from `Function.prototype`",
    program: (hook) =>
      `import util = require("util");\nclass D { static defaultOptions = ${sorted(hook)}; }\nutil.inspect({ b: 1, a: 2 });\n`,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // Task BL-109 (RWF-153, the project owner's decision of 2026-10-25):
  // every member of a derived class is a protocol member, whatever its
  // base, so this control is a measured precision cost since BL-109.
  {
    id: "cost.static-field-of-a-class-derived-from-the-programs-own",
    finding: "RWF-127",
    mechanism:
      "`class B {} class D extends B { static defaultOptions = … }`: since BL-109 a derived class's members are protocol members",
    program: (hook) =>
      `import util = require("util");\nclass B {}\nclass D extends B { static defaultOptions = ${sorted(hook)}; }\nutil.inspect({ b: 1, a: 2 });\n`,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.static-field-of-a-derived-class-under-define-semantics",
    finding: "RWF-127",
    mechanism:
      "the first case at target ES2022: the field is defined on `D`, no setter runs; the analyzer does not read the target",
    program: (hook) =>
      `import util = require("util");\nclass D extends util.inspect { static defaultOptions = ${sorted(hook)}; }\nutil.inspect({ b: 1, a: 2 });\n`,
    target: "es2022",
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-128 (H2): at target ES5 a class compiles to a function, whose
  // `prototype` a store replaces.
  {
    id: "rwf128.es5-class-prototype-replaced",
    finding: "RWF-128",
    mechanism:
      "`class C {} (C as any).prototype = globalThis; (C as any).prototype.Buffer = …` at target ES5",
    program: (hook) =>
      `class C {}\n(C as any).prototype = globalThis;\n(C as any).prototype.Buffer = ${isBuffer(hook)};\nBuffer.isBuffer(1);\n`,
    target: "es5",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf128.es5-constructor-this-after-the-prototype-is-replaced",
    finding: "RWF-128",
    mechanism:
      "`class C { constructor() { (this as any).Buffer = …; } } (C as any).prototype = globalThis; new C()` at target ES5",
    program: (hook) =>
      `class C { constructor() { (this as any).Buffer = ${isBuffer(hook)}; } }\n(C as any).prototype = globalThis;\nnew C();\nBuffer.isBuffer(1);\n`,
    target: "es5",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "control.es5-class-prototype-never-stored",
    finding: "RWF-128",
    mechanism:
      "`class C {} C.prototype.Buffer = …` at target ES5: the prototype is the program's own",
    program: (hook) =>
      `class C {}\n(C as any).prototype.Buffer = ${isBuffer(hook)};\nBuffer.isBuffer(1);\n`,
    target: "es5",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
