import {
  type Bl096Case,
  oracleCase,
} from "./bl096-module-paths-read-only.cases.js";
import { routeLive } from "./node-release-routes.js";

/**
 * Task BL-111 (docs/tasks/BL-111-loader-writes-builtins.md): what Node's
 * own loader reads or writes BY INHERITANCE on the builtin prototypes,
 * against real Node -- RWF-156 (the loader's writes reach code a module
 * installed) and the reads the task's inventory found
 * (`scripts/bl111-loader-writes-options/inventory.md`).
 *
 * THE SETUP is BL-092's (see its cases file): the decoy
 * `wrap/node_modules/vuln-lib@99.0.0`, the affected top-level
 * `vuln-lib@1.0.0`, and `wrap/index.js` loading the decoy. Each case adds
 * statements before that load. Measured on the base (`71c62e0`, BL-110's
 * merge) with real Node v22.11.0: see each case's `base`. Real Node's
 * ground truth depends on the release (task BL-114): see each case's
 * `called`.
 */

export {
  ADVISORY_ID,
  TARGET_MARKER,
} from "./bl092-loader-capability-routes.cases.js";

export { oracleCase };

/**
 * Real Node's ground truth depends on the release (task BL-114, RWF-159):
 * `called` reads the release running the suite from
 * `node-release-routes.ts`.
 */
export interface Bl111Case extends Omit<Bl096Case, "called"> {
  readonly called: () => boolean;
}

/**
 * Why `UNKNOWN` is the sound answer on a release where real Node does not
 * call the target (task BL-114): v24.12.0 and later, and v26, give the
 * load context a null prototype, so the stored `source` is not read.
 */
const IMPORT_WIDENS =
  "on a release where the stored `source` is not read (v24.12.0 and later, v26): a dynamic `import()` is a closure-widening construct, so the closure is incomplete with or without the store, and the analyzer does not know the deployed release";

/** A benign ES module of `wrap`'s, which the case imports. */
const ESM_FILE = { "node_modules/wrap/esm.mjs": "export default 1;\n" };

/**
 * A module source that removes the store (so later loads read their own
 * files), then loads the top-level `vuln-lib` relative to `wrap/esm.mjs`
 * and calls the target.
 */
const SUBSTITUTE = `delete Object.prototype.source; import("../vuln-lib/index.js").then((l) => l.default.parse("x"));`;

export const ALL_CASES: readonly Bl111Case[] = [
  {
    id: "inherited-read.source-string",
    finding: "RWF-156",
    mechanism:
      '`Object.prototype.source = <module text>`, then `import("./esm.mjs")`: the ES module loader reads the load context\'s `source` by inheritance and evaluates the stored string instead of the file',
    redirect:
      `Object.prototype.source = ${JSON.stringify(SUBSTITUTE)};\n` +
      `import("./esm.mjs");\n`,
    files: ESM_FILE,
    called: () => routeLive("import-source"),
    base: "UNKNOWN",
    expected: "UNKNOWN",
    precisionCost: IMPORT_WIDENS,
  },
  {
    id: "inherited-read.source-unspelled-prototype",
    finding: "RWF-156",
    mechanism:
      "the same store through `({}).__proto__` -- `Object.prototype` reached without its name",
    redirect:
      `({}).__proto__.source = ${JSON.stringify(SUBSTITUTE)};\n` +
      `import("./esm.mjs");\n`,
    files: ESM_FILE,
    called: () => routeLive("import-source"),
    base: "UNKNOWN",
    expected: "UNKNOWN",
    precisionCost: IMPORT_WIDENS,
  },
  {
    id: "control.esm-import-no-store",
    finding: "RWF-156",
    mechanism: '`import("./esm.mjs")` with no store: Node evaluates the file',
    redirect: `import("./esm.mjs");\n`,
    files: ESM_FILE,
    called: () => false,
    base: "UNKNOWN",
    expected: "UNKNOWN",
    precisionCost:
      "pre-existing: a dynamic `import()` is a closure-widening construct, so the closure is incomplete with or without the store",
  },
];
