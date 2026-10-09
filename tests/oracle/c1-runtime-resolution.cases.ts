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
 * Task C-1 (docs/tasks/C-1-runtime-resolution-mode.md): ADR 0010
 * invariant C2 -- every resolution that decides which file Node loads uses
 * Node's algorithm, whatever the project's tsconfig says -- against real
 * Node.
 *
 * PRM-33 (docs/audits/2026-09-premise-sweep-round-1.md § 4,
 * `tsconfig-commonjs-ignores-exports`): `wrap`'s `main` is `legacy.js`
 * (calls `safe`), its `exports` map sends `require` to `cjs/impl.cjs`
 * (calls `parse`). Real Node loads `impl.cjs`. Under `module: commonjs`
 * TypeScript resolves with node10, which ignores `exports`, so the
 * analyzer read `legacy.js` and family A / C certified `parse` unreached.
 *
 * RWF-083 (found by this task): a tsconfig `paths` entry, or a bare
 * `baseUrl`, that shadows an installed package. TypeScript resolves the
 * local file under every `moduleResolution`; Node never reads tsconfig and
 * loads `node_modules/wrap`. By the project owner's decision 7 (strict C2,
 * confirmed 2026-10-09) a mapping that disagrees with Node makes the
 * specifier `unresolved_module`: `UNKNOWN`, never either answer silently.
 *
 * Measured on the base (ab8b278), before the fix: see each case's `base`.
 *
 * LOUD FIXTURE. `vuln-lib` exports `parse` (the rule's target) and `safe`,
 * both functions; every `wrap` file and every local shim exports `run`.
 *
 * THE CONTROLS. No tsconfig mapping: the negative control's `wrap` calls
 * `safe` (family C, `NOT_AFFECTED`); the positive control adds one direct
 * call of `parse`.
 */

export const ADVISORY_ID = "GHSA-c1-runtime-resolution";
export const TARGET_MARKER = "parse";

export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

export interface C1Case {
  readonly id: string;
  /** One line: the mechanism. */
  readonly mechanism: string;
  /** Files under the project root, besides the manifests, `vuln-lib`, rules and config. */
  readonly files: Readonly<Record<string, string>>;
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /** The verdict on the base commit, measured before the fix. */
  readonly base: CaseVerdict;
  /** The sound verdict. */
  readonly expected: CaseVerdict;
  /** For an `UNKNOWN`: the uncertainty reason it must carry. */
  readonly expectedReason?: string;
  /**
   * For an expected `UNKNOWN` real Node does not reach: why `UNKNOWN` is
   * the sound answer anyway.
   */
  readonly precisionCost?: string;
}

const ENTRY = "src/index.js";

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
};

/** A CommonJS module whose `run` calls `vuln-lib`'s `name`. */
function runCalling(name: "parse" | "safe"): string {
  return (
    `const lib = require("vuln-lib");\n` +
    `exports.run = function run(x) { return lib.${name}(x); };\n`
  );
}

/** `wrap`, installed: `main` reads `safe`, the `exports` map's `require` reads `parse`. */
const WRAP_EXPORTS: Readonly<Record<string, string>> = {
  "node_modules/wrap/package.json": JSON.stringify({
    name: "wrap",
    version: "1.0.0",
    main: "./legacy.js",
    exports: { ".": { require: "./cjs/impl.cjs" } },
  }),
  "node_modules/wrap/legacy.js": runCalling("safe"),
  "node_modules/wrap/cjs/impl.cjs": runCalling("parse"),
};

/** `wrap`, installed, no `exports`: its one file calls `name`. */
function plainWrap(name: "parse" | "safe"): Readonly<Record<string, string>> {
  return {
    "node_modules/wrap/package.json": JSON.stringify({
      name: "wrap",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/wrap/index.js": runCalling(name),
  };
}

const APP = `const w = require("wrap");\nw.run("x");\n`;

function tsconfig(compilerOptions: Record<string, unknown>): string {
  return JSON.stringify({
    compilerOptions: { allowJs: true, ...compilerOptions },
  });
}

const NEGATIVE: Readonly<Record<string, string>> = {
  ...plainWrap("safe"),
  [ENTRY]: APP,
};

const POSITIVE: Readonly<Record<string, string>> = {
  ...NEGATIVE,
  [ENTRY]: APP + `const lib = require("vuln-lib");\nlib.parse("x");\n`,
};

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
          "node_modules/wrap": { version: "1.0.0" },
        },
      },
      null,
      2,
    ),
  };
}

