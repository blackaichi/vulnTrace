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
import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";

/**
 * Task V-1 (docs/tasks/V-1-site-b-closure-corroboration.md): ADR 0011
 * invariant V's predicates 2 and 3 at `resolveTargetNodes`'s Site B, each
 * case against real Node.
 *
 * - **PRM-101**: Site B handed reachability a phantom target -- a node no
 *   edge can reach -- whenever the call graph held no node of the
 *   advisory's package, and an exhausted search over it was family C.
 *   A package loaded only through `export *` runs (its top level, or a
 *   protocol member the runtime calls on the namespace) and never gets a
 *   graph node, so the phantom certified code real Node runs.
 * - **PRM-102**: Site A or Site B was chosen by the advisory's package
 *   NAME, matched against the installed manifest's name. An instance whose
 *   manifest names it differently (a lock entry without `name`) was "never
 *   in the graph", although its files were.
 *
 * LOUD FIXTURES. Every library exports every name a case binds (`parse`,
 * the rule's target; `safe`, its inert sibling; and `toString` where the
 * case's runtime calls it), all functions, checked in real Node.
 *
 * THE CONTROLS. Each case names its own negative program, which must be
 * `NOT_AFFECTED` (and, where `negativeFamily` is set, through that proof
 * family); the positive control is the negative program after one
 * attributable direct call of `parse`.
 */

export const ADVISORY_ID = "GHSA-v1-site-b-corroboration";
export const TARGET_MARKER = "parse";

export type Finding = "PRM-101" | "PRM-102" | "RWF-078";
export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";
export type ProofFamily = "A" | "B" | "C";

/** `js`: `src/index.js`, CommonJS. `mjs`: `src/index.mjs`, ESM. */
export type Language = "js" | "mjs";

export interface V1Case {
  readonly id: string;
  readonly finding: Finding;
  /** One line: the mechanism. */
  readonly mechanism: string;
  readonly language: Language;
  /** `node_modules/vuln-lib/*`, `package.json` included. */
  readonly lib: Readonly<Record<string, string>>;
  /** `true` when `vuln-lib` is an ES module (the loud-fixture check imports it). */
  readonly libIsEsm?: boolean;
  readonly boundNames: readonly [string, ...string[]];
  /** The whole entry program. */
  readonly source: string;
  /** The negative control's whole entry program; it must be `NOT_AFFECTED`. */
  readonly negative: string;
  /** The proof family the negative control's `NOT_AFFECTED` must carry. */
  readonly negativeFamily?: ProofFamily;
  /** Further project files (the case and both controls). */
  readonly files?: Readonly<Record<string, string>>;
  /** Further installed packages, `node_modules/<name>` -> version, added to the lockfile. */
  readonly installed?: Readonly<Record<string, string>>;
  /**
   * The lockfile's whole `packages` map below the root, install path ->
   * version, in place of the one `installed` derives (nested installs).
   */
  readonly lock?: Readonly<Record<string, string>>;
  /** The positive control's whole entry program, in place of the default prefix. */
  readonly positive?: string;
  /** The specifier the loud-fixture check loads, in place of `vuln-lib`. */
  readonly loudSpecifier?: string;
  /**
   * An open soundness defect this task does not close: the case asserts
   * the record (the exact wrong result, and its open FINDINGS entry), never
   * the wrong verdict as an expectation (AGENTS.md § G).
   */
  readonly openDefect?: {
    readonly rwf: string;
    /** Every sound verdict, when more than `expected` (default: `[expected]`). */
    readonly admissible?: readonly CaseVerdict[];
    readonly observed: VerdictObservation;
  };
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /** The analyzer's verdict on the base commit, measured before the fix. */
  readonly base: CaseVerdict;
  /** The sound verdict. */
  readonly expected: CaseVerdict;
  /** For an expected `NOT_AFFECTED`: the proof family it must carry. */
  readonly expectedFamily?: ProofFamily;
  /**
   * For an expected `UNKNOWN` real Node does not reach: why `UNKNOWN` is the
   * sound answer anyway (the precision cost ADR 0011 § 5 measured).
   */
  readonly precisionCost?: string;
}

