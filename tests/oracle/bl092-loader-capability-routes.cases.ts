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
 * Task BL-092 (docs/tasks/BL-092-loader-capability-routes.md): the loader
 * capability seen only when spelled -- RWF-129 (`module.paths` changed
 * through any route but its spelled forms) and RWF-130 (`module.__proto__`
 * is `Module.prototype`), with the routes of the same class this task
 * measured beside them -- against real Node.
 *
 * THE SETUP (RWF-129's). `wrap` carries a decoy
 * `wrap/node_modules/vuln-lib` (version 99.0.0, outside the advisory's
 * range, whose `parse` and `safe` print nothing), and `wrap/index.js` ends
 * with `require("vuln-lib/index.js").parse("x")`. Without a redirect both
 * Node and the analyzer pick the decoy: the affected top-level
 * `vuln-lib@1.0.0` is never loaded, and family A proves it. Each case adds
 * one statement before that load that makes Node load the top-level
 * instance instead, and so call the target.
 *
 * Measured on the base (`f3b1dca`, BL-091's merge), before the fix: see
 * each case's `base`.
 *
 * LOUD FIXTURE. The top-level `vuln-lib` exports `parse` (the rule's
 * target) and `safe`, both functions.
 *
 * THE CONTROLS. The negative control's `wrap` has no redirect (family A,
 * `NOT_AFFECTED`); the positive control's entry also calls the top-level
 * `parse` directly (`AFFECTED`).
 */

export const ADVISORY_ID = "GHSA-bl092-loader-capability-routes";
export const TARGET_MARKER = "parse";

export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

export interface Bl092Case {
  readonly id: string;
  /** The finding the case reproduces. */
  readonly finding: string;
  /** One line: the mechanism. */
  readonly mechanism: string;
  /** The statements `wrap/index.js` runs before it loads `vuln-lib/index.js`. */
  readonly redirect: string;
  /** Further files of the variant only (a second module of `wrap`'s). */
  readonly files?: Readonly<Record<string, string>>;
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /** The verdict on the base commit, measured before the fix. */
  readonly base: CaseVerdict;
  /** The sound verdict. */
  readonly expected: CaseVerdict;
  /**
   * For an expected `UNKNOWN` real Node does not reach: why `UNKNOWN` is
   * the sound answer anyway.
   */
  readonly precisionCost?: string;
}

const ENTRY = "src/index.js";

/** The top-level `vuln-lib`'s `index.js`, an absolute path computed in `wrap`. */
const REAL_PATH = `require("path").join(__dirname, "..", "vuln-lib", "index.js")`;

const LIB: Readonly<Record<string, string>> = {
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
  "node_modules/wrap/package.json": JSON.stringify({
    name: "wrap",
    version: "1.0.0",
    main: "index.js",
  }),
  "node_modules/wrap/node_modules/vuln-lib/package.json": JSON.stringify({
    name: "vuln-lib",
    version: "99.0.0",
    main: "index.js",
  }),
  "node_modules/wrap/node_modules/vuln-lib/index.js":
    `function parse(x) { return x; }\n` +
    `function safe(x) { return x; }\n` +
    `module.exports = { parse, safe };\n`,
};

function wrap(redirect: string): string {
  return (
    redirect +
    `const l = require("vuln-lib/index.js");\n` +
    `l.parse("x");\n` +
    `exports.run = function run(x) { return x; };\n`
  );
}

const APP = `require("wrap");\n`;

function packageFiles(): Readonly<Record<string, string>> {
  const dependencies = { "vuln-lib": "1.0.0", wrap: "1.0.0" };
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
          "node_modules/vuln-lib": { version: "1.0.0" },
          "node_modules/wrap": {
            version: "1.0.0",
            dependencies: { "vuln-lib": "99.0.0" },
          },
          "node_modules/wrap/node_modules/vuln-lib": { version: "99.0.0" },
        },
      },
      null,
      2,
    ),
  };
}

