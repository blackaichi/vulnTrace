import type { OracleCase } from "../../src/testing/oracle/case.js";
import {
  simpleConfigFile,
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
 * Task E-1 (docs/tasks/E-1-export-write-set.md; ADR 0009 § 8): the export
 * write set, against real Node.
 *
 * THE MECHANISM. An export is attributed to one declaration only when the
 * file's COMPLETE write set for its name determines one effective write
 * (ADR 0009 § 1). Each case below writes `run` in a way the export model
 * once read wrongly (PRM-26, 27, 28, 29, 30, 62, 63, 103): the write the
 * model looked at was not the only write that mattered.
 *
 * LOUD FIXTURE. `vuln-lib` (CommonJS) and `vuln-esm` (an ES module) each
 * export `parse` (the rule's target) and `safe`, both functions;
 * `wrap/index.js`'s `dangerousOp` calls `parse` and its `safeOp` calls
 * `safe`. A wrong attribution therefore lands loudly on `safeOp`, whose
 * search family C completes, never quietly on nothing.
 *
 * THE CONTROLS. The negative control writes `run = safeOp` once; real
 * Node never calls `parse`, and the analyzer answers `NOT_AFFECTED`. The
 * positive control is the same package with one direct call of `parse` in
 * the entry. The ES module cases have their own pair, in ES module syntax,
 * and write function expressions: an ES module `export const run =
 * safeOp` (an identifier initializer) is not attributed at all on the
 * base (measured), so its negative control would be `UNKNOWN`.
 */

export const ADVISORY_ID = "GHSA-e1-export-write-set";
export const TARGET_MARKER = "parse";

export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

export interface E1Case {
  readonly id: string;
  /** The finding the shape reproduces, or `control`. */
  readonly finding: string;
  /** One line: the spelling. */
  readonly mechanism: string;
  /** `wrap/index.js` after the shared prelude (`lib`, `dangerousOp`, `safeOp`). */
  readonly wrap: string;
  /** Other files of the `wrap` package, by path inside it. */
  readonly wrapFiles?: Readonly<Record<string, string>>;
  /** The entry's source, when not `require("wrap").run("x")`. */
  readonly app?: string;
  /** An ES module `wrap` (and entry), importing `vuln-esm`. */
  readonly esm?: boolean;
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /** The analyzer's verdict on the base commit, measured. */
  readonly base: CaseVerdict;
  /** The sound verdict, asserted. */
  readonly expected: CaseVerdict;
}

const CJS_ENTRY = "src/index.js";
const ESM_ENTRY = "src/index.mjs";

const LIBS: Readonly<Record<string, string>> = {
  "node_modules/vuln-lib/package.json": JSON.stringify({
    name: "vuln-lib",
    version: "1.0.0",
    main: "index.js",
  }),
  "node_modules/vuln-lib/index.js":
    HIT_HELPER_SOURCE +
    hitFunction("parse", '"p"') +
    hitFunction("safe", '"s"') +
    `module.exports = { parse, safe };\n`,
  "node_modules/vuln-esm/package.json": JSON.stringify({
    name: "vuln-esm",
    version: "1.0.0",
    type: "module",
    exports: "./index.js",
  }),
  "node_modules/vuln-esm/index.js":
    HIT_HELPER_SOURCE +
    `export ${hitFunction("parse", '"p"')}` +
    `export ${hitFunction("safe", '"s"')}`,
};

const CJS_PRELUDE =
  `const lib = require("vuln-lib");\n` +
  `function dangerousOp(x) { return lib.parse(x); }\n` +
  `function safeOp(x) { return lib.safe(x); }\n`;

const ESM_PRELUDE =
  `import { parse, safe } from "vuln-esm";\n` +
  `function dangerousOp(x) { return parse(x); }\n` +
  `function safeOp(x) { return safe(x); }\n`;

const CJS_APP = `const w = require("wrap");\nw.run("x");\n`;
const ESM_APP = `import { run } from "wrap";\nrun("x");\n`;

function wrapPackage(
  esm: boolean,
  index: string,
  extra: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    "node_modules/wrap/package.json": JSON.stringify(
      esm
        ? {
            name: "wrap",
            version: "1.0.0",
            type: "module",
            exports: "./index.js",
          }
        : { name: "wrap", version: "1.0.0", main: "index.js" },
    ),
    "node_modules/wrap/index.js": (esm ? ESM_PRELUDE : CJS_PRELUDE) + index,
  };
  for (const [path, source] of Object.entries(extra)) {
    files[`node_modules/wrap/${path}`] = source;
  }
  return files;
}

function packageFiles(esm: boolean): Readonly<Record<string, string>> {
  const lib = esm ? "vuln-esm" : "vuln-lib";
  const dependencies = { [lib]: "1.0.0", wrap: "1.0.0" };
  return {
    "package.json": JSON.stringify(
      { name: "app", version: "1.0.0", dependencies },
      null,
      2,
    ),
    "package-lock.json": JSON.stringify(
      {
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": { name: "app", version: "1.0.0", dependencies },
          [`node_modules/${lib}`]: { version: "1.0.0" },
          "node_modules/wrap": { version: "1.0.0" },
        },
      },
      null,
      2,
    ),
  };
}