const ENTRY: Record<Language, string> = {
  js: "src/index.js",
  mjs: "src/index.mjs",
};

/** One attributable direct call of the target, in each language's own binding form. */
const POSITIVE_PREFIX: Record<Language, string> = {
  js: `const __p = require("vuln-lib");\n__p.parse("x");\n`,
  mjs: `import { parse as __parse } from "vuln-lib";\n__parse("x");\n`,
};

const FUNCTIONS = hitFunction("parse", '"p"') + hitFunction("safe", '"s"');

/** A CommonJS `vuln-lib` whose manifest name is `manifestName`. */
function cjsLib(
  manifestName: string,
  index: string,
  more: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  return {
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: manifestName,
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/vuln-lib/index.js": index,
    ...more,
  };
}

/** Real Node runs this library's top-level call when it loads. */
const TOP_LEVEL_LIB = cjsLib(
  "vuln-lib",
  HIT_HELPER_SOURCE +
    FUNCTIONS +
    `module.exports = { parse, safe };\nparse("top-level");\n`,
);

/** Loading this library calls nothing. */
const QUIET_LIB = cjsLib(
  "vuln-lib",
  HIT_HELPER_SOURCE + FUNCTIONS + `module.exports = { parse, safe };\n`,
);

/** An ES module whose `toString` export calls `parse`. */
const TO_STRING_LIB: Readonly<Record<string, string>> = {
  "node_modules/vuln-lib/package.json": JSON.stringify({
    name: "vuln-lib",
    version: "1.0.0",
    type: "module",
    exports: { ".": "./index.js" },
  }),
  "node_modules/vuln-lib/index.js":
    HIT_HELPER_SOURCE +
    `export function parse(x) { hit("parse"); return "p"; }\n` +
    `export function safe(x) { hit("safe"); return "s"; }\n` +
    `export function toString() { return parse("x"); }\n`,
};

/** `parse` is defined in `impl.js` and forwarded by `index.js`. */
function forwardingLib(manifestName: string): Readonly<Record<string, string>> {
  return cjsLib(
    manifestName,
    HIT_HELPER_SOURCE +
      hitFunction("safe", '"s"') +
      `module.exports = { parse: require("./impl"), safe };\n`,
    {
      "node_modules/vuln-lib/impl.js":
        HIT_HELPER_SOURCE +
        `module.exports = function parse(x) { hit("parse"); return "p"; };\n`,
    },
  );
}

/** `parse` is defined in `index.js` itself. */
function directLib(manifestName: string): Readonly<Record<string, string>> {
  return cjsLib(
    manifestName,
    HIT_HELPER_SOURCE + FUNCTIONS + `module.exports = { parse, safe };\n`,
  );
}

/**
 * The lockfile, in npm's shape. A `node_modules/<name>` entry carries no
 * `name` field, exactly as npm writes one for a non-aliased install, so the
 * finding's package name is the install directory's, whatever the
 * installed manifest declares (PRM-102's realism note).
 */
function packageFiles(
  lock: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  // The app depends on every top-level install.
  const dependencies = Object.fromEntries(
    Object.entries(lock)
      .filter(
        ([installPath]) => installPath.split("node_modules/").length === 2,
      )
      .map(([installPath, version]) => [
        installPath.slice("node_modules/".length),
        version,
      ]),
  );
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
          ...Object.fromEntries(
            Object.entries(lock).map(([installPath, version]) => [
              installPath,
              { version },
            ]),
          ),
        },
      },
      null,
      2,
    ),
  };
}

