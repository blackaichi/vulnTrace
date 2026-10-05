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
import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";
import { compileTypeScript } from "../../src/testing/oracle/typescript-compile.js";

/**
 * Task A-6 (docs/tasks/A-6-binder-resolution-authority.md): ADR 0008
 * invariant A2 on the BINDER side -- "an exact export with the whole
 * member chain consumed" (PRM-20) and a destructured import's name taken
 * from its key, never from its local name (PRM-108's origin). Each case
 * against real Node.
 *
 * ONE LOUD FIXTURE. `vuln-lib` exports `parse` (the rule's target),
 * `safe` (its inert sibling), `api` (a function carrying both as
 * members, plus a class and a decorator that call `parse`) and `Klass`
 * (a class whose static `run` and `call` call `parse`). Every one is a
 * declared bound name, so an attribution that stops at `api` or `Klass`
 * instead of the member resolves LOUDLY to a function that never calls
 * the target -- which is exactly the false `NOT_AFFECTED` PRM-20 is.
 *
 * THE VERDICT. A trailing chain the binder no longer consumes is
 * `UNKNOWN`, unless another authority proves the member (task A-5b's
 * receiver authority, for a static method of an imported class). A single
 * trailing `.call` / `.apply` on an exact export stays resolved (ADR
 * 0008's A-6 row) while no prepared file may write a member of that name
 * (task A-5b's whole-graph check). A string-keyed destructuring of a
 * builtin is classified by its key.
 *
 * THE CONTROLS. Every case names its own `negative` program, which must
 * be `NOT_AFFECTED`; the positive control is the negative program after
 * one attributable direct call of `parse`.
 */

export const ADVISORY_ID = "GHSA-a6-binder-resolution-authority";
export const TARGET_MARKER = "parse";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `function api(x) { hit("api"); return safe(x); }\n` +
  `api.parse = parse;\n` +
  `api.safe = safe;\n` +
  `api.Inner = class Inner {\n  constructor(x) { parse(x); }\n};\n` +
  `api.Deco = function Deco(target) { parse("x"); return target; };\n` +
  `class Klass {\n` +
  `  static run(x) { return parse(x); }\n` +
  `  static check(x) { return safe(x); }\n` +
  `  static call(self, x) { return parse(x); }\n` +
  `}\n` +
  `module.exports = { parse, safe, api, Klass };\n`;

const BOUND_NAMES = ["parse", "safe", "api", "Klass"] as const;

/** The worker a forked child runs: it loads the package and calls the target. */
const WORKER_SOURCE = `const lib = require("vuln-lib");\nlib.parse("x");\nprocess.exit(0);\n`;

export type Finding = "PRM-20" | "PRM-108" | "RWF-077";

export type CaseVerdict = "NOT_AFFECTED" | "AFFECTED" | "UNKNOWN";

/**
 * `js`: `src/index.js`, CommonJS. `mjs`: `src/index.mjs`, ESM over the
 * CommonJS package. `ts-legacy-decorators`: `src/index.ts`, scanned as
 * written; real Node runs the repository's own TypeScript compilation of
 * it (`src/testing/oracle/typescript-compile.ts`), as task A-1's cases do.
 */
export type Language = "js" | "mjs" | "ts-legacy-decorators";

export interface A6Case {
  readonly id: string;
  readonly finding: Finding;
  /** One line: the mechanism. */
  readonly mechanism: string;
  readonly language?: Language;
  /** The whole entry program: each case binds the package itself. */
  readonly source: string;
  /** The negative control's whole entry program; it must be `NOT_AFFECTED`. */
  readonly negative: string;
  /** Further project files (both the case and its controls). */
  readonly files?: Readonly<Record<string, string>>;
  /**
   * An open soundness defect this task does not close: the case asserts
   * the record (the exact wrong result, and its open FINDINGS entry), never
   * the wrong verdict as an expectation (AGENTS.md § G).
   */
  readonly openDefect?: {
    readonly rwf: string;
    readonly observed: VerdictObservation;
  };
  /** Whether real Node calls the target. */
  readonly called: boolean;
  /** The analyzer's verdict on the base commit, measured before the fix (the task file records it). */
  readonly base: CaseVerdict;
  /** The sound verdict. */
  readonly expected: CaseVerdict;
}