function project(files: Readonly<Record<string, string>>): ProjectSpec {
  return {
    files: {
      ...packageFiles(),
      ...LIB,
      ...files,
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "vulntrace.yml": simpleConfigFile({ entrypoints: [ENTRY] }),
    },
  };
}

export function oracleCase(kase: C1Case): OracleCase {
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
        positive: { name: "positive-control", project: project(POSITIVE) },
        negative: { name: "negative-control", project: project(NEGATIVE) },
      },
    },
    variant: { name: "case", project: project(kase.files) },
  };
}

export const ALL_CASES: readonly C1Case[] = [
  {
    id: "prm33.module-commonjs.exports-require",
    mechanism:
      "PRM-33 itself: `module: commonjs` makes TypeScript resolve with node10, which ignores `wrap`'s `exports` and reads `main`; Node loads the `require` target, which calls `parse`",
    files: {
      ...WRAP_EXPORTS,
      [ENTRY]: APP,
      "tsconfig.json": tsconfig({ module: "commonjs" }),
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "prm33.module-resolution-node10.exports-require",
    mechanism:
      "the same package under an explicit `moduleResolution: node10` (with `module: es2020`)",
    files: {
      ...WRAP_EXPORTS,
      [ENTRY]: APP,
      "tsconfig.json": tsconfig({
        module: "es2020",
        moduleResolution: "node10",
      }),
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "rwf083.paths-shadows-installed-package",
    mechanism:
      "a `paths` entry maps `wrap` to a local shim that calls `safe`; Node never reads tsconfig and loads `node_modules/wrap`, which calls `parse`",
    files: {
      ...plainWrap("parse"),
      "src/shim/wrap.js": runCalling("safe"),
      [ENTRY]: APP,
      "tsconfig.json": tsconfig({
        module: "nodenext",
        moduleResolution: "nodenext",
        baseUrl: ".",
        paths: { wrap: ["src/shim/wrap.js"] },
      }),
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "unresolved_module",
  },
  {
    id: "rwf083.base-url-shadows-installed-package",
    mechanism:
      "a bare `baseUrl: ./src` makes TypeScript resolve `wrap` to `src/wrap/index.js` (calls `safe`); Node loads `node_modules/wrap` (calls `parse`)",
    files: {
      ...plainWrap("parse"),
      "src/wrap/index.js": runCalling("safe"),
      [ENTRY]: APP,
      "tsconfig.json": tsconfig({
        module: "commonjs",
        moduleResolution: "node10",
        baseUrl: "./src",
      }),
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "unresolved_module",
  },
  {
    id: "c2.paths-alias-node-cannot-resolve",
    mechanism:
      "the ADV-023 / ADV2-015 shape: `@lib/wrapper.js` exists only through a `paths` mapping; real Node throws MODULE_NOT_FOUND before anything runs",
    files: {
      ...plainWrap("safe"),
      "src/lib/wrapper.js": runCalling("parse"),
      [ENTRY]: `const w = require("@lib/wrapper.js");\nw.run("x");\n`,
      "tsconfig.json": tsconfig({
        module: "nodenext",
        moduleResolution: "nodenext",
        baseUrl: ".",
        paths: { "@lib/*": ["src/lib/*"] },
      }),
    },
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "unresolved_module",
    precisionCost:
      "the program only runs under a toolchain that rewrites or honours `paths` (a bundler, `tsconfig-paths`); which file that toolchain loads is not Node's answer, so the path through the alias is not authoritative (the project owner's decision of 2026-10-09; REMEDIATION-PLAN § 6.1 decisions 6 and 7)",
  },
  {
    id: "c2.paths-mapping-agrees-with-node",
    mechanism:
      "a `paths` entry that names the very file Node loads (`node_modules/wrap/index.js`, which calls `parse`): no disagreement, so the resolution stands",
    files: {
      ...plainWrap("parse"),
      [ENTRY]: APP,
      "tsconfig.json": tsconfig({
        module: "nodenext",
        moduleResolution: "nodenext",
        baseUrl: ".",
        paths: { wrap: ["node_modules/wrap/index.js"] },
      }),
    },
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
];