function project(kase: V1Case, app: string): ProjectSpec {
  const entry = ENTRY[kase.language];
  return {
    files: {
      ...packageFiles(
        kase.lock ?? {
          "node_modules/vuln-lib": "1.0.0",
          ...Object.fromEntries(
            Object.entries(kase.installed ?? {}).map(([name, version]) => [
              `node_modules/${name}`,
              version,
            ]),
          ),
        },
      ),
      ...kase.lib,
      ...(kase.files ?? {}),
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      [entry]: app,
      "vulntrace.yml": simpleConfigFile({ entrypoints: [entry] }),
    },
  };
}

export function oracleCase(kase: V1Case): OracleCase {
  return {
    id: kase.id,
    loudFixture: {
      specifier: kase.loudSpecifier ?? "vuln-lib",
      boundNames: kase.boundNames,
      ...(kase.libIsEsm ? { esm: true } : {}),
    },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(ENTRY[kase.language]),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(
            kase,
            kase.positive ?? POSITIVE_PREFIX[kase.language] + kase.negative,
          ),
        },
        negative: {
          name: "negative-control",
          project: project(kase, kase.negative),
        },
      },
    },
    variant: { name: "case", project: project(kase, kase.source) },
  };
}

/** A program that never loads `vuln-lib`: the family-A shape. */
const UNLOADED_JS = `console.log("app");\n`;
const UNLOADED_MJS = `console.log("app");\n`;

// ---------------------------------------------------------------------------
// PRM-101 -- a package loaded only through `export *`. The call graph walks
// no re-export declaration, so the package has no graph node; the module-load
// closure does walk it, so family A (instance absent) cannot fire. On the
// base, Site B fed reachability a phantom and an exhausted search was
// family C. Under V-1 a phantom never supports family C.
// ---------------------------------------------------------------------------

export const EXPORT_STAR_CASES: readonly V1Case[] = [
  {
    id: "export-star.app-barrel.top-level-call",
    finding: "PRM-101",
    mechanism:
      'the app\'s own barrel `export * from "vuln-lib"` loads it; its top level calls `parse`',
    language: "mjs",
    lib: TOP_LEVEL_LIB,
    boundNames: ["parse", "safe"],
    files: { "src/re.mjs": `export * from "vuln-lib";\n` },
    source: `import "./re.mjs";\n`,
    negative: UNLOADED_MJS,
    negativeFamily: "A",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "export-star.dependency-barrel.top-level-call",
    finding: "PRM-101",
    mechanism:
      'a dependency\'s `export * from "vuln-lib"` loads it; its top level calls `parse`',
    language: "mjs",
    lib: TOP_LEVEL_LIB,
    boundNames: ["parse", "safe"],
    installed: { wrapper: "1.0.0" },
    files: {
      "node_modules/wrapper/package.json": JSON.stringify({
        name: "wrapper",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./index.js" },
      }),
      "node_modules/wrapper/index.js":
        `export * from "vuln-lib";\n` +
        `export function other() { return 2; }\n`,
    },
    source: `import { other } from "wrapper";\nother();\n`,
    negative: UNLOADED_MJS,
    negativeFamily: "A",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "export-star.namespace-to-string",
    finding: "PRM-101",
    mechanism:
      "`String(ns)` calls the namespace's `toString`, re-exported by `export *`, which calls `parse` (task A-4's audit note)",
    language: "mjs",
    lib: TO_STRING_LIB,
    libIsEsm: true,
    boundNames: ["parse", "safe", "toString"],
    files: { "src/re.mjs": `export * from "vuln-lib";\n` },
    source: `import * as ns from "./re.mjs";\nString(ns);\n`,
    negative: UNLOADED_MJS,
    negativeFamily: "A",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "export-star.app-barrel.quiet",
    finding: "PRM-101",
    mechanism:
      "the app's barrel loads `vuln-lib`, and nothing in it calls `parse`",
    language: "mjs",
    lib: QUIET_LIB,
    boundNames: ["parse", "safe"],
    files: { "src/re.mjs": `export * from "vuln-lib";\n` },
    source: `import "./re.mjs";\n`,
    negative: UNLOADED_MJS,
    negativeFamily: "A",
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    precisionCost:
      "the package is loaded and has no graph node: no attributed target exists for family C, and family A needs it unloaded (ADR 0011 § 5's measured cost)",
  },
  {
    id: "unloaded.family-a",
    finding: "PRM-101",
    mechanism:
      "nothing loads `vuln-lib`: the correct negative Site B's phantom served, now family A's",
    language: "js",
    lib: TOP_LEVEL_LIB,
    boundNames: ["parse", "safe"],
    source: UNLOADED_JS,
    negative: UNLOADED_JS,
    negativeFamily: "A",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
    expectedFamily: "A",
  },
];

