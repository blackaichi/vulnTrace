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

/**
 * Task V-2 (docs/tasks/V-2-traversal-truncated-blocks-negative-proof.md):
 * ADR 0011 invariant V's predicate 1 -- a family B or C proof needs a
 * module-load closure whose incompleteness list is empty, including
 * `traversal_truncated` -- against real Node.
 *
 * PRM-23 (docs/audits/2026-09-premise-sweep-round-1.md § 4,
 * `closure-truncation-hides-hook`): with `analysis.limits.maxFiles` low, the
 * closure spends its budget on four re-export-only modules the call graph
 * never walks, so the graph is not truncated, and stops before `hook.cjs`,
 * which makes `require("./safe.cjs")` load `vuln-lib`, so `s.parse("x")`
 * calls the target.
 *
 * Measured on the base (b7daa95), before the fix: every case below is
 * already `UNKNOWN`, for two reasons that came after the round-1 report.
 * The call graph walks `hook.cjs` (`a.cjs` requires it) and, since lane A,
 * withdraws family C on the hook itself: a write into `require.cache` is
 * a `protocol_value` (an assignment into a builtin value is an escape,
 * task A-3a), and the round-1 hook's call of the original
 * `Module.prototype.require` is `module_internal_load`. And task V-1's
 * family-C closure corroboration (ADR 0011, Amendment V-1) withdraws it
 * when the re-export-only modules are loaded but never evaluated
 * (`loaded_module_not_evaluated`). In production that second guard is
 * general by a counting argument, not by predicate 1: the closure
 * truncates only after loading exactly `maxFiles` files, so when every
 * loaded module is evaluated the graph holds `maxFiles` files and
 * `scan.ts` marks it truncated too.
 *
 * So these cases pin the REASON where task V-2 moves it: a truncated
 * closure now withdraws families B and C by its own record,
 * `traversal_truncated` (`budget_exceeded`), ahead of the counting
 * argument. The verdict-level failing-first tests are the unit tests over
 * `buildFinding` (verdict.negative-proof.test.ts case 10b, the F4
 * family-C row `closure_incomplete_traversal_truncated`), where the two
 * limits are independent.
 *
 * LOUD FIXTURE. `vuln-lib` exports `parse` (the rule's target) and `safe`,
 * both functions, checked in real Node.
 *
 * THE CONTROLS. The negative control is the program without the hook and
 * without the barrel, untruncated: family C, `NOT_AFFECTED`. The positive
 * control is the negative program after one direct call of `parse`.
 */

export const ADVISORY_ID = "GHSA-v2-traversal-truncated";
export const TARGET_MARKER = "parse";

export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

export interface V2Case {
  readonly id: string;
  /** One line: the mechanism. */
  readonly mechanism: string;
  /** Files under the project root (the app), besides the manifest, rules and config. */
  readonly files: Readonly<Record<string, string>>;
  /** `analysis.limits.maxFiles`; the default limit when absent. */
  readonly maxFiles?: number;
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /** The verdict and first uncertainty reason on the base commit, measured before the fix. */
  readonly base: { readonly verdict: CaseVerdict; readonly reason: string };
  /** The sound verdict. */
  readonly expected: CaseVerdict;
  /** The uncertainty reason the `UNKNOWN` must carry. */
  readonly expectedReason: string;
  /**
   * For an expected `UNKNOWN` real Node does not reach: why `UNKNOWN` is
   * the sound answer anyway.
   */
  readonly precisionCost?: string;
}

const ENTRY = "src/index.mjs";

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

/**
 * `require("./safe.cjs")` returns `vuln-lib`'s exports: one `require.cache`
 * entry copied over another. The closure records it
 * (`loader_hook_mutation`) when it reaches the file; the call graph, which
 * walks it, withdraws family C on it first (`protocol_value`).
 */
const HOOK =
  `const path = require("path");\n` +
  `require("vuln-lib");\n` +
  `const c = require.cache;\n` +
  `c[path.join(__dirname, "safe.cjs")] = c[path.join(__dirname, "..", "node_modules", "vuln-lib", "index.js")];\n`;

/**
 * The round-1 reproduction's own hook: `Module.prototype.require` patched
 * to load `vuln-lib` for `./safe.cjs`. Its call of the original `require`
 * is an edge the call graph withdraws family C on (`module_internal_load`).
 */
const ROUND_1_HOOK =
  `const Module = require("module");\n` +
  `const orig = Module.prototype.require;\n` +
  `Module.prototype.require = function (id) {\n` +
  `  return orig.call(this, id === "./safe.cjs" ? "vuln-lib" : id);\n` +
  `};\n`;

const INERT_HOOK =
  `const path = require("path");\n` +
  `require("vuln-lib");\n` +
  `const c = require.cache;\n`;