function project(
  esm: boolean,
  wrap: Readonly<Record<string, string>>,
  app: string,
): ProjectSpec {
  const entry = esm ? ESM_ENTRY : CJS_ENTRY;
  return {
    files: {
      ...packageFiles(esm),
      ...LIBS,
      ...wrap,
      [entry]: app,
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: esm ? "vuln-esm" : "vuln-lib",
        exportName: "parse",
      }),
      "vulntrace.yml": simpleConfigFile({ entrypoints: [entry] }),
    },
  };
}

export function oracleCase(kase: E1Case): OracleCase {
  const esm = kase.esm === true;
  const lib = esm ? "vuln-esm" : "vuln-lib";
  const app = esm ? ESM_APP : CJS_APP;
  const negativeWrap = wrapPackage(
    esm,
    esm
      ? `export const run = function (x) { return safeOp(x); };\n`
      : `exports.run = safeOp;\n`,
  );
  const positiveApp = esm
    ? `import { parse } from "vuln-esm";\n` + app + `parse("x");\n`
    : app + `const lib = require("vuln-lib");\nlib.parse("x");\n`;
  return {
    id: kase.id,
    loudFixture: { specifier: lib, boundNames: ["parse", "safe"], esm },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: lib, fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(esm ? ESM_ENTRY : CJS_ENTRY),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(esm, negativeWrap, positiveApp),
        },
        negative: {
          name: "negative-control",
          project: project(esm, negativeWrap, app),
        },
      },
    },
    variant: {
      name: "case",
      project: project(
        esm,
        wrapPackage(esm, kase.wrap, kase.wrapFiles),
        kase.app ?? app,
      ),
    },
  };
}

