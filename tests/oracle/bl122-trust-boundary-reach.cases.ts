import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";
import {
  type Bl096Case,
  oracleCase,
} from "./bl096-module-paths-read-only.cases.js";

/**
 * Task BL-122 (docs/tasks/BL-122-trust-boundary-reach.md): the builtin
 * objects OUTSIDE the ECMAScript intrinsic prototypes that Node's own
 * loader touches after startup, against real Node -- the measurement the
 * project owner's decision on the trust boundary's reach rests on
 * (SOUNDNESS-CONTRACT § 1; ADR 0010, "Decision record -- BL-111", "Not
 * decided here").
 *
 * `scripts/bl122-trust-boundary-reach/probe-reach.cjs` inventories which
 * members of those objects the loader touches on a load workload. Each
 * case here changes one touched member before `wrap` loads
 * `vuln-lib/index.js`, so that real Node loads the affected top-level
 * instance instead of `wrap`'s decoy (or runs its source), and records
 * what the analyzer answers. The kinds of object, as the probe names them:
 *
 * - `o1.*` a builtin constructor's own property (RWF-161's
 *   `Array[Symbol.species]` is `tests/oracle/bl113-trust-boundary.cases.ts`'s);
 * - `o2.*` Node's own builtin prototypes (RWF-162's `URL.prototype` is
 *   BL-113's);
 * - `o3.*` a builtin module's exports object: Node's CommonJS loader calls
 *   `path` and `fs` through the same exports objects a program's
 *   `require("path")` / `require("fs")` returns;
 * - `control.*` the same program with a change that redirects nothing.
 *
 * THE SETUP is BL-092's and BL-096's (see their cases files). Measured on
 * the base (`58a5f32`, BL-113's merge) with real Node v22.11.0.
 */

export {
  ADVISORY_ID,
  TARGET_MARKER,
} from "./bl092-loader-capability-routes.cases.js";

import { routeLive } from "./node-release-routes.js";

export { oracleCase };

/** The family-B proof the analyzer gives on the base for a case it misses. */
export function familyB(unknownEdges: number): VerdictObservation {
  return {
    verdict: "NOT_AFFECTED",
    proofFamily: "B",
    target: "vuln-lib#parse",
    reachableSubgraphComplete: false,
    unknownEdges,
  };
}

/** `wrap`'s decoy directory rewritten to the affected top-level instance's. */
const REWRITE = `.replace("/wrap/node_modules/vuln-lib", "/vuln-lib")`;

/** `<object>.<member>` replaced by a wrapper rewriting its string result. */
function rewriteResult(object: string, member: string): string {
  return (
    `const __m = ${object};\n` +
    `const __o = __m.${member};\n` +
    `__m.${member} = function (...a) { const r = __o.apply(this, a); return typeof r === "string" ? r${REWRITE} : r; };\n`
  );
}

/** `<object>.<member>` replaced by a wrapper rewriting its first argument. */
function rewriteArgument(object: string, member: string): string {
  return (
    `const __m = ${object};\n` +
    `const __o = __m.${member};\n` +
    `__m.${member} = function (p, ...a) { return __o.call(this, typeof p === "string" ? p${REWRITE} : p, ...a); };\n`
  );
}

/** An identity wrapper on `<object>.<member>`: a store that redirects nothing. */
function identityWrapper(object: string, member: string): string {
  return (
    `const __m = ${object};\n` +
    `const __o = __m.${member};\n` +
    `__m.${member} = function (...a) { return __o.apply(this, a); };\n`
  );
}