function project(
  redirect: string,
  entry: string = APP,
  files: Readonly<Record<string, string>> = {},
): ProjectSpec {
  return {
    files: {
      ...packageFiles(),
      ...LIB,
      ...files,
      "node_modules/wrap/index.js": wrap(redirect),
      [ENTRY]: entry,
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "vulntrace.yml": simpleConfigFile({ entrypoints: [ENTRY] }),
    },
  };
}

export function oracleCase(kase: Bl092Case): OracleCase {
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(ENTRY),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(
            "",
            APP + `const lib = require("vuln-lib");\nlib.parse("x");\n`,
          ),
        },
        negative: { name: "negative-control", project: project("") },
      },
    },
    variant: {
      name: "case",
      project: project(kase.redirect, APP, kase.files),
    },
  };
}

export const ALL_CASES: readonly Bl092Case[] = [
  // ---------------------------------------------------------------------
  // RWF-129: `module.paths` changed through a route but its spelled forms.
  // ---------------------------------------------------------------------
  {
    id: "rwf129.alias-then-shift",
    finding: "RWF-129",
    mechanism:
      "`const p = module.paths; p.shift();` drops `wrap/node_modules` through a `const` alias",
    redirect: `const p = module.paths;\np.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.parameter",
    finding: "RWF-129",
    mechanism:
      "`module.paths` handed to a local function that shifts its parameter",
    redirect: `function drop(a) { a.shift(); }\ndrop(module.paths);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.array-prototype-call",
    finding: "RWF-129",
    mechanism: "`Array.prototype.shift.call(module.paths)`",
    redirect: `Array.prototype.shift.call(module.paths);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.element-store",
    finding: "RWF-129",
    mechanism:
      "`module.paths[0] = <a directory with no vuln-lib>` replaces the decoy's directory",
    redirect: `module.paths[0] = require("path").join(__dirname, "..", "nowhere");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.destructuring-element-store",
    finding: "RWF-129",
    mechanism: "`[module.paths[0]] = [<elsewhere>];`, a destructuring target",
    redirect: `[module.paths[0]] = [__dirname + "/zz"];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.object-holder",
    finding: "RWF-129",
    mechanism: "`const h = { p: module.paths }; h.p.shift();`",
    redirect: `const h = { p: module.paths };\nh.p.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // UNKNOWN on the base through the call graph alone: it gives every
  // method call rooted in `module` an unknown `loader_capability_escape`
  // edge (`moduleScopeCalleeReason`). The closure's own scan missed it.
  {
    id: "rwf129.element-access-spelling",
    finding: "RWF-129",
    mechanism: '`module["paths"].shift()`: the element-access spelling',
    redirect: `module["paths"].shift();\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.compound-element-store",
    finding: "RWF-129",
    mechanism:
      '`module.paths[0] += "/zz"`: a compound assignment rewrites the entry',
    redirect: `module.paths[0] += "/zz";\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.for-of-head",
    finding: "RWF-129",
    mechanism: "`for (module.paths[0] of [<elsewhere>]);`, a `for…of` head",
    redirect: `for (module.paths[0] of [__dirname + "/zz"]);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // UNKNOWN on the base through the call graph alone: it gives every
  // method call rooted in `module` an unknown `loader_capability_escape`
  // edge (`moduleScopeCalleeReason`). The closure's own scan missed it.
  {
    id: "rwf129.callback-receives-array",
    finding: "RWF-129",
    mechanism:
      "`module.paths.forEach((p, i, a) => …)`: an array method hands the array itself to its callback",
    redirect: `module.paths.forEach((p, i, a) => { if (i === 0) a.shift(); });\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.object-assign",
    finding: "RWF-129",
    mechanism: "`Object.assign(module.paths, [<elsewhere>])`",
    redirect: `Object.assign(module.paths, [__dirname + "/zz"]);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.destructuring-whole-replacement",
    finding: "RWF-129",
    mechanism:
      "`({ paths: module.paths } = …)`: the whole array replaced through a destructuring target",
    redirect: `({ paths: module.paths } = { paths: [require("path").join(__dirname, "..")] });\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.array-holder",
    finding: "RWF-129",
    mechanism: "`const ps = [module.paths]; ps[0].shift();`",
    redirect: `const ps = [module.paths];\nps[0].shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf129.returned",
    finding: "RWF-129",
    mechanism:
      "`module.paths` returned by a local function whose result is shifted",
    redirect: `function get() { return module.paths; }\nget().shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // PRM-107's false NOT_AFFECTED half: an entry ADDED through a route but
  // the spelled `module.paths.unshift(…)` (its false AFFECTED half, the
  // AFFECTED authority under a reachable loader mutation, is task C-5's).
  {
    id: "prm107.alias-unshift",
    finding: "PRM-107",
    mechanism:
      "`const p = module.paths; p.unshift(<the top-level node_modules>)` puts the affected instance's directory first",
    redirect: `const p = module.paths;\np.unshift(require("path").join(__dirname, ".."));\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "prm107.array-prototype-unshift-call",
    finding: "PRM-107",
    mechanism:
      "`Array.prototype.unshift.call(module.paths, <the top-level node_modules>)`",
    redirect: `Array.prototype.unshift.call(module.paths, require("path").join(__dirname, ".."));\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // ---------------------------------------------------------------------
  // RWF-130: `module.__proto__` is `Module.prototype`.
  // ---------------------------------------------------------------------
  {
    id: "rwf130.proto-require",
    finding: "RWF-130",
    mechanism:
      "`module.__proto__.require = …` replaces `Module.prototype.require` for every module",
    redirect:
      `const real = ${REAL_PATH};\n` +
      `const orig = module.require;\n` +
      `module.__proto__.require = function (id) { return orig.call(this, id === "vuln-lib/index.js" ? real : id); };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf130.proto-element-spelling",
    finding: "RWF-130",
    mechanism: '`module["__proto__"].require = …`',
    redirect:
      `const real = ${REAL_PATH};\n` +
      `const orig = module.require;\n` +
      `module["__proto__"].require = function (id) { return orig.call(this, id === "vuln-lib/index.js" ? real : id); };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf130.proto-alias",
    finding: "RWF-130",
    mechanism: "`const P = module.__proto__; P.require = …`",
    redirect:
      `const real = ${REAL_PATH};\n` +
      `const orig = module.require;\n` +
      `const P = module.__proto__;\n` +
      `P.require = function (id) { return orig.call(this, id === "vuln-lib/index.js" ? real : id); };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // ---------------------------------------------------------------------
  // Measured beside them: the same class, other unspelled routes.
  // ---------------------------------------------------------------------
  {
    id: "measured.destructuring-static-member",
    finding: "RWF-133",
    mechanism:
      "`[Module._resolveFilename] = [hook]`: a destructuring target replaces a `Module` static member",
    redirect:
      `const real = ${REAL_PATH};\n` +
      `const Module = require("module");\n` +
      `[Module._resolveFilename] = [function (r) { return r === "vuln-lib/index.js" ? real : r; }];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The wrapper's `arguments` read in a module with no `require` call of
  // its own: one that has one already fails closed, because its `require`
  // is then no proven wrapper binding (task A-5a, `ambient-names.ts`).
  {
    id: "measured.wrapper-arguments-module",
    finding: "RWF-134",
    mechanism:
      "`arguments[2].constructor._resolveFilename = hook` in a second module of `wrap`'s: the wrapper's own `arguments` hold `module`",
    redirect: `require("./hook.js");\n`,
    files: {
      "node_modules/wrap/hook.js": `arguments[2].constructor._resolveFilename = function (r) { return r === "vuln-lib/index.js" ? __dirname + "/../vuln-lib/index.js" : r; };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.wrapper-arguments-require",
    finding: "RWF-134",
    mechanism:
      "`arguments[1](<the top-level vuln-lib>)` in a second module of `wrap`'s: the wrapper's own `arguments` hold `require`",
    redirect: `require("./hook.js");\n`,
    files: {
      "node_modules/wrap/hook.js": `const l2 = arguments[1](__dirname + "/../vuln-lib/index.js");\nl2.parse("x");\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Found by the independent audit (finding 3): the wrapper rule was
  // switched off by a same-name `const` anywhere in the file.
  {
    id: "audit.wrapper-arguments-const-elsewhere",
    finding: "RWF-134",
    mechanism:
      "`arguments[2].constructor._resolveFilename = hook` in a module that also declares `const arguments` inside a function",
    redirect: `require("./hook.js");\n`,
    files: {
      "node_modules/wrap/hook.js":
        `function f() { const arguments = 1; return arguments; }\n` +
        `arguments[2].constructor._resolveFilename = function (r) { return r === "vuln-lib/index.js" ? __dirname + "/../vuln-lib/index.js" : r; };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Found by the independent audit (finding 4): a `with` head reaches the
  // object's members under bare names.
  {
    id: "audit.with-lookup-list",
    finding: "RWF-138",
    mechanism: "`with (module.paths) { shift(); }`",
    redirect: `with (module.paths) { shift(); }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.with-module",
    finding: "RWF-138",
    mechanism: "`with (module) { paths.shift(); }`",
    redirect: `with (module) { paths.shift(); }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Found by the independent audit's second round (R2-1): the first fix
  // of finding 3 stopped a function's own `const arguments` from being
  // followed as an alias -- NOT_AFFECTED at that intermediate commit
  // (de5d785, never on main) for all three. On the base the first and
  // third are UNKNOWN; the second is NOT_AFFECTED there too (RWF-129: the
  // base followed no alias of `module.paths`).
  {
    id: "audit2.function-const-arguments-module",
    finding: "RWF-134",
    mechanism:
      '`function f() { const arguments = require("module"); arguments._resolveFilename = hook; }`',
    redirect:
      `const real = ${REAL_PATH};\n` +
      `function f() { const arguments = require("module"); arguments._resolveFilename = function (r) { return r === "vuln-lib/index.js" ? real : r; }; }\n` +
      `f();\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "audit2.function-const-arguments-paths",
    finding: "RWF-134",
    mechanism:
      "`function f() { const arguments = module.paths; arguments.shift(); }`",
    redirect: `function f() { const arguments = module.paths; arguments.shift(); }\nf();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit2.function-const-arguments-require",
    finding: "RWF-134",
    mechanism:
      "`function f() { const arguments = require; return arguments(<the top-level vuln-lib>); }`",
    redirect:
      `function f() { const arguments = require; return arguments(${REAL_PATH}); }\n` +
      `f().parse("x");\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Found by the independent audit's second round (R2-2).
  {
    id: "audit2.with-process",
    finding: "RWF-138",
    mechanism:
      "`with (process) { mainModule.require(<the top-level vuln-lib>) }`",
    redirect: `const real = ${REAL_PATH};\nwith (process) { mainModule.require(real).parse("x"); }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.module-require-alias",
    finding: "RWF-135",
    mechanism:
      "`const r = module.require; r(<the top-level vuln-lib>)`: the instance's inherited `require`, held in an alias",
    redirect:
      `const r = module.require;\n` +
      `const l2 = r(${REAL_PATH});\n` +
      `l2.parse("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // ---------------------------------------------------------------------
  // Precision: reads of `module.paths` that change nothing stay proven.
  // ---------------------------------------------------------------------
  {
    id: "precision.read-only-uses",
    finding: "RWF-129",
    mechanism:
      "`module.paths.length`, an element read and iteration change no lookup (a method call rooted in `module` is the call graph's `loader_capability_escape` on the base already)",
    redirect:
      `const n = module.paths.length;\n` +
      `const first = module.paths[0];\n` +
      `const k = n - 1;\n` +
      `const last = module.paths[k];\n` +
      `for (const dir of module.paths) { if (dir === first || dir === last) break; }\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    precisionCost:
      "the cost of BL-096's decision (ADR 0010's decision record -- BL-096; task BL-110): an index read is exempt only as `length`, and `for…of` runs the list's `Symbol.iterator`, which a module may replace",
  },
  {
    id: "precision.length-and-for-in",
    finding: "RWF-129",
    mechanism:
      "`module.paths.length` and `for…in` over the list change no lookup and run no code with the list (task BL-110: what BL-096's decision keeps)",
    redirect:
      `const n = module.paths.length;\n` +
      `for (const i in module.paths) { if (Number(i) === n) break; }\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