export const E1_CASES: readonly E1Case[] = [
  // PRM-26: the export map's first indexed function of the local's name.
  {
    id: "prm26.class-method-first",
    finding: "PRM-26",
    mechanism:
      "`class A { run() {…safe…} }` before `function run() {…parse…}`; `exports.run = run`",
    wrap:
      `class A { run(x) { return lib.safe(x); } }\nvoid A;\n` +
      `function run(x) { return lib.parse(x); }\nexports.run = run;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "prm26.nested-function-first",
    finding: "PRM-26",
    mechanism:
      "a nested `function run` inside another function, before the module-scope `function run`",
    wrap:
      `function outer() { function run(x) { return lib.safe(x); } return run; }\nvoid outer;\n` +
      `function run(x) { return lib.parse(x); }\nexports.run = run;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "prm26.object-property-function-first",
    finding: "PRM-26",
    mechanism:
      "`o.run = function (x) {…safe…}` before `function run`; `module.exports = { run }`",
    wrap:
      `const o = {};\no.run = function (x) { return lib.safe(x); };\nvoid o;\n` +
      `function run(x) { return lib.parse(x); }\nmodule.exports = { run };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "prm26.esm-class-method-first",
    finding: "PRM-26",
    mechanism:
      "ES module: `class A { run() {…safe…} }` before `function run`; `export { run }`",
    esm: true,
    wrap:
      `class A { run(x) { return safe(x); } }\nvoid A;\n` +
      `function run(x) { return parse(x); }\nexport { run };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  // PRM-27: a later key for the same name in the exported literal.
  {
    id: "prm27.string-key-override",
    finding: "PRM-27",
    mechanism: '`module.exports = { run: safeOp, "run": dangerousOp }`',
    wrap: `module.exports = { run: safeOp, "run": dangerousOp };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "prm27.getter-override",
    finding: "PRM-27",
    mechanism:
      "`module.exports = { run: safeOp, get run() { return dangerousOp; } }`",
    wrap: `module.exports = { run: safeOp, get run() { return dangerousOp; } };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm27.spread-override",
    finding: "PRM-27",
    mechanism:
      "`const extra = { run: dangerousOp }; module.exports = { run: safeOp, ...extra }`",
    wrap:
      `const extra = { run: dangerousOp };\n` +
      `module.exports = { run: safeOp, ...extra };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm27.dynamic-computed-override",
    finding: "PRM-27",
    mechanism:
      '`module.exports = { run: safeOp, [["r", "un"].join("")]: dangerousOp }`',
    wrap: `module.exports = { run: safeOp, [["r", "un"].join("")]: dangerousOp };\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // PRM-28: a computed key's constant, resolved by whole-file first match.
  {
    id: "prm28.computed-key-inner-const-first",
    finding: "PRM-28",
    mechanism:
      '`function f() { const K = "other"; … }` before the module-scope `const K = "run"`; `{ run: safeOp, [K]: dangerousOp }`',
    wrap:
      `function f() { const K = "other"; return K; }\nvoid f;\n` +
      `const K = "run";\nmodule.exports = { run: safeOp, [K]: dangerousOp };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "prm28.computed-key-block-const-first",
    finding: "PRM-28",
    mechanism:
      '`{ const K = "other"; }` block before the module-scope `const K = "run"`',
    wrap:
      `{ const K = "other"; void K; }\n` +
      `const K = "run";\nmodule.exports = { run: safeOp, [K]: dangerousOp };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  // PRM-29: a write deferred into a function, or a configure-time call.
  {
    id: "prm29.deferred-configure-export",
    finding: "PRM-29",
    mechanism:
      "`exports.run = safeOp; exports.configure = function () { exports.run = dangerousOp; }`; the entry calls `configure()` first",
    wrap:
      `exports.run = safeOp;\n` +
      `exports.configure = function () { exports.run = dangerousOp; };\n`,
    app: `const w = require("wrap");\nw.configure();\nw.run("x");\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "prm29.module-time-configure-call",
    finding: "PRM-29",
    mechanism:
      "`exports.run = safeOp; function configure() { exports.run = dangerousOp; } configure();`",
    wrap:
      `exports.run = safeOp;\n` +
      `function configure() { exports.run = dangerousOp; }\nconfigure();\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "prm29.deferred-module-exports-member",
    finding: "PRM-29",
    mechanism:
      "`module.exports = { run: safeOp, configure() { module.exports.run = dangerousOp; } }`; the entry calls `configure()` first",
    wrap: `module.exports = { run: safeOp, configure() { module.exports.run = dangerousOp; } };\n`,
    app: `const w = require("wrap");\nw.configure();\nw.run("x");\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "prm29.this-write-in-exported-method",
    finding: "PRM-29",
    mechanism:
      "`exports.run = safeOp; exports.configure = function () { this.run = dangerousOp; }` (called as `w.configure()`, `this` is the exports object)",
    wrap:
      `exports.run = safeOp;\n` +
      `exports.configure = function () { this.run = dangerousOp; };\n`,
    app: `const w = require("wrap");\nw.configure();\nw.run("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm29.this-write-in-literal-method",
    finding: "PRM-29",
    mechanism:
      "`module.exports = { run: safeOp, configure() { this.run = dangerousOp; } }`",
    wrap: `module.exports = { run: safeOp, configure() { this.run = dangerousOp; } };\n`,
    app: `const w = require("wrap");\nw.configure();\nw.run("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // PRM-30: literal unpacking wins over a later member write.
  {
    id: "prm30.literal-then-member-write",
    finding: "PRM-30",
    mechanism:
      "`module.exports = { run: safeOp }; module.exports.run = dangerousOp;`",
    wrap: `module.exports = { run: safeOp };\nmodule.exports.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "prm30.literal-then-exports-alias-write",
    finding: "PRM-30",
    mechanism:
      "`exports = module.exports = { run: safeOp }; exports.run = dangerousOp;`",
    wrap: `exports = module.exports = { run: safeOp };\nexports.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  // PRM-62: an ES module `let` export reassigned.
  {
    id: "prm62.esm-let-reassigned",
    finding: "PRM-62",
    mechanism:
      "ES module: `export let run = function (x) { return safeOp(x); }; run = dangerousOp;`",
    esm: true,
    wrap: `export let run = function (x) { return safeOp(x); };\nrun = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm62.esm-let-configure",
    finding: "PRM-62",
    mechanism:
      "ES module: `export let run = function (x) { return safeOp(x); }; export function configure() { run = dangerousOp; }`",
    esm: true,
    wrap:
      `export let run = function (x) { return safeOp(x); };\n` +
      `export function configure() { run = dangerousOp; }\n`,
    app: `import { run, configure } from "wrap";\nconfigure();\nrun("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm62.esm-export-list-of-reassigned-let",
    finding: "PRM-62",
    mechanism:
      "ES module: `let run = function (x) { return safeOp(x); }; export { run }; run = dangerousOp;`",
    esm: true,
    wrap: `let run = function (x) { return safeOp(x); };\nexport { run };\nrun = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // PRM-63: bracket, alias and `Object.assign` writes of the export object.
  {
    id: "prm63.module-bracket-exports-member",
    finding: "PRM-63",
    mechanism: '`exports.run = safeOp; module["exports"].run = dangerousOp;`',
    wrap: `exports.run = safeOp;\nmodule["exports"].run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.module-exports-bracket-key",
    finding: "PRM-63",
    mechanism: '`exports.run = safeOp; module.exports["run"] = dangerousOp;`',
    wrap: `exports.run = safeOp;\nmodule.exports["run"] = dangerousOp;\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "prm63.exports-bracket-key",
    finding: "PRM-63",
    mechanism: '`exports.run = safeOp; exports["run"] = dangerousOp;`',
    wrap: `exports.run = safeOp;\nexports["run"] = dangerousOp;\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "prm63.module-alias-whole-write",
    finding: "PRM-63",
    mechanism:
      "`module.exports = { run: safeOp }; const m = module; m.exports = { run: dangerousOp };`",
    wrap:
      `module.exports = { run: safeOp };\n` +
      `const m = module;\nm.exports = { run: dangerousOp };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.object-assign-module-exports",
    finding: "PRM-63",
    mechanism:
      "`exports.run = safeOp; Object.assign(module.exports, { run: dangerousOp });`",
    wrap:
      `exports.run = safeOp;\n` +
      `Object.assign(module.exports, { run: dangerousOp });\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.define-property-exports",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; Object.defineProperty(exports, "run", { value: dangerousOp });`',
    wrap:
      `exports.run = safeOp;\n` +
      `Object.defineProperty(exports, "run", { value: dangerousOp });\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.exports-alias-member",
    finding: "PRM-63",
    mechanism:
      "`exports.run = safeOp; const e = exports; e.run = dangerousOp;`",
    wrap: `exports.run = safeOp;\nconst e = exports;\ne.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.module-scope-this",
    finding: "PRM-63",
    mechanism: "`exports.run = safeOp; this.run = dangerousOp;`",
    wrap: `exports.run = safeOp;\nthis.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.reflect-set-exports",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; Reflect.set(exports, "run", dangerousOp);`',
    wrap: `exports.run = safeOp;\nReflect.set(exports, "run", dangerousOp);\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.logical-assignment",
    finding: "PRM-63",
    mechanism: "`exports.run = safeOp; exports.run &&= dangerousOp;`",
    wrap: `exports.run = safeOp;\nexports.run &&= dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.destructuring-assignment-target",
    finding: "PRM-63",
    mechanism: "`exports.run = safeOp; [exports.run] = [dangerousOp];`",
    wrap: `exports.run = safeOp;\n[exports.run] = [dangerousOp];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.freeze-between-writes",
    finding: "PRM-63",
    mechanism:
      "`exports.run = dangerousOp; Object.freeze(exports); exports.run = safeOp;` (the last write silently fails)",
    wrap: `exports.run = dangerousOp;\nObject.freeze(exports);\nexports.run = safeOp;\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.exports-passed-to-helper",
    finding: "PRM-63",
    mechanism:
      "`exports.run = safeOp; function patch(t) { t.run = dangerousOp; } patch(exports);`",
    wrap:
      `exports.run = safeOp;\n` +
      `function patch(t) { t.run = dangerousOp; }\npatch(exports);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.module-exports-alias-member",
    finding: "PRM-63",
    mechanism:
      "`module.exports = { run: safeOp }; const api = module.exports; api.run = dangerousOp;`",
    wrap:
      `module.exports = { run: safeOp };\n` +
      `const api = module.exports;\napi.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm63.self-require-member-write",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; require("./index").run = dangerousOp;` (a self-`require` returns the exports object)',
    wrap: `exports.run = safeOp;\nrequire("./index").run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // E-1's own rules, found while narrowing the census (each measured).
  {
    id: "e1.whole-module-binding-alias-write",
    finding: "PRM-63",
    mechanism:
      "`function main() {} module.exports = main; module.exports.run = safeOp; main.run = dangerousOp;` (the binding is the final object)",
    wrap:
      `function main() {}\nmodule.exports = main;\n` +
      `module.exports.run = safeOp;\nmain.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "e1.authoritative-stale-property-write",
    finding: "RWF-100",
    mechanism:
      "`exports.run = safeOp; function main() {} main.run = dangerousOp; module.exports = main;` (RWF-100's authoritative case: the property write went to the replaced object)",
    wrap:
      `exports.run = safeOp;\nfunction main() {}\nmain.run = dangerousOp;\n` +
      `module.exports = main;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "e1.export-method-hands-this-on",
    finding: "PRM-63",
    mechanism:
      "`exports.run = safeOp; exports.init = function () { patch(this); }; function patch(t) { t.run = dangerousOp; }`",
    wrap:
      `exports.run = safeOp;\n` +
      `exports.init = function () { patch(this); };\n` +
      `function patch(t) { t.run = dangerousOp; }\n`,
    app: `const w = require("wrap");\nw.init();\nw.run("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "e1.whole-module-class-static-block",
    finding: "PRM-29",
    mechanism:
      "`class C { static configure() { this.run = dangerousOp; } } C.run = safeOp; module.exports = C;` (a static method's `this` is the class, the final object)",
    wrap:
      `class C { static configure() { this.run = dangerousOp; } }\n` +
      `module.exports = C;\nmodule.exports.run = safeOp;\n`,
    app: `const w = require("wrap");\nw.configure();\nw.run("x");\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // E-1's independent audit: shapes that were false NOT_AFFECTED on the
  // first version of the fix (each pre-existing on the base too).
  {
    id: "audit.self-load-assigned",
    finding: "PRM-63",
    mechanism:
      '`var self; self = require("./index.js"); exports.run = safeOp; self.run = dangerousOp;`',
    wrap:
      `var self;\nself = require("./index.js");\n` +
      `exports.run = safeOp;\nself.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.self-load-returned",
    finding: "PRM-63",
    mechanism:
      '`function load() { return require("./index.js"); } exports.run = safeOp; load().run = dangerousOp;`',
    wrap:
      `function load() { return require("./index.js"); }\n` +
      `exports.run = safeOp;\nload().run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.self-load-logical",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; (require("./index.js") || 0).run = dangerousOp;`',
    wrap: `exports.run = safeOp;\n(require("./index.js") || 0).run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.derived-class-super-self-load",
    finding: "PRM-63",
    mechanism:
      '`class Base { constructor() { return require("./index.js"); } } class D extends Base { run = dangerousOp; } exports.run = safeOp; new D();` (`this` is what `super()` returned)',
    wrap:
      `class Base { constructor() { return require("./index.js"); } }\n` +
      `class D extends Base { run = dangerousOp; }\n` +
      `exports.run = safeOp;\nnew D();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.module-parent-children",
    finding: "PRM-63",
    mechanism:
      "`exports.run = safeOp; var c = module.parent.children; c[c.length - 1].exports.run = dangerousOp;`",
    wrap:
      `exports.run = safeOp;\nvar c = module.parent.children;\n` +
      `c[c.length - 1].exports.run = dangerousOp;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.instanceof-has-instance",
    finding: "PRM-63",
    mechanism:
      "`class C { static [Symbol.hasInstance](o) { o.run = dangerousOp; return true; } } exports.run = safeOp; exports instanceof C;`",
    wrap:
      `class C { static [Symbol.hasInstance](o) { o.run = dangerousOp; return true; } }\n` +
      `exports.run = safeOp;\nvoid (exports instanceof C);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.loose-equality-value-of",
    finding: "PRM-63",
    mechanism:
      "`Object.prototype.valueOf = function () { if (this === exports) this.run = dangerousOp; return 1; }; exports.run = safeOp; exports == 1;`",
    wrap:
      `Object.prototype.valueOf = function () { var s = this; if (s === exports) s.run = dangerousOp; return 1; };\n` +
      `exports.run = safeOp;\nvoid (exports == 1);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.template-to-string",
    finding: "PRM-63",
    mechanism:
      '`exports.toString = function () { helper(this); return ""; }; exports.run = safeOp; `${exports}`;` with `helper(t)` writing `t.run`',
    wrap:
      `function helper(t) { t.run = dangerousOp; }\n` +
      `exports.toString = function () { helper(this); return ""; };\n` +
      `exports.run = safeOp;\nvoid \`\${exports}\`;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.proto-write",
    finding: "PRM-63",
    mechanism:
      "`exports.run = safeOp; exports.__proto__ = { m() { this.run = dangerousOp; } }; exports.m();`",
    wrap:
      `exports.run = safeOp;\n` +
      `exports.__proto__ = { m() { var s = this; s.run = dangerousOp; } };\nexports.m();\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "audit.define-getter",
    finding: "PRM-63",
    mechanism:
      '`exports.__defineGetter__("run", function () { return dangerousOp; });` after `exports.run = safeOp;`',
    wrap:
      `exports.run = safeOp;\n` +
      `exports.__defineGetter__("run", function () { return dangerousOp; });\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "audit.module-builtin-load",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; require("module")._load(__filename).run = dangerousOp;`',
    wrap:
      `exports.run = safeOp;\n` +
      `require("module")._load(__filename).run = dangerousOp;\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "audit.frozen-final-object",
    finding: "PRM-30",
    mechanism:
      '`module.exports = require("./frozen"); module.exports.run = safeOp;` where `frozen.js` exports a frozen `{ run: dangerousOp }` (the write silently fails)',
    wrap: `module.exports = require("./frozen");\nmodule.exports.run = safeOp;\n`,
    wrapFiles: {
      "frozen.js":
        `const lib = require("vuln-lib");\n` +
        `module.exports = Object.freeze({ run(x) { return lib.parse(x); } });\n`,
    },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // PRM-103: a cyclic importer observes an intermediate export value.
  {
    id: "prm103.cyclic-observer-between-writes",
    finding: "PRM-103",
    mechanism:
      '`exports.run = dangerousOp; require("./b"); exports.run = safeOp;` with `b.js` calling `require("./index").run` at load',
    wrap: `exports.run = dangerousOp;\nrequire("./b");\nexports.run = safeOp;\n`,
    wrapFiles: { "b.js": `require("./index").run("x");\n` },
    app: `require("wrap");\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // E-1's re-audit (round 2). F1: a member write through ANY load's result
  // may write this file's own exports object -- the loaded module can hand
  // it back (a cycle through another module, a package `imports` alias, an
  // installed name that differs from the directory). Live on the base.
  {
    id: "reaudit.cycle-member-write",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; require("./other").run = dangerousOp;` with `other.js` `module.exports = require("./index");`',
    wrap: `exports.run = safeOp;\nrequire("./other").run = dangerousOp;\n`,
    wrapFiles: { "other.js": `module.exports = require("./index");\n` },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "reaudit.cycle-binding-member-write",
    finding: "PRM-63",
    mechanism:
      '`const o = require("./other"); exports.run = safeOp; o.run = dangerousOp;` with `other.js` handing back `module.parent.exports`',
    wrap:
      `const o = require("./other");\n` +
      `exports.run = safeOp;\no.run = dangerousOp;\n`,
    wrapFiles: { "other.js": `module.exports = module.parent.exports;\n` },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "reaudit.cycle-member-chain-write",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; require("./other").self.run = dangerousOp;` with `other.js` `exports.self = require("./index");`',
    wrap: `exports.run = safeOp;\nrequire("./other").self.run = dangerousOp;\n`,
    wrapFiles: { "other.js": `exports.self = require("./index");\n` },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "reaudit.imports-self-alias",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; require("#self").run = dangerousOp;` with `"imports": { "#self": "./index.js" }`',
    wrap: `exports.run = safeOp;\nrequire("#self").run = dangerousOp;\n`,
    wrapFiles: {
      "package.json": JSON.stringify({
        name: "wrap",
        version: "1.0.0",
        main: "index.js",
        imports: { "#self": "./index.js" },
      }),
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "reaudit.self-name-differs-from-directory",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; require("wrap-real").run = dangerousOp;` in a package named `wrap-real` installed as `wrap`',
    wrap: `exports.run = safeOp;\nrequire("wrap-real").run = dangerousOp;\n`,
    wrapFiles: {
      "package.json": JSON.stringify({
        name: "wrap-real",
        version: "1.0.0",
        main: "index.js",
        exports: "./index.js",
      }),
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // F2: the reader allow-list trusted builtins the file itself replaces.
  {
    id: "reaudit.object-keys-patched",
    finding: "PRM-63",
    mechanism:
      "`exports.run = safeOp; Object.keys = function (o) { o.run = dangerousOp; return []; }; Object.keys(exports);`",
    wrap:
      `exports.run = safeOp;\n` +
      `Object.keys = function (o) { o.run = dangerousOp; return []; };\n` +
      `Object.keys(exports);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "reaudit.reader-patched-tested",
    finding: "PRM-63",
    mechanism:
      "`Object.getOwnPropertyNames = function (o) { o.run = dangerousOp; return []; }; if (Object.getOwnPropertyNames(exports).length) {}`",
    wrap:
      `exports.run = safeOp;\n` +
      `Object.getOwnPropertyNames = function (o) { o.run = dangerousOp; return []; };\n` +
      `if (Object.getOwnPropertyNames(exports).length) {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // F3: `process` reached other than as the ambient `process.mainModule`.
  {
    id: "reaudit.process-alias-main-module",
    finding: "PRM-63",
    mechanism:
      "`exports.other = dangerousOp; const p = process; const e = p.mainModule.children[0].exports; e.run = e.other;`",
    wrap:
      `exports.run = safeOp;\nexports.other = dangerousOp;\n` +
      `const p = process;\n` +
      `const e = p.mainModule.children[0].exports;\ne.run = e.other;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "reaudit.global-this-process-main-module",
    finding: "PRM-63",
    mechanism:
      "`exports.other = dangerousOp; const e = globalThis.process.mainModule.children[0].exports; e.run = e.other;`",
    wrap:
      `exports.run = safeOp;\nexports.other = dangerousOp;\n` +
      `const e = globalThis.process.mainModule.children[0].exports;\ne.run = e.other;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // F4: wrong at the model, masked by a call-graph backstop on the base.
  {
    id: "reaudit.require-call-member-write",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; require.call(null, "./index").run = dangerousOp;`',
    wrap: `exports.run = safeOp;\nrequire.call(null, "./index").run = dangerousOp;\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "reaudit.has-instance-on-object",
    finding: "PRM-63",
    mechanism:
      "`Object.defineProperty(Object, Symbol.hasInstance, { value(o) { o.run = dangerousOp; return true; } }); if (exports instanceof Object) {}`",
    wrap:
      `exports.run = safeOp;\n` +
      `Object.defineProperty(Object, Symbol.hasInstance, { value: function (o) { o.run = dangerousOp; return true; } });\n` +
      `if (exports instanceof Object) {}\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "reaudit.get-builtin-module",
    finding: "PRM-63",
    mechanism:
      '`exports.run = safeOp; process.getBuiltinModule("module")._cache[__filename].exports.run = dangerousOp;`',
    wrap:
      `exports.run = safeOp;\n` +
      `process.getBuiltinModule("module")._cache[__filename].exports.run = dangerousOp;\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Precision controls for the re-audit's rules.
  {
    id: "control.loaded-member-write-other-name",
    finding: "control",
    mechanism:
      '`require("vuln-lib").extra = 1; exports.run = safeOp;` (a load\'s member write of another name)',
    wrap: `require("vuln-lib").extra = 1;\nexports.run = safeOp;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // Precision controls for the census's narrowings: each real Node
  // completes without calling the target.
  {
    id: "control.typescript-import-helper",
    finding: "control",
    mechanism:
      "`var __h = (this && this.__h) || function (m) { return m; };` (TypeScript's module-scope helper test)",
    wrap:
      `var __h = (this && this.__h) || function (m) { return m; };\nvoid __h;\n` +
      `exports.run = safeOp;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.whole-module-binding-read",
    finding: "control",
    mechanism:
      "`function main() {} module.exports = main; module.exports.run = safeOp; void main.name; main();` (the binding read and called, never written)",
    wrap:
      `function main() {}\nmodule.exports = main;\n` +
      `module.exports.run = safeOp;\nvoid main.name;\nmain();\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // Precision controls (ADR 0009 § 4, § 8 "must stay green").
  {
    id: "control.straight-line-last-write",
    finding: "control",
    mechanism: "`exports.run = dangerousOp; exports.run = safeOp;`",
    wrap: `exports.run = dangerousOp;\nexports.run = safeOp;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.literal-duplicate-plain-keys",
    finding: "control",
    mechanism: "`module.exports = { run: dangerousOp, run: safeOp }`",
    wrap: `module.exports = { run: dangerousOp, run: safeOp };\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.literal-string-key-last-safe",
    finding: "control",
    mechanism: '`module.exports = { run: dangerousOp, "run": safeOp }`',
    wrap: `module.exports = { run: dangerousOp, "run": safeOp };\n`,
    called: false,
    base: "AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.computed-module-const",
    finding: "control",
    mechanism: '`const K = "run"; module.exports = { [K]: safeOp }`',
    wrap: `const K = "run";\nmodule.exports = { [K]: safeOp };\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.computed-module-const-dangerous",
    finding: "control",
    mechanism: '`const K = "run"; module.exports = { [K]: dangerousOp }`',
    wrap: `const K = "run";\nmodule.exports = { [K]: dangerousOp };\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "control.whole-module-fn-with-property",
    finding: "control",
    mechanism:
      "`module.exports = function main() {}; module.exports.run = safeOp;`",
    wrap: `module.exports = function main() {};\nmodule.exports.run = safeOp;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.chained-exports-module-exports",
    finding: "control",
    mechanism: "`exports = module.exports = { run: safeOp };`",
    wrap: `exports = module.exports = { run: safeOp };\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.literal-then-member-write-safe",
    finding: "control",
    mechanism:
      "`module.exports = { run: dangerousOp }; module.exports.run = safeOp;` (the member write is the last)",
    wrap: `module.exports = { run: dangerousOp };\nmodule.exports.run = safeOp;\n`,
    called: false,
    base: "AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.stale-exports-write",
    finding: "control",
    mechanism:
      "`exports.run = dangerousOp; module.exports = { run: safeOp };` (a write to the replaced object)",
    wrap: `exports.run = dangerousOp;\nmodule.exports = { run: safeOp };\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.deferred-write-other-name",
    finding: "control",
    mechanism:
      "`exports.run = safeOp; exports.configure = function () { exports.other = dangerousOp; }` (a deferred write of another name)",
    wrap:
      `exports.run = safeOp;\n` +
      `exports.configure = function () { exports.other = dangerousOp; };\n`,
    app: `const w = require("wrap");\nw.configure();\nw.run("x");\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.esm-const-export",
    finding: "control",
    mechanism:
      "ES module: `export const run = function (x) { return dangerousOp(x); };`",
    esm: true,
    wrap: `export const run = function (x) { return dangerousOp(x); };\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "control.esm-let-never-reassigned",
    finding: "control",
    mechanism:
      "ES module: `export let run = function (x) { return safeOp(x); };` (never assigned again)",
    esm: true,
    wrap: `export let run = function (x) { return safeOp(x); };\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