export const ALL_CASES: readonly Bl096Case[] = [
  {
    id: "o3.path-resolve-assign",
    finding: "RWF-163",
    mechanism:
      '`require("path").resolve` replaced: Node\'s CommonJS loader calls `path.resolve` on the same exports object when it builds each candidate path',
    redirect: rewriteResult(`require("path")`, "resolve"),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(2) },
  },
  {
    id: "o3.path-resolve-define",
    finding: "RWF-163",
    mechanism:
      '`path.resolve` redefined with `Object.defineProperty` on `require("node:path")`',
    redirect:
      `const __o = require("node:path").resolve;\n` +
      `Object.defineProperty(require("node:path"), "resolve", { configurable: true, writable: true, value: function (...a) { const r = __o.apply(this, a); return typeof r === "string" ? r${REWRITE} : r; } });\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(3) },
  },
  {
    id: "o3.path-posix-subpath",
    finding: "RWF-163",
    mechanism:
      '`require("path/posix").resolve` replaced: on POSIX, `path/posix` is the same exports object the loader calls',
    redirect: rewriteResult(`require("path/posix")`, "resolve"),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(2) },
  },
  {
    id: "o3.path-resolve-sibling-module",
    finding: "RWF-163",
    mechanism:
      '`require("path").resolve` replaced by another module of `wrap`, loaded first',
    redirect: `require("./patch");\n`,
    files: {
      "node_modules/wrap/patch.js": rewriteResult(`require("path")`, "resolve"),
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(2) },
  },
  {
    id: "o3.fs-realpath-assign",
    finding: "RWF-163",
    mechanism:
      '`require("fs").realpathSync` replaced: the loader\'s `toRealPath` calls it on the same exports object for every resolved file',
    redirect: rewriteArgument(`require("fs")`, "realpathSync"),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(2) },
  },
  {
    id: "o3.fs-realpath-reflect-set",
    finding: "RWF-163",
    mechanism:
      '`fs.realpathSync` replaced through `Reflect.set(require("fs"), …)`',
    redirect:
      `const __o = require("fs").realpathSync;\n` +
      `Reflect.set(require("fs"), "realpathSync", function (p, ...a) { return __o.call(this, typeof p === "string" ? p${REWRITE} : p, ...a); });\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(3) },
  },
  {
    id: "o3.fs-readfile-assign",
    finding: "RWF-163",
    mechanism:
      "`require(\"fs\").readFileSync` replaced: the loader reads each `.js` file's source through it, so the decoy runs the affected instance's source",
    redirect: rewriteArgument(`require("fs")`, "readFileSync"),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(2) },
  },
  {
    id: "o3.fs-realpath-through-parameter",
    finding: "RWF-163",
    mechanism:
      '`fs.realpathSync` replaced by a function handed `require("fs")` as a parameter (graceful-fs\'s shape): the receiver is not spelled as the builtin',
    redirect:
      `function __patch(fs) { const o = fs.realpathSync; fs.realpathSync = function (p, ...a) { return o.call(this, typeof p === "string" ? p${REWRITE} : p, ...a); }; }\n` +
      `__patch(require("fs"));\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(2) },
  },
  {
    id: "o3.path-resolve-require-esm",
    finding: "RWF-163",
    mechanism:
      '`require("path").resolve` replaced before `require()` of an ES module, then restored: the lazily loaded ES module resolver keeps the replacement and resolves the module\'s `import "vuln-lib/index.js"` to the affected instance (release-dependent: `require-esm-resolver`)',
    redirect:
      `const __m = require("path");\n` +
      `const __o = __m.resolve;\n` +
      `__m.resolve = function (...a) { const r = __o.apply(this, a); return typeof r === "string" ? r${REWRITE} : r; };\n` +
      `try { require("./e.mjs"); } catch {}\n` +
      `__m.resolve = __o;\n`,
    files: {
      "node_modules/wrap/e.mjs": `import v from "vuln-lib/index.js";\nv.parse("x");\n`,
    },
    called: routeLive("require-esm-resolver"),
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(3) },
  },
  {
    id: "o3.fs-opensync-require-esm",
    finding: "RWF-163",
    mechanism:
      "`require(\"fs\").openSync` replaced before `require()` of an ES module: the ES module loader reads the source with `readFileSync(url)` and no encoding, which opens the file through `fs.openSync`, so the decoy's URL opens the affected instance's file (release-dependent: `require-esm-resolver`; BL-122's independent audit, round 2)",
    redirect:
      `const __f = require("fs");\n` +
      `const __o = __f.openSync;\n` +
      `__f.openSync = function (p, ...a) { const s = p instanceof URL ? p.href : String(p); if (s.includes("/wrap/node_modules/vuln-lib/index.js")) { const t = s${REWRITE}; return __o.call(this, p instanceof URL ? new URL(t) : t, ...a); } return __o.call(this, p, ...a); };\n` +
      `try { require("./e.mjs"); } catch {}\n` +
      `__f.openSync = __o;\n`,
    files: {
      "node_modules/wrap/e.mjs": `import v from "vuln-lib/index.js";\nv.parse("x");\n`,
    },
    called: routeLive("require-esm-resolver"),
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-163", observed: familyB(6) },
  },
  {
    id: "control.o3-require-esm-no-change",
    finding: "RWF-163",
    mechanism:
      "the ES module forms' program with no replacement: `require()` of the ES module resolves `vuln-lib/index.js` to the decoy (where the release runs it)",
    redirect: `try { require("./e.mjs"); } catch {}\n`,
    files: {
      "node_modules/wrap/e.mjs": `import v from "vuln-lib/index.js";\nv.parse("x");\n`,
    },
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "o1.array-species-unspelled",
    finding: "RWF-161",
    mechanism:
      "`Array[Symbol.species]` redefined on `[].constructor`: the `Array` constructor reached without its name",
    redirect: `Object.defineProperty([].constructor, Symbol.species, { configurable: true, get() { return function () { return new Proxy([], { set(t, k, v) { if (typeof v === "string" && v.endsWith("/wrap/node_modules")) v = "/nonexistent"; t[k] = v; return true; } }); }; } });\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-161", observed: familyB(5) },
  },
  {
    id: "o2.url-prototype-unspelled",
    finding: "RWF-162",
    mechanism:
      "a `pathname` getter on `Object.getPrototypeOf(new URL(…))`: `URL.prototype` reached without its name",
    redirect:
      `const __p = Object.getPrototypeOf(new URL("file:///x"));\n` +
      `const __d = Object.getOwnPropertyDescriptor(__p, "pathname");\n` +
      `Object.defineProperty(__p, "pathname", { configurable: true, enumerable: true, set: __d.set, get() { return __d.get.call(this).replace("/wrap/node_modules/vuln-lib/", "/vuln-lib/"); } });\n`,
    files: {
      "node_modules/wrap/node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "99.0.0",
        main: "index.js",
        exports: { ".": "./index.js", "./index.js": "./index.js" },
      }),
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-162", observed: familyB(7) },
  },
  {
    id: "control.o3-path-resolve-identity",
    finding: "RWF-163",
    mechanism:
      '`require("path").resolve` replaced by a wrapper that changes nothing: Node loads the decoy',
    redirect: identityWrapper(`require("path")`, "resolve"),
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.o3-fs-realpath-identity",
    finding: "RWF-163",
    mechanism:
      '`require("fs").realpathSync` replaced by a wrapper that changes nothing: Node loads the decoy',
    redirect: identityWrapper(`require("fs")`, "realpathSync"),
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
