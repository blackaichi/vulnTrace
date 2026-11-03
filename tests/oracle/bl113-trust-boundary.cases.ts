import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";
import {
  type Bl096Case,
  oracleCase,
} from "./bl096-module-paths-read-only.cases.js";

/**
 * Task BL-113 (docs/tasks/BL-113-loader-trust-boundary.md): the edges of
 * the trust boundary (SOUNDNESS-CONTRACT § 1), against real Node, with
 * RWF-156's mechanism, a change Node's own loader acts on by inheritance:
 *
 * - `outside.*`: a change to a builtin object that is NOT an intrinsic
 *   prototype, outside the boundary as BL-113 worded it (RWF-161, RWF-162,
 *   then open defects). Task BL-126: the project owner widened the
 *   boundary to every built-in object (ADR 0010, "Decision record --
 *   BL-122", option (W-all)), so these are trust-boundary cases
 *   (`boundaryCase`), never an expectation; the case's `expected` is the
 *   verdict that is sound WITHOUT the boundary;
 * - `modeled.*`: the same change onto Node's own `Module.prototype`, a
 *   module loader object, which stays inside the claim under (W-all), and
 *   which the analyzer already answers `UNKNOWN` for;
 * - `control.*`: the same program without the change.
 *
 * THE SETUP is BL-092's and BL-096's (see their cases files): the decoy
 * `wrap/node_modules/vuln-lib@99.0.0`, the affected top-level
 * `vuln-lib@1.0.0`, and `wrap/index.js` loading the decoy. Measured on the
 * base (`03449a1`, BL-121's merge) with real Node v22.11.0.
 */

export {
  ADVISORY_ID,
  TARGET_MARKER,
} from "./bl092-loader-capability-routes.cases.js";

export { oracleCase };

/** Drops `wrap`'s own `node_modules` from a lookup list handed to it. */
const DROP =
  `function __drop(a) {\n` +
  `  if (Array.isArray(a) && typeof a[0] === "string" && a[0].endsWith("/wrap/node_modules")) a.shift();\n` +
  `}\n`;

/**
 * A `paths` setter installed on `route` by the entry before it loads
 * `wrap`: `Module.prototype.load`'s store of `wrap`'s new lookup list runs
 * it, and it drops `wrap`'s own `node_modules` (as RWF-156's
 * `audit2.paths-setter-in-entry`, on `Object.prototype`).
 */
function pathsSetterInEntry(route: string): string {
  return (
    DROP +
    `Object.defineProperty(${route}, "paths", { configurable: true, set(v) { __drop(v); Object.defineProperty(this, "paths", { value: v, writable: true, enumerable: true, configurable: true }); } });\n` +
    `require("wrap");\n`
  );
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

/** The decoy `vuln-lib@99.0.0` with an `exports` field (RWF-162). */
const DECOY_WITH_EXPORTS: Readonly<Record<string, string>> = {
  "node_modules/wrap/node_modules/vuln-lib/package.json": JSON.stringify({
    name: "vuln-lib",
    version: "99.0.0",
    main: "index.js",
    exports: { ".": "./index.js", "./index.js": "./index.js" },
  }),
};

export const ALL_CASES: readonly Bl096Case[] = [
  {
    id: "outside.array-species-own",
    finding: "RWF-161",
    mechanism:
      "`Array[Symbol.species]` redefined on the constructor, no prototype changed: the loader's `ArrayPrototypeSlice` of the lookup paths builds the getter's Proxy, and its `unshift` writes `wrap`'s directories into it",
    redirect: `Object.defineProperty(Array, Symbol.species, { configurable: true, get() { return function () { return new Proxy([], { set(t, k, v) { if (typeof v === "string" && v.endsWith("/wrap/node_modules")) v = "/nonexistent"; t[k] = v; return true; } }); }; } });\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    boundaryCase: {
      rwf: "RWF-161",
      observed: familyB(5),
      control: "control.no-change",
    },
  },
  {
    id: "outside.url-prototype-pathname",
    finding: "RWF-162",
    mechanism:
      "a `pathname` getter on `URL.prototype` (Node's own builtin prototype, not an intrinsic): the decoy declares `exports`, so Node's CommonJS loader resolves it through `fileURLToPath`, which reads the getter's path",
    redirect:
      `const __d = Object.getOwnPropertyDescriptor(URL.prototype, "pathname");\n` +
      `Object.defineProperty(URL.prototype, "pathname", { configurable: true, enumerable: true, set: __d.set, get() { return __d.get.call(this).replace("/wrap/node_modules/vuln-lib/", "/vuln-lib/"); } });\n`,
    files: DECOY_WITH_EXPORTS,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    boundaryCase: {
      rwf: "RWF-162",
      observed: familyB(5),
      control: "control.url-exports-no-change",
    },
  },
  {
    id: "control.no-change",
    finding: "RWF-161",
    mechanism:
      "the setup with no change to any built-in object: Node loads the decoy (task BL-126)",
    redirect: ``,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.url-exports-no-change",
    finding: "RWF-162",
    mechanism:
      "the same decoy with `exports`, no change: Node resolves `vuln-lib/index.js` to the decoy",
    redirect: ``,
    files: DECOY_WITH_EXPORTS,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "modeled.module-prototype-require-module",
    finding: "RWF-156",
    mechanism:
      'a `paths` setter on `require("module").prototype`, in the entry: Node\'s own loader object, modeled',
    redirect: ``,
    entry: pathsSetterInEntry(`require("module").prototype`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "modeled.module-prototype-get-prototype-of",
    finding: "RWF-156",
    mechanism:
      "a `paths` setter on `Object.getPrototypeOf(module)`, in the entry: `Module.prototype` without its name, modeled",
    redirect: ``,
    entry: pathsSetterInEntry(`Object.getPrototypeOf(module)`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "modeled.module-prototype-constructor",
    finding: "RWF-156",
    mechanism:
      "a `paths` setter on `module.constructor.prototype`, in the entry: `Module.prototype` through `constructor`, modeled",
    redirect: ``,
    entry: pathsSetterInEntry(`module.constructor.prototype`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
];
