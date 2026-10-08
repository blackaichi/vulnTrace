import type { OracleCase } from "../../src/testing/oracle/case.js";
import {
  simpleConfigFile,
  simplePackageFiles,
  simpleRuleFile,
  type EntrypointSpec,
} from "../../src/testing/oracle/config-files.js";
import { nodeSymbolEntryCommand } from "../../src/testing/oracle/ground-truth.js";
import {
  HIT_HELPER_SOURCE,
  hitFunction,
} from "../../src/testing/oracle/hit.js";
import type { ProjectSpec } from "../../src/testing/oracle/project.js";
import { syntheticProvider } from "../../src/testing/oracle/provider.js";

/**
 * Task V-3 (docs/tasks/V-3-identity-keyed-roots.md): ADR 0011 invariant V's
 * predicate 4 -- every entrypoint root is materialized by declaration
 * position, and a configured `symbol` that does not materialize is root
 * incompleteness -- against real Node.
 *
 * PRM-25 (docs/audits/2026-09-premise-sweep-round-1.md § 4,
 * `symbol-entry-unmaterialized`, `symbol-entry-name-match`): a `{file,
 * symbol}` entrypoint was rooted at the first graph node NAMED like the
 * symbol, and reported complete whether or not one was found. PRM-31
 * (§ 4, `entry-root-decoy`): a plain file entrypoint's root requirement
 * was satisfied by a node NAMED like it -- a class method, a nested
 * function, a module-scope function the exported name merely spells -- and
 * its roots were found the same way, so the decoy stood in for the export.
 * PRM-31 is lane E's in the plan (task E-3); ADR 0011's census removes the
 * same lookup, so task V-3 closes it.
 *
 * GROUND TRUTH. Every case calls the entrypoint's `main` export, the way a
 * host calls a configured symbol (`nodeSymbolEntryCommand`). For a plain
 * file entrypoint VulnTrace roots every export, `main` among them, so the
 * same call is real Node's answer for that root.
 *
 * LOUD FIXTURE. `vuln-lib` exports `parse` (the rule's target) and `safe`,
 * both functions, checked in real Node.
 *
 * THE CONTROLS. Per entrypoint form: the positive control's `main` calls
 * `parse` directly; the negative control's calls `safe` (family C,
 * `NOT_AFFECTED`).
 */

export const ADVISORY_ID = "GHSA-v3-identity-keyed-roots";
export const TARGET_MARKER = "parse";

const ENTRY = "src/index.js";
const SYMBOL_ENTRY: EntrypointSpec = { file: ENTRY, symbol: "main" };

export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

export interface V3Case {
  readonly id: string;
  readonly finding: "PRM-25" | "PRM-31" | "V-3 audit" | "V-3 audit 2";
  /** One line: the mechanism. */
  readonly mechanism: string;
  /** `symbol`: `{file, symbol: "main"}`; `file`: the plain file entrypoint. */
  readonly entry: "symbol" | "file";
  /** The entrypoint file's source, after `const lib = require("vuln-lib");`. */
  readonly source: string;
  /** Other files under the project root, besides the entrypoint. */
  readonly extraFiles?: Readonly<Record<string, string>>;
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /** The verdict on the base commit (5302d02), measured before the fix. */
  readonly base: CaseVerdict;
  /**
   * For a case one of task V-3's independent audits found: the verdict on
   * the fix round it was found on (49320df, or 75fa833 for the second
   * round), when it was the wrong one there.
   */
  readonly firstFix?: CaseVerdict;
  /** The sound verdict. */
  readonly expected: CaseVerdict;
  /** The uncertainty reason an expected `UNKNOWN` must carry. */
  readonly expectedReason?: string;
}

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

const REQUIRE_LIB = `const lib = require("vuln-lib");\n`;

function project(
  entry: "symbol" | "file",
  source: string,
  extraFiles: Readonly<Record<string, string>> = {},
): ProjectSpec {
  return {
    files: {
      ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
      ...LIB,
      ...extraFiles,
      [ENTRY]: REQUIRE_LIB + source,
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "vulntrace.yml": simpleConfigFile({
        entrypoints: [entry === "symbol" ? SYMBOL_ENTRY : ENTRY],
      }),
    },
  };
}

const POSITIVE = `function main() { return lib.parse("x"); }\nmodule.exports = { main };\n`;
const NEGATIVE = `function main() { return lib.safe("x"); }\nmodule.exports = { main };\n`;

export function oracleCase(kase: V3Case): OracleCase {
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeSymbolEntryCommand(ENTRY, "main"),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(kase.entry, POSITIVE),
        },
        negative: {
          name: "negative-control",
          project: project(kase.entry, NEGATIVE),
        },
      },
    },
    variant: {
      name: "case",
      project: project(kase.entry, kase.source, kase.extraFiles),
    },
  };
}

/** `helper` declares a nested function spelled like the root; nobody calls it. */
const DECOY_SAFE = (name: string): string =>
  `function helper() { function ${name}() { return 0; } return ${name}; }\n`;