const ENTRY: Record<Language, string> = {
  js: "src/index.js",
  mjs: "src/index.mjs",
  "ts-legacy-decorators": "src/index.ts",
};

/** One attributable direct call of the target, in each language's own binding form. */
const POSITIVE_PREFIX: Record<Language, string> = {
  js: `const __p = require("vuln-lib");\n__p.parse("x");\n`,
  mjs: `import __p from "vuln-lib";\n__p.parse("x");\n`,
  "ts-legacy-decorators": `import __p = require("vuln-lib");\n__p.parse("x");\n`,
};

const TS_OPTIONS = { experimentalDecorators: true } as const;

function project(
  language: Language,
  app: string,
  files: Readonly<Record<string, string>>,
): ProjectSpec {
  const common: Record<string, string> = {
    ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/vuln-lib/index.js": LIB_SOURCE,
    "rules.yml": simpleRuleFile({
      id: ADVISORY_ID,
      packageName: "vuln-lib",
      exportName: "parse",
    }),
    ...files,
  };
  const entry = ENTRY[language];
  if (language !== "ts-legacy-decorators") {
    return {
      files: {
        ...common,
        [entry]: app,
        "vulntrace.yml": simpleConfigFile({ entrypoints: [entry] }),
      },
    };
  }
  const source = app + `export {};\n`;
  return {
    files: {
      ...common,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "commonjs",
          target: "es2022",
          ...TS_OPTIONS,
        },
      }),
      [entry]: source,
      "dist/index.js": compileTypeScript(source, "index.ts", TS_OPTIONS),
      "vulntrace.yml": simpleConfigFile({ entrypoints: [entry] }),
    },
  };
}

export function oracleCase(kase: A6Case): OracleCase {
  const language = kase.language ?? "js";
  const files = kase.files ?? {};
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: [...BOUND_NAMES] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(
      language === "ts-legacy-decorators" ? "dist/index.js" : ENTRY[language],
    ),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(
            language,
            POSITIVE_PREFIX[language] + kase.negative,
            files,
          ),
        },
        negative: {
          name: "negative-control",
          project: project(language, kase.negative, files),
        },
      },
    },
    variant: { name: "case", project: project(language, kase.source, files) },
  };
}

const REQUIRE_LIB = `const lib = require("vuln-lib");\n`;
const REQUIRE_API = `const { api } = require("vuln-lib");\n`;

// ---------------------------------------------------------------------------
// PRM-20 -- `bindCallee` stopped at the first export a chain names and
// discarded the rest: `api.parse()` was an edge to `api`, `lib.api.parse()`
// an edge to `api`, `lib.safe.call.call(lib.parse)` an edge to `safe`. The
// three spellings ADR 0008 names, in every binding form.
// ---------------------------------------------------------------------------