const SAFE = `function parse(x) { return "local"; }\nmodule.exports = { parse };\n`;

/** Calls `safe`, then the local `parse` -- which the hook makes `vuln-lib`'s. */
const A =
  `require("./hook.cjs");\n` +
  `const lib = require("vuln-lib");\n` +
  `lib.safe("x");\n` +
  `const s = require("./safe.cjs");\n` +
  `s.parse("x");\n`;

/**
 * The round-1 reproduction: `m.mjs` loads `a.cjs` and four re-export-only
 * modules. Breadth first, the closure loads `index`, `m`, `a`, `r1`..`r4`
 * -- seven files -- and stops before `hook.cjs`.
 */
function barrel(hook: string): Readonly<Record<string, string>> {
  return {
    [ENTRY]: `import "./m.mjs";\n`,
    "src/m.mjs":
      `import "./a.cjs";\n` +
      `export * from "./r1.mjs";\n` +
      `export * from "./r2.mjs";\n` +
      `export * from "./r3.mjs";\n` +
      `export * from "./r4.mjs";\n`,
    "src/r1.mjs": `export const r1 = 1;\n`,
    "src/r2.mjs": `export const r2 = 2;\n`,
    "src/r3.mjs": `export const r3 = 3;\n`,
    "src/r4.mjs": `export const r4 = 4;\n`,
    "src/a.cjs": A,
    "src/hook.cjs": hook,
    "src/safe.cjs": SAFE,
  };
}

const NEGATIVE: Readonly<Record<string, string>> = {
  [ENTRY]: `import "./a.cjs";\n`,
  "src/a.cjs": `const lib = require("vuln-lib");\nlib.safe("x");\n`,
};

const POSITIVE: Readonly<Record<string, string>> = {
  ...NEGATIVE,
  "src/a.cjs": `const lib = require("vuln-lib");\nlib.safe("x");\nlib.parse("x");\n`,
};

function project(
  files: Readonly<Record<string, string>>,
  maxFiles?: number,
): ProjectSpec {
  return {
    files: {
      ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
      ...LIB,
      ...files,
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "vulntrace.yml": simpleConfigFile({
        entrypoints: [ENTRY],
        ...(maxFiles !== undefined ? { maxFiles } : {}),
      }),
    },
  };
}

export function oracleCase(kase: V2Case): OracleCase {
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
    variant: { name: "case", project: project(kase.files, kase.maxFiles) },
  };
}

export const ALL_CASES: readonly V2Case[] = [
  {
    id: "truncated.reexport-barrel.cache-hook",
    mechanism:
      "the closure spends `maxFiles: 7` on re-export-only modules and stops before the hook that makes `./safe.cjs` load `vuln-lib`; the call graph walks the hook and withdraws family C on its `require.cache` write",
    files: barrel(HOOK),
    maxFiles: 7,
    called: true,
    base: { verdict: "UNKNOWN", reason: "protocol_value" },
    expected: "UNKNOWN",
    expectedReason: "protocol_value",
  },
  {
    id: "truncated.reexport-barrel.inert-hook",
    mechanism:
      "the same truncated closure; the hook redirects nothing, so `parse` is never called",
    files: barrel(INERT_HOOK),
    maxFiles: 7,
    called: false,
    base: { verdict: "UNKNOWN", reason: "loaded_module_not_evaluated" },
    expected: "UNKNOWN",
    expectedReason: "traversal_truncated",
    precisionCost:
      "the closure never examined `hook.cjs` or what it loads: no complete account of the modules that run exists, so no negative proof does (ADR 0011 predicate 1)",
  },
  {
    id: "untruncated.reexport-barrel.cache-hook",
    mechanism:
      "the default limit: the closure reaches the hook too (`loader_hook_mutation`), and the call graph's `protocol_value` answers first",
    files: barrel(HOOK),
    called: true,
    base: { verdict: "UNKNOWN", reason: "protocol_value" },
    expected: "UNKNOWN",
    expectedReason: "protocol_value",
  },
  {
    id: "truncated.reexport-barrel.round-1-hook",
    mechanism:
      "the round-1 reproduction itself at `maxFiles: 7`: the `Module.prototype.require` patch; the call graph walks it and withdraws family C on the original `require`'s call",
    files: barrel(ROUND_1_HOOK),
    maxFiles: 7,
    called: true,
    base: { verdict: "UNKNOWN", reason: "module_internal_load" },
    expected: "UNKNOWN",
    expectedReason: "module_internal_load",
  },
  {
    id: "untruncated.reexport-barrel.round-1-hook",
    mechanism: "the round-1 hook at the default limit",
    files: barrel(ROUND_1_HOOK),
    called: true,
    base: { verdict: "UNKNOWN", reason: "module_internal_load" },
    expected: "UNKNOWN",
    expectedReason: "module_internal_load",
  },
];