const DECOY_CALLS = (name: string): string =>
  `function helper() { function ${name}() { return lib.parse("x"); } return ${name}; }\n`;

/** `setup` runs at load and publishes ITS `run`, not the module-scope one. */
const NESTED_WRITE =
  `function run() { return lib.safe("x"); }\n` +
  `function setup() {\n` +
  `  function run() { return lib.parse("x"); }\n` +
  `  exports.main = run;\n` +
  `}\n` +
  `setup();\n`;

/**
 * `main` is published as a member read (`registry.impl`), which names no
 * local: only the exported name spells `main`, and a public name is not
 * provenance for a local (RWF-011). A module-scope `function main` shares
 * the spelling and calls `safe`.
 */
const NO_PROVENANCE =
  `const registry = { impl: () => lib.parse("x") };\n` +
  `function main() { return lib.safe("x"); }\n` +
  `exports.main = registry.impl;\n` +
  `exports.unused = main;\n`;

export const ALL_CASES: readonly V3Case[] = [
  {
    id: "symbol.unmaterialized-name",
    finding: "PRM-25",
    mechanism:
      "`main` is published as `run`; no node is named `main`, so the base rooted nothing and called the derivation complete",
    entry: "symbol",
    source: `function run() { return lib.parse("x"); }\nmodule.exports = { main: run };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "symbol.nested-decoy.safe",
    finding: "PRM-25",
    mechanism:
      "a nested `function main` the export never publishes is the base's root; the real `main` (`run`) calls the target",
    entry: "symbol",
    source:
      DECOY_SAFE("main") +
      `function run() { return lib.parse("x"); }\n` +
      `module.exports = { main: run, helper };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "symbol.nested-decoy.calls",
    finding: "PRM-25",
    mechanism:
      "the nested decoy `main` calls the target and the real `main` (`run`) does not: the base's false AFFECTED",
    entry: "symbol",
    source:
      DECOY_CALLS("main") +
      `function run() { return lib.safe("x"); }\n` +
      `module.exports = { main: run, helper };\n`,
    called: false,
    base: "AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "symbol.opaque-export.decoy",
    finding: "PRM-25",
    mechanism:
      "`main` is published only through a call's result (`module.exports = makeApi()`); the base rooted a nested decoy `main`",
    entry: "symbol",
    source:
      DECOY_SAFE("main") +
      `function run() { return lib.parse("x"); }\n` +
      `function makeApi() { return { main: run }; }\n` +
      `module.exports = makeApi();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "symbol.forwarded-over",
    finding: "PRM-25",
    mechanism:
      "`extend(module.exports, require(\"./impl.cjs\"))` copies impl's `main` over the bound one; a gap that names no export may publish the symbol, and the base called the symbol's roots complete",
    entry: "symbol",
    source:
      `function extend(target, source) { target.main = source.main; }\n` +
      `function main() { return lib.safe("x"); }\n` +
      `exports.main = main;\n` +
      `extend(module.exports, require("./impl.cjs"));\n`,
    extraFiles: {
      "src/impl.cjs":
        REQUIRE_LIB +
        `exports.main = function () { return lib.parse("x"); };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "symbol.nested-write",
    finding: "PRM-25",
    mechanism:
      "`main` is written inside `setup`, which publishes its own `run`; the module-scope `run` shares the spelling",
    entry: "symbol",
    source: NESTED_WRITE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "symbol.no-provenance-export",
    finding: "PRM-25",
    mechanism:
      "`exports.main = registry.impl`: no local is published, and the base rooted the module-scope `function main` spelled like the symbol",
    entry: "symbol",
    source: NO_PROVENANCE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "file.no-provenance-export",
    finding: "PRM-31",
    mechanism:
      "`exports.main = registry.impl`: the base satisfied `main`'s requirement with the module-scope `function main` its exported name spells",
    entry: "file",
    source: NO_PROVENANCE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "file.entry-root-decoy",
    finding: "PRM-31",
    mechanism:
      "the round-1 reproduction: `exports.main = registry.impl` publishes no local, and an unrelated class method named `main` satisfied its root requirement",
    entry: "file",
    source:
      `class Cli { main() { return "decoy"; } }\n` +
      `const registry = { impl: function (u) { return lib.parse(u); } };\n` +
      `exports.main = registry.impl;\n` +
      `exports.Cli = Cli;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "file.nested-decoy.safe",
    finding: "PRM-31",
    mechanism:
      "the export's local `run` was rooted at the first node named `run` -- a nested one -- and that name satisfied the root requirement",
    entry: "file",
    source:
      DECOY_SAFE("run") +
      `function run() { return lib.parse("x"); }\n` +
      `module.exports = { main: run, helper };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "file.nested-decoy.calls",
    finding: "PRM-31",
    mechanism:
      "`{ main }` was rooted at the first node named `main` -- a nested one that calls the target and never leaves `helper`: the base's false AFFECTED",
    entry: "file",
    source:
      `function helper() { function main() { return lib.parse("x"); } return 0; }\n` +
      `function main() { return lib.safe("x"); }\n` +
      `module.exports = { main, helper };\n`,
    called: false,
    base: "AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "file.nested-write",
    finding: "PRM-31",
    mechanism:
      "`main` is written inside `setup`; the base satisfied its requirement with the module-scope `run` of the same spelling",
    entry: "file",
    source: NESTED_WRITE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  // -- Found by task V-3's independent audit, on the first fix (49320df) --
  // The two deferred whole-module writes were AFFECTED on the base, by a
  // root found by spelling; they are UNKNOWN now, a precision cost: the
  // write runs only if `setup` / the class runs, and no root is claimed
  // for a write that may never happen.
  {
    id: "file.deferred-whole-module-write",
    finding: "V-3 audit",
    mechanism:
      "`setup` writes `module.exports = { main: run }` at load: the withdrawn whole-module binding has no requirement, and the first fix dropped the widening's root inside a function body silently",
    entry: "file",
    source:
      `function run() { return lib.parse("x"); }\n` +
      `function setup() { module.exports = { main: run }; }\n` +
      `setup();\n`,
    called: true,
    base: "AFFECTED",
    firstFix: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "symbol.static-block-whole-module-write",
    finding: "V-3 audit",
    mechanism:
      "a class static block writes `module.exports = { main: run }` at load; the same silent drop",
    entry: "symbol",
    source:
      `function run() { return lib.parse("x"); }\n` +
      `class K { static { module.exports = { main: run }; } }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "file.static-block-whole-module-write",
    finding: "V-3 audit",
    mechanism:
      "the static-block write with a plain file entrypoint: the first fix's silent drop",
    entry: "file",
    source:
      `function run() { return lib.parse("x"); }\n` +
      `class K { static { module.exports = { main: run }; } }\n`,
    called: true,
    base: "AFFECTED",
    firstFix: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "file.reassigned-binding",
    finding: "V-3 audit",
    mechanism:
      "`let main = safe-caller; main = parse-caller; exports.main = main`: the refused binding was witnessed by its stale declaration",
    entry: "file",
    source:
      `let main = function () { return lib.safe("x"); };\n` +
      `main = function () { return lib.parse("x"); };\n` +
      `exports.main = main;\n`,
    called: true,
    base: "NOT_AFFECTED",
    firstFix: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "symbol.reassigned-binding",
    finding: "V-3 audit",
    mechanism: "the same reassigned binding as a configured symbol",
    entry: "symbol",
    source:
      `let main = function () { return lib.safe("x"); };\n` +
      `main = function () { return lib.parse("x"); };\n` +
      `exports.main = main;\n`,
    called: true,
    base: "NOT_AFFECTED",
    firstFix: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  // -- Found by task V-3's second independent audit, on 75fa833 --
  // A CommonJS whole-module write replaces the object `main` is read from.
  {
    id: "symbol.whole-module-republish.conditional",
    finding: "V-3 audit 2",
    mechanism:
      "`exports.main = safe-caller`, then a conditional `module.exports = { main: run }`: the symbol filter dropped the whole-module binding as the `default` export",
    entry: "symbol",
    source:
      `exports.main = function () { return lib.safe("x"); };\n` +
      `if (process.env.VT_NEVER_SET === undefined) module.exports = { main: run };\n` +
      `function run() { return lib.parse("x"); }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "symbol.whole-module-republish.function-property",
    finding: "V-3 audit 2",
    mechanism:
      "`run.main = run; module.exports = run`: `main` is a property of the whole-module value",
    entry: "symbol",
    source:
      `exports.main = function () { return lib.safe("x"); };\n` +
      `run.main = run;\n` +
      `module.exports = run;\n` +
      `function run() { return lib.parse("x"); }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "symbol.whole-module-republish.alias",
    finding: "V-3 audit 2",
    mechanism: "`const api = { main: run }; module.exports = api`",
    entry: "symbol",
    source:
      `exports.main = function () { return lib.safe("x"); };\n` +
      `const api = { main: run };\n` +
      `module.exports = api;\n` +
      `function run() { return lib.parse("x"); }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
  {
    id: "symbol.withdrawn-widening-roots-other-export",
    finding: "V-3 audit 2",
    mechanism:
      "a conditional `exports.main` withdraws its attribution; 75fa833 rooted the file-wide widening, `other` included, a false AFFECTED. A precision cost against the base's (correct) NOT_AFFECTED: the withdrawn symbol is a gap",
    entry: "symbol",
    source:
      `if (process.env.VT_NEVER_SET === undefined) exports.main = function () { return lib.safe("x"); };\n` +
      `exports.other = function () { return lib.parse("x"); };\n`,
    called: false,
    base: "NOT_AFFECTED",
    firstFix: "AFFECTED",
    expected: "UNKNOWN",
    expectedReason: "entrypoint_root_incomplete",
  },
];
