import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";
import {
  type Bl096Case,
  oracleCase,
} from "./bl096-module-paths-read-only.cases.js";
import { routeLive } from "./node-release-routes.js";

/**
 * Task BL-114 (docs/tasks/BL-114-loader-inventory-node-releases.md): the
 * loader routes BL-111's inventory, repeated on CI's Node releases, found
 * live where v22.11.0 has none, against real Node.
 *
 * THE SETUP is BL-092's (see its cases file): the decoy
 * `wrap/node_modules/vuln-lib@99.0.0`, the affected top-level
 * `vuln-lib@1.0.0`, and `wrap/index.js` loading the decoy. Each case adds
 * statements before that load.
 *
 * REAL NODE DEPENDS ON THE RELEASE. Each case's `called` reads the release
 * running the suite from `node-release-routes.ts`, the table BL-114
 * measured. A release the table does not cover fails the case.
 *
 * Measured on the base (`3cfe09d`, BL-111's merge) with real Node v20.20.2,
 * v22.11.0, v22.23.4, v24.22.1 and v26.12.1: see each case's `base`, the
 * analyzer's verdict, which no release changes.
 */

export {
  ADVISORY_ID,
  TARGET_MARKER,
} from "./bl092-loader-capability-routes.cases.js";

export { oracleCase };

export interface Bl114Case extends Omit<Bl096Case, "called"> {
  /** Whether real Node calls the target on the release running the suite. */
  readonly called: () => boolean;
}

/** The family-B proof the analyzer gives on the base for a case it misses. */
function familyB(unknownEdges: number): VerdictObservation {
  return {
    verdict: "NOT_AFFECTED",
    proofFamily: "B",
    target: "vuln-lib#parse",
    reachableSubgraphComplete: false,
    unknownEdges,
  };
}

/** `wrap`'s ES module, which re-exports a static dependency, and that dependency. */
const ESM_FILES = {
  "node_modules/wrap/esm.mjs": 'export { default } from "./dep.mjs";\n',
  "node_modules/wrap/dep.mjs": "export default 1;\n",
};

/**
 * The text stored as `source`: it removes the store (so later loads read
 * their own files), loads the top-level `vuln-lib` relative to
 * `wrap/dep.mjs`, calls the target, and exports what `esm.mjs` re-exports.
 */
const SUBSTITUTE =
  `delete Object.prototype.source; ` +
  `import("../vuln-lib/index.js").then((l) => l.default.parse("x")); ` +
  `export default 1;`;

/**
 * A module of `wrap`'s with no package scope: `readPackageScope` stops at
 * `wrap/node_modules` without finding a package.json. It loads `vuln-lib`
 * by a bare specifier, which Node resolves to the decoy.
 */
const SCOPELESS_FILES = {
  "node_modules/wrap/node_modules/helper.js": `module.exports = require("vuln-lib/index.js");\n`,
};

/**
 * Getters on `Object.prototype` for `data` and `path` that answer only a
 * `false` receiver -- v20's `trySelf` destructuring `readPackageScope`'s
 * `false` -- with a package named `vuln-lib` whose directory is the
 * top-level instance's. A setter keeps the own writes Node makes (`new
 * Module` sets `this.path`).
 */
const TRY_SELF_GETTERS =
  `const __fake = { name: "vuln-lib", exports: { "./index.js": "./index.js" } };\n` +
  `const __dir = require("path").join(__dirname, "..", "vuln-lib");\n` +
  `for (const [k, v] of [["data", __fake], ["path", __dir]]) {\n` +
  `  Object.defineProperty(Object.prototype, k, { configurable: true,\n` +
  `    get() { "use strict"; return this === false ? v : undefined; },\n` +
  `    set(x) { Object.defineProperty(this, k, { value: x, writable: true, enumerable: true, configurable: true }); } });\n` +
  `}\n`;

/** A module of `wrap`'s, loaded after the case's store, that loads `vuln-lib` by a bare specifier. */
const HELPER_FILES = {
  "node_modules/wrap/helper.js": `module.exports = require("vuln-lib/index.js");\n`,
};

const LOAD_HELPER = `require("./helper.js").parse("x");\n`;

/** The app's `node_modules`, where the affected top-level `vuln-lib` is. */
const TOP_MODULES = `require("path").join(__dirname, "..")`;