export const TRAILING_CASES: readonly A6Case[] = [
  {
    id: "trailing.named-require",
    finding: "PRM-20",
    mechanism:
      "`const { api } = require(…); api.parse()` calls a member of the named export",
    source: REQUIRE_API + `api.parse("x");\n`,
    negative: REQUIRE_API + `api("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "trailing.named-element-access",
    finding: "PRM-20",
    mechanism: '`api["parse"]()`: the same member through a literal key',
    source: REQUIRE_API + `api["parse"]("x");\n`,
    negative: REQUIRE_API + `api("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "trailing.named-esm",
    finding: "PRM-20",
    mechanism: "`import { api } from …; api.parse()`",
    language: "mjs",
    source: `import { api } from "vuln-lib";\napi.parse("x");\n`,
    negative: `import { api } from "vuln-lib";\napi("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "trailing.whole-module-two-members",
    finding: "PRM-20",
    mechanism:
      "`lib.api.parse()`: the first member names the export, the second is dropped",
    source: REQUIRE_LIB + `lib.api.parse("x");\n`,
    negative: REQUIRE_LIB + `lib.api("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "trailing.namespace-esm",
    finding: "PRM-20",
    mechanism: "`import * as ns from …; ns.api.parse()`",
    language: "mjs",
    source: `import * as ns from "vuln-lib";\nns.api.parse("x");\n`,
    negative: `import * as ns from "vuln-lib";\nns.api("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "trailing.default-esm",
    finding: "PRM-20",
    mechanism: "`import lib from …; lib.api.parse()`",
    language: "mjs",
    source: `import lib from "vuln-lib";\nlib.api.parse("x");\n`,
    negative: `import lib from "vuln-lib";\nlib.api("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "trailing.call-call",
    finding: "PRM-20",
    mechanism:
      "`lib.safe.call.call(lib.parse, …)` runs `Function.prototype.call` on `lib.parse`",
    source: REQUIRE_LIB + `lib.safe.call.call(lib.parse, null, "x");\n`,
    negative: REQUIRE_LIB + `lib.safe.call(null, "x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "trailing.bind-result",
    finding: "PRM-20",
    mechanism:
      "`lib.parse.bind(null)` does not call `parse`; the bound function it returns does",
    source: REQUIRE_LIB + `lib.parse.bind(null)("x");\n`,
    negative: REQUIRE_LIB + `lib.safe("x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "trailing.imported-class-static",
    finding: "PRM-20",
    mechanism:
      "`const { Klass } = require(…); Klass.run()`: a static method of an imported class (task A-5b's receiver authority)",
    source: `const { Klass } = require("vuln-lib");\nKlass.run("x");\n`,
    negative: `const { Klass } = require("vuln-lib");\nKlass.check("x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
];

// ---------------------------------------------------------------------------
// PRM-20 at the other sites that resolve their callee through `bindCallee`
// (task A-1's audit, finding 5) and through the value-alias path (VT-214):
// the same truncation reached each of them.
// ---------------------------------------------------------------------------

export const SITE_CASES: readonly A6Case[] = [
  {
    id: "site.tag",
    finding: "PRM-20",
    mechanism: "`` lib.api.parse`x` ``: a tag resolved like a callee",
    source: REQUIRE_LIB + "lib.api.parse`x`;\n",
    negative: REQUIRE_LIB + "lib.api`x`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "site.new",
    finding: "PRM-20",
    mechanism: "`new lib.api.Inner()` constructs a member of the export",
    source: REQUIRE_LIB + `new lib.api.Inner("x");\n`,
    negative: REQUIRE_LIB + `lib.api("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "site.extends",
    finding: "PRM-20",
    mechanism:
      "`class S extends lib.api.Inner {}`: the implicit constructor calls the member's",
    source: REQUIRE_LIB + `class S extends lib.api.Inner {}\nnew S("x");\n`,
    negative:
      REQUIRE_LIB + `class S extends lib.api.Inner {}\nlib.safe("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "site.decorator",
    finding: "PRM-20",
    mechanism:
      "`@lib.api.Deco class X {}`: a legacy class decorator runs at definition",
    language: "ts-legacy-decorators",
    source: `import lib = require("vuln-lib");\n@lib.api.Deco\nclass X {}\n`,
    negative: `import lib = require("vuln-lib");\nclass X {}\nlib.safe("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "alias.const-member",
    finding: "PRM-20",
    mechanism: "`const f = api.parse; f()`: the alias resolves the same chain",
    source: REQUIRE_API + `const f = api.parse;\nf("x");\n`,
    negative: REQUIRE_API + `const f = api;\nf("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "alias.receiver",
    finding: "PRM-20",
    mechanism:
      "`const a = api; a.parse()`: the receiver alias rebuilds `api.parse`",
    source: REQUIRE_API + `const a = api;\na.parse("x");\n`,
    negative: REQUIRE_API + `const a = api;\na("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "alias.whole-module-member",
    finding: "PRM-20",
    mechanism: "`const p = lib.api.parse; p()`",
    source: REQUIRE_LIB + `const p = lib.api.parse;\np("x");\n`,
    negative: REQUIRE_LIB + `const p = lib.api;\np("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "alias.destructured-member",
    finding: "PRM-20",
    mechanism:
      "`const { parse: p } = lib.api; p()`: a destructuring of a member",
    source: REQUIRE_LIB + `const { parse: p } = lib.api;\np("x");\n`,
    negative: REQUIRE_LIB + `const { api: a } = lib;\na("x");\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// The one trailing chain ADR 0008's A-6 row keeps: a single `.call` /
// `.apply` on an exact export invokes the export itself -- while nothing
// replaces the member it reads, and while the export is a function rather
// than a class (whose own static `call` the chain would reach).
// ---------------------------------------------------------------------------

export const CALL_APPLY_CASES: readonly A6Case[] = [
  {
    id: "call.whole-module",
    finding: "PRM-20",
    mechanism: "`lib.parse.call(null, …)` invokes the export (precision guard)",
    source: REQUIRE_LIB + `lib.parse.call(null, "x");\n`,
    negative: REQUIRE_LIB + `lib.safe.call(null, "x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "call.apply",
    finding: "PRM-20",
    mechanism:
      '`lib.parse.apply(null, ["x"])` invokes the export (precision guard)',
    source: REQUIRE_LIB + `lib.parse.apply(null, ["x"]);\n`,
    negative: REQUIRE_LIB + `lib.safe.apply(null, ["x"]);\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "call.named",
    finding: "PRM-20",
    mechanism:
      "`const { parse } = require(…); parse.call(null, …)` (precision guard)",
    source: `const { parse } = require("vuln-lib");\nparse.call(null, "x");\n`,
    negative: `const { safe } = require("vuln-lib");\nsafe.call(null, "x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "call.member-written",
    finding: "PRM-20",
    mechanism:
      "`lib.safe.call = lib.parse` replaces the member `.call` reads before `lib.safe.call(…)`",
    source:
      REQUIRE_LIB + `lib.safe.call = lib.parse;\nlib.safe.call(null, "x");\n`,
    negative: REQUIRE_LIB + `lib.safe.call(null, "x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "call.class-static-call",
    finding: "PRM-20",
    mechanism:
      "`lib.Klass.call(…)` reaches the class's own static `call`, not `Function.prototype.call`",
    source: REQUIRE_LIB + `lib.Klass.call(null, "x");\n`,
    negative: REQUIRE_LIB + `lib.Klass.check("x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
];

// ---------------------------------------------------------------------------
// PRM-108's origin -- `extractRequireBindings` recorded the LOCAL name as
// the imported name for a string or computed destructuring key, so the
// loader classifier read `const { "fork": f } = require("child_process")`
// as a member named `f`, and `f(worker)` never widened the closure.
//
// The origin now names an element by its key's exact text: an identifier,
// a string literal, or a computed string literal. A numeric key records no
// name (no builtin member is numeric). An UNREADABLE computed key keeps the
// local name -- not an import name, but the base's row, which the loader
// classifier can only widen on; dropping it was a regression task A-6's
// independent audit found (finding 1). An unreadable key whose local name
// is not a loader-capable member (`{ [k]: f }`) is therefore still a
// family-A false NOT_AFFECTED, for any builtin and any use: PRM-108's
// consumer half, task C-4 (ADR 0010: "destructured string/computed keys").
// It, and the audit's finding 3 (RWF-077), are open-soundness-defect
// records, not expectations.
// ---------------------------------------------------------------------------

/**
 * A family-A false `NOT_AFFECTED` this task does not close. `unknownEdges`
 * counts the call through the binding -- an unknown callee, NON-widening,
 * so the module-load closure stays complete and family A certifies the
 * package unloaded -- plus, for the dynamic key, the call that builds it.
 */
function familyAObserved(unknownEdges: number): VerdictObservation {
  return {
    verdict: "NOT_AFFECTED",
    proofFamily: "A",
    target: "vuln-lib#parse",
    reachableSubgraphComplete: false,
    unknownEdges,
  };
}

const FORK_FILES = { "src/worker.js": WORKER_SOURCE };

export const KEY_CASES: readonly A6Case[] = [
  {
    id: "key.string-literal",
    finding: "PRM-108",
    mechanism: '`const { "fork": f } = require("child_process"); f(worker)`',
    source: `const { "fork": f } = require("child_process");\nf(__dirname + "/worker.js");\n`,
    negative: `const { "fork": f } = require("child_process");\n`,
    files: FORK_FILES,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "key.computed-literal",
    finding: "PRM-108",
    mechanism: '`const { ["fork"]: f } = require("child_process"); f(worker)`',
    source: `const { ["fork"]: f } = require("child_process");\nf(__dirname + "/worker.js");\n`,
    negative: `const { ["fork"]: f } = require("child_process");\n`,
    files: FORK_FILES,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "key.computed-dynamic",
    finding: "PRM-108",
    mechanism:
      '`const { [k]: f } = require("child_process")` with a key the analyzer cannot read',
    source: `const k = ["fo", "rk"].join("");\nconst { [k]: f } = require("child_process");\nf(__dirname + "/worker.js");\n`,
    negative: `const k = ["fo", "rk"].join("");\nconst { [k]: f } = require("child_process");\n`,
    files: FORK_FILES,
    openDefect: { rwf: "PRM-108", observed: familyAObserved(2) },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "key.computed-template",
    finding: "PRM-108",
    mechanism:
      '`` const { [`fork`]: f } = require("child_process") ``: a template literal key',
    source:
      'const { [`fork`]: f } = require("child_process");\n' +
      `f(__dirname + "/worker.js");\n`,
    negative: 'const { [`fork`]: f } = require("child_process");\n',
    files: FORK_FILES,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Task A-6's independent audit, finding 1: the first version of the fix
  // recorded NO binding for a computed key, which turned these two -- base
  // UNKNOWN only because the local name happened to be the member -- into
  // false NOT_AFFECTEDs. Regression guards.
  {
    id: "key.computed-literal-same-name",
    finding: "PRM-108",
    mechanism:
      '`const { ["fork"]: fork } = require("child_process")` (audit finding 1)',
    source: `const { ["fork"]: fork } = require("child_process");\nfork(__dirname + "/worker.js");\n`,
    negative: `const { ["fork"]: fork } = require("child_process");\n`,
    files: FORK_FILES,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "key.computed-dynamic-same-name",
    finding: "PRM-108",
    mechanism:
      '`const { [k]: fork } = require("child_process")` (audit finding 1)',
    source: `const k = ["fo", "rk"].join("");\nconst { [k]: fork } = require("child_process");\nfork(__dirname + "/worker.js");\n`,
    negative: `const k = ["fo", "rk"].join("");\nconst { [k]: fork } = require("child_process");\n`,
    files: FORK_FILES,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Task A-6's independent audit, finding 3 (RWF-077): a destructured
  // builtin loader called through `.call` -- not A-6's (the builtin
  // table's key is unchanged by it); recorded, never expected.
  {
    id: "key.named-loader-call",
    finding: "RWF-077",
    mechanism:
      '`const { fork } = require("child_process"); fork.call(null, worker)` (RWF-077, open)',
    source: `const { fork } = require("child_process");\nfork.call(null, __dirname + "/worker.js");\n`,
    negative: `const { fork } = require("child_process");\n`,
    files: FORK_FILES,
    openDefect: { rwf: "RWF-077", observed: familyAObserved(1) },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "key.identifier",
    finding: "PRM-108",
    mechanism:
      '`const { fork: f } = require("child_process")` (the contrast already classified)',
    source: `const { fork: f } = require("child_process");\nf(__dirname + "/worker.js");\n`,
    negative: `const { fork: f } = require("child_process");\n`,
    files: FORK_FILES,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "key.esm-string-import-name",
    finding: "PRM-108",
    mechanism:
      '`import { "fork" as f } from "child_process"` (an ES2022 string import name)',
    language: "mjs",
    source:
      `import { "fork" as f } from "child_process";\n` +
      `f(new URL("./worker.js", import.meta.url).pathname);\n`,
    negative: `import { "fork" as f } from "child_process";\n`,
    files: FORK_FILES,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "key.package-string-literal",
    finding: "PRM-108",
    mechanism:
      '`const { "parse": p } = require("vuln-lib"); p()` (a package, not a builtin)',
    source: `const { "parse": p } = require("vuln-lib");\np("x");\n`,
    negative: `const { "safe": s } = require("vuln-lib");\ns("x");\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
];

export const ALL_CASES: readonly A6Case[] = [
  ...TRAILING_CASES,
  ...SITE_CASES,
  ...CALL_APPLY_CASES,
  ...KEY_CASES,
];