// ---------------------------------------------------------------------------
// PRM-102 -- the instance at `node_modules/vuln-lib` declares the manifest
// name `vuln-lib-fork`. The call graph holds its files; on the base, the
// name-keyed lookup found "no instance of vuln-lib" and took Site B.
// ---------------------------------------------------------------------------

const REQUIRE_LIB = `const lib = require("vuln-lib");\n`;

export const NAME_MISMATCH_CASES: readonly V1Case[] = [
  {
    id: "name-mismatch.forwarded",
    finding: "PRM-102",
    mechanism:
      "manifest name `vuln-lib-fork`; `index.js` forwards `parse` from `impl.js`, which the app calls",
    language: "js",
    lib: forwardingLib("vuln-lib-fork"),
    boundNames: ["parse", "safe"],
    source: REQUIRE_LIB + `lib.parse("x");\n`,
    negative: REQUIRE_LIB + `lib.safe("x");\n`,
    negativeFamily: "C",
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "name-mismatch.direct",
    finding: "PRM-102",
    mechanism:
      "manifest name `vuln-lib-fork`; `index.js` defines `parse`, which the app calls",
    language: "js",
    lib: directLib("vuln-lib-fork"),
    boundNames: ["parse", "safe"],
    source: REQUIRE_LIB + `lib.parse("x");\n`,
    negative: REQUIRE_LIB + `lib.safe("x");\n`,
    negativeFamily: "C",
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "name-mismatch.forwarded.matching-name",
    finding: "PRM-102",
    mechanism:
      "the same forwarding package under its own name: the contrast that Site A already answers",
    language: "js",
    lib: forwardingLib("vuln-lib"),
    boundNames: ["parse", "safe"],
    source: REQUIRE_LIB + `lib.parse("x");\n`,
    negative: REQUIRE_LIB + `lib.safe("x");\n`,
    negativeFamily: "C",
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
];

// ---------------------------------------------------------------------------
// The same instance-keyed selection, nested: a top-level `vuln-lib` (99.0.0,
// outside the advisory's range, so it is no finding) is in the graph, and
// the finding is `node_modules/a/node_modules/vuln-lib`, whose manifest
// says `vuln-lib-fork`. On the base the name-keyed lookup found the
// top-level install, not this one, and took the family-B branch, which the
// closure (it loads the nested instance) refused: UNKNOWN. V-1 takes Site
// A on the exact instance (found by task V-1's independent audit).
// ---------------------------------------------------------------------------

/** `files` re-rooted from `node_modules/vuln-lib/` to `prefix`. */
function rerooted(
  files: Readonly<Record<string, string>>,
  prefix: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(files).map(([file, content]) => [
      file.replace(/^node_modules\/vuln-lib\//, prefix),
      content,
    ]),
  );
}

const NESTED_TOP_LIB: Readonly<Record<string, string>> = {
  "node_modules/vuln-lib/package.json": JSON.stringify({
    name: "vuln-lib",
    version: "99.0.0",
    main: "index.js",
  }),
  "node_modules/vuln-lib/index.js":
    HIT_HELPER_SOURCE + FUNCTIONS + `module.exports = { parse, safe };\n`,
};

const NESTED_FILES: Readonly<Record<string, string>> = {
  "node_modules/a/package.json": JSON.stringify({
    name: "a",
    version: "1.0.0",
    main: "index.js",
  }),
  "node_modules/a/index.js":
    `const v = require("vuln-lib");\n` +
    `exports.safe = (x) => v.safe(x);\n` +
    `exports.parse = (x) => v.parse(x);\n`,
  ...rerooted(
    forwardingLib("vuln-lib-fork"),
    "node_modules/a/node_modules/vuln-lib/",
  ),
};

const NESTED_LOCK: Readonly<Record<string, string>> = {
  "node_modules/vuln-lib": "99.0.0",
  "node_modules/a": "1.0.0",
  "node_modules/a/node_modules/vuln-lib": "1.0.0",
};

const NESTED_SAFE =
  `const top = require("vuln-lib");\ntop.safe("x");\n` +
  `const a = require("a");\na.safe("x");\n`;
const NESTED_PARSE =
  `const top = require("vuln-lib");\ntop.safe("x");\n` +
  `const a = require("a");\na.parse("x");\n`;

export const NESTED_CASES: readonly V1Case[] = [
  {
    id: "name-mismatch.nested.safe",
    finding: "PRM-102",
    mechanism:
      "a nested fork-named instance, loaded through `a`, whose `parse` nothing calls, beside a same-named top-level install",
    language: "js",
    lib: NESTED_TOP_LIB,
    files: NESTED_FILES,
    lock: NESTED_LOCK,
    loudSpecifier: "./node_modules/a/node_modules/vuln-lib",
    boundNames: ["parse", "safe"],
    source: NESTED_SAFE,
    negative: NESTED_SAFE,
    negativeFamily: "C",
    positive: NESTED_PARSE,
    called: false,
    base: "UNKNOWN",
    expected: "NOT_AFFECTED",
    expectedFamily: "C",
  },
  {
    id: "name-mismatch.nested.parse",
    finding: "PRM-102",
    mechanism: "the same nested fork-named instance, whose `parse` `a` calls",
    language: "js",
    lib: NESTED_TOP_LIB,
    files: NESTED_FILES,
    lock: NESTED_LOCK,
    loudSpecifier: "./node_modules/a/node_modules/vuln-lib",
    boundNames: ["parse", "safe"],
    source: NESTED_PARSE,
    negative: NESTED_SAFE,
    negativeFamily: "C",
    positive: NESTED_PARSE,
    called: true,
    base: "UNKNOWN",
    expected: "AFFECTED",
  },
];

// ---------------------------------------------------------------------------
// RWF-078 -- PRM-101's mechanism at Site A, which V-1 does not close: one of
// the package's files is in the graph (the app imports it for its side
// effect), so Site A attributes the real `impl.js#parse`; the module that
// calls it, `index.js`, is loaded only through `export *`, which the call
// graph does not evaluate. Found by task V-1's independent audit; an open
// soundness defect, asserted as a record, never as an expectation.
// ---------------------------------------------------------------------------

/** `index.js` calls `parse` (from `impl.js`) at its top level. */
function topLevelForwardingLib(
  manifestName: string,
): Readonly<Record<string, string>> {
  return cjsLib(
    manifestName,
    HIT_HELPER_SOURCE +
      hitFunction("safe", '"s"') +
      `const parse = require("./impl");\nparse("top-level");\n` +
      `module.exports = { parse, safe };\n`,
    {
      "node_modules/vuln-lib/impl.js":
        HIT_HELPER_SOURCE +
        `module.exports = function parse(x) { hit("parse"); return "p"; };\n`,
    },
  );
}

const TOP_LEVEL_FORWARDING_LIB = topLevelForwardingLib("vuln-lib");

/**
 * RWF-078's shape in a dependency, over a nested fork-named instance: `a`
 * (ESM) side-effect-imports `vuln-lib/impl.js` and re-exports the rest of
 * `vuln-lib` with `export *`. `a/other.js` loads nothing; `a/caller.cjs`
 * calls `parse` directly (the positive control).
 */
const REEXPORTING_DEPENDENCY: Readonly<Record<string, string>> = {
  "node_modules/a/package.json": JSON.stringify({
    name: "a",
    version: "1.0.0",
    type: "module",
    main: "index.js",
  }),
  "node_modules/a/index.js":
    `import "vuln-lib/impl.js";\n` +
    `export * from "vuln-lib";\n` +
    `export function other() { return 1; }\n`,
  "node_modules/a/other.js": `export function other() { return 1; }\n`,
  "node_modules/a/caller.cjs":
    `const v = require("vuln-lib");\n` +
    `exports.callParse = function (x) { return v.parse(x); };\n`,
  ...rerooted(
    topLevelForwardingLib("vuln-lib-fork"),
    "node_modules/a/node_modules/vuln-lib/",
  ),
};

const TOP_SAFE = `import top from "vuln-lib";\ntop.safe("x");\n`;

export const SITE_A_CASES: readonly V1Case[] = [
  {
    id: "export-star.site-a.side-effect-import",
    finding: "RWF-078",
    mechanism:
      '`import "vuln-lib/impl.js"` puts the package in the graph; `export * from "vuln-lib"` runs `index.js`, whose top level calls `parse`',
    language: "mjs",
    lib: TOP_LEVEL_FORWARDING_LIB,
    boundNames: ["parse", "safe"],
    files: { "src/re.mjs": `export * from "vuln-lib";\n` },
    source: `import "vuln-lib/impl.js";\nimport "./re.mjs";\n`,
    negative: `import "vuln-lib/impl.js";\n`,
    negativeFamily: "C",
    openDefect: {
      rwf: "RWF-078",
      admissible: ["UNKNOWN", "AFFECTED"],
      observed: {
        verdict: "NOT_AFFECTED",
        proofFamily: "C",
        target: "vuln-lib#parse",
        reachableSubgraphComplete: true,
        unknownEdges: 0,
      },
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];

/**
 * RWF-078 REACHED BY V-1 (task V-1's re-audit, finding 1). The finding is
 * the nested fork-named instance. On the base the name-keyed lookup sent it
 * to the family-B branch, which a closure loading it refused: UNKNOWN. V-1
 * selects Site A by the exact instance, and Site A has RWF-078's gap, so
 * the branch answers a false NOT_AFFECTED -- the same answer the base
 * already gives when the nested instance's manifest name matches. Recorded,
 * not expected; whether V-1 may ship with it is the project owner's
 * decision (docs/tasks/V-1-site-b-closure-corroboration.md, Corrections).
 */
export const RWF078_REACHED_BY_V1: readonly V1Case[] = [
  {
    id: "export-star.nested-fork.reached-by-v1",
    finding: "RWF-078",
    mechanism:
      "a dependency side-effect-imports a nested fork-named `vuln-lib`'s `impl.js` and re-exports it with `export *`; its `index.js` calls `parse` at its top level",
    language: "mjs",
    lib: NESTED_TOP_LIB,
    files: REEXPORTING_DEPENDENCY,
    lock: NESTED_LOCK,
    loudSpecifier: "./node_modules/a/node_modules/vuln-lib",
    boundNames: ["parse", "safe"],
    source: TOP_SAFE + `import { other } from "a";\nother();\n`,
    negative: TOP_SAFE + `import { other } from "a/other.js";\nother();\n`,
    positive:
      TOP_SAFE + `import { callParse } from "a/caller.cjs";\ncallParse("x");\n`,
    negativeFamily: "B",
    openDefect: {
      rwf: "RWF-078",
      admissible: ["UNKNOWN", "AFFECTED"],
      observed: {
        verdict: "NOT_AFFECTED",
        proofFamily: "C",
        target: "vuln-lib#parse",
        reachableSubgraphComplete: true,
        unknownEdges: 0,
      },
    },
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
];

export const ALL_CASES: readonly V1Case[] = [
  ...EXPORT_STAR_CASES,
  ...NAME_MISMATCH_CASES,
  ...NESTED_CASES,
  ...SITE_A_CASES,
  ...RWF078_REACHED_BY_V1,
];