export const ALL_CASES: readonly Bl114Case[] = [
  // ---------------------------------------------------------------------
  // RWF-158: `require()` of an ES module reads `source` by inheritance for
  // its static dependencies (v20.19+, v22.12+, v24.0.0 to v24.11.1).
  // ---------------------------------------------------------------------
  {
    id: "require-esm.source-string",
    finding: "RWF-158",
    mechanism:
      '`Object.prototype.source = <module text>`, then `require("./esm.mjs")`: the ES module loader loads `esm.mjs`\'s static dependency through a load context that inherits `source`, and evaluates the stored string instead of the file',
    redirect:
      `Object.prototype.source = ${JSON.stringify(SUBSTITUTE)};\n` +
      `require("./esm.mjs");\n`,
    files: ESM_FILES,
    called: () => routeLive("require-esm-source"),
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-158", observed: familyB(0) },
  },
  {
    id: "require-esm.source-unspelled-prototype",
    finding: "RWF-158",
    mechanism:
      "the same store through `({}).__proto__` -- `Object.prototype` reached without its name",
    redirect:
      `({}).__proto__.source = ${JSON.stringify(SUBSTITUTE)};\n` +
      `require("./esm.mjs");\n`,
    files: ESM_FILES,
    called: () => routeLive("require-esm-source"),
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-158", observed: familyB(0) },
  },
  {
    id: "control.require-esm-no-store",
    finding: "RWF-158",
    mechanism:
      '`require("./esm.mjs")` with no store: Node evaluates both files (or, before v22.12, throws), and never loads the top-level `vuln-lib`',
    redirect: `require("./esm.mjs");\n`,
    files: ESM_FILES,
    called: () => false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // ---------------------------------------------------------------------
  // RWF-156: v20's `trySelf` reads `data` and `path` by inheritance for a
  // module with no package scope.
  // ---------------------------------------------------------------------
  {
    id: "try-self.scope-getters",
    finding: "RWF-156",
    mechanism:
      "getters for `data` and `path` on `Object.prototype` answering only `false`: v20's `trySelf` takes the scope-less `helper.js`'s `vuln-lib/index.js` for a self-reference and resolves it in the top-level instance's directory",
    redirect:
      TRY_SELF_GETTERS + `require("./node_modules/helper.js").parse("x");\n`,
    files: SCOPELESS_FILES,
    called: () => routeLive("try-self-scope"),
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-156", observed: familyB(9) },
  },
  {
    id: "control.try-self-no-store",
    finding: "RWF-156",
    mechanism:
      "the scope-less `helper.js` with no getters: Node resolves its `vuln-lib/index.js` to the decoy",
    redirect: `require("./node_modules/helper.js").parse("x");\n`,
    files: SCOPELESS_FILES,
    called: () => false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // ---------------------------------------------------------------------
  // RWF-160 (found by BL-114's independent audit): from v22.15.0,
  // `Module.prototype.load` does `this.paths ??= …`, so a new module with
  // no own `paths` keeps a lookup list it inherits from `Object.prototype`.
  // ---------------------------------------------------------------------
  {
    id: "inherited-paths.data-store",
    finding: "RWF-160",
    mechanism:
      "`Object.prototype.paths = [<the top-level node_modules>]`, a plain data store: `wrap/helper.js`, loaded after it, reads the inherited list (`??=` assigns nothing) and resolves `vuln-lib/index.js` to the top-level instance",
    redirect: `Object.prototype.paths = [${TOP_MODULES}];\n` + LOAD_HELPER,
    files: HELPER_FILES,
    called: () => routeLive("inherited-paths"),
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-160", observed: familyB(3) },
  },
  {
    id: "inherited-paths.unspelled-prototype",
    finding: "RWF-160",
    mechanism:
      "the same store through `({}).__proto__` -- `Object.prototype` reached without its name",
    redirect: `({}).__proto__.paths = [${TOP_MODULES}];\n` + LOAD_HELPER,
    files: HELPER_FILES,
    called: () => routeLive("inherited-paths"),
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-160", observed: familyB(3) },
  },
  {
    id: "inherited-paths.define",
    finding: "RWF-160",
    mechanism:
      '`Object.defineProperty(Object.prototype, "paths", { value: [...], writable: true, configurable: true })`: the same list, by a define call (writable, so the loader\'s own `paths` writes onto other objects still succeed)',
    redirect:
      `Object.defineProperty(Object.prototype, "paths", { value: [${TOP_MODULES}], writable: true, configurable: true });\n` +
      LOAD_HELPER,
    files: HELPER_FILES,
    called: () => routeLive("inherited-paths"),
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-160", observed: familyB(4) },
  },
  {
    id: "control.inherited-paths-no-store",
    finding: "RWF-160",
    mechanism:
      "`wrap/helper.js` with no store: Node resolves its `vuln-lib/index.js` to the decoy",
    redirect: LOAD_HELPER,
    files: HELPER_FILES,
    called: () => false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
