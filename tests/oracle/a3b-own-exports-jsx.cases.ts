import type ts from "typescript";
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
import { compileTypeScript } from "../../src/testing/oracle/typescript-compile.js";
import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";

/**
 * Task A-3b (docs/tasks/A-3b-own-exports-jsx.md): a module calling its own
 * export (AUD-02), a JSX element calling its factory (PRM-116), the
 * automatic JSX runtime's implicit module load (RWF-066), and a module
 * loaded through `module.parent.require` (RWF-065, lane C's), each against
 * real Node.
 *
 * One shared LOUD fixture, the one tasks A-0, A-1 and A-3a use:
 * `vuln-lib` exports `parse` (the rule's target) and `safe` (its inert
 * sibling), both marked with the `hit()` convention and both declared as
 * bound names. AUD-02 is a defect INSIDE the vulnerable package, so its
 * cases give `vuln-lib` its own self-calling source, which still exports
 * both names.
 *
 * THE CONTROLS. Every case here is FAIL-CLOSED: its correct verdict is
 * `UNKNOWN`, because the invocation is accounted for by an unknown edge
 * (an own export the graph does not attribute until lane E's write set; a
 * JSX factory the graph does not resolve, by the project owner's decision
 * of 2026-10-02). An unknown edge blocks the negative proof whichever
 * export the hook calls, so the negative control is the case with its
 * TRIGGER removed -- the own-export call, the JSX element -- and every
 * definition kept; it shows nothing but the trigger reaches the target.
 * The positive control is the negative control preceded by one direct
 * `lib.parse("x")`, proving the rule, target and entrypoint wiring of this
 * exact project.
 */

export const ADVISORY_ID = "GHSA-a3b-own-exports-jsx";
export const TARGET_MARKER = "parse";

const HIT_EXPORTS =
  HIT_HELPER_SOURCE + hitFunction("parse", '"p"') + hitFunction("safe", '"s"');

const LIB_SOURCE = HIT_EXPORTS + `module.exports = { parse, safe };\n`;

/**
 * The automatic JSX runtime `vuln-lib` ships for RWF-066's cases: the
 * compiled element calls `jsx`, which calls the target.
 */
const JSX_RUNTIME = `const lib = require("./index.js");
function jsx(type, props) { lib.parse("x"); return { type, props }; }
module.exports = { jsx, jsxs: jsx, Fragment: "fragment" };
`;

export type Finding = "AUD-02" | "PRM-116" | "RWF-066" | "RWF-065" | "RWF-067";

export type Language = "js" | "tsx";

/** One variant's program: the application entry, and whatever else it needs. */
export interface Program {
  /** The entry file's source, after the prelude (if any). */
  readonly app: string;
  /** `vuln-lib`'s own `index.js`, when the case is a defect inside it (AUD-02). */
  readonly lib?: string;
  /** Further project files (`src/mod.js`, `node_modules/vuln-lib/jsx-runtime.js`). */
  readonly files?: Readonly<Record<string, string>>;
}

export interface A3bCase {
  /** Stable case id, e.g. `own-export.exports-member`. */
  readonly id: string;
  readonly finding: Finding;
  /** One line: the mechanism. */
  readonly mechanism: string;
  readonly language: Language;
  /** The project's TypeScript options (`tsconfig.json`), for a `tsx` case. */
  readonly tsOptions?: ts.CompilerOptions;
  /**
   * Whether the entry starts by binding `lib` to `vuln-lib`. Off for a
   * case whose point is that nothing the source spells loads `vuln-lib`
   * (RWF-065, RWF-066); its positive control binds it itself.
   */
  readonly prelude: boolean;
  readonly source: Program;
  /** The negative control: the case with its trigger removed (see the module comment). */
  readonly negative: Program;
  /** The only sound verdict for the case (every case here is fail-closed). */
  readonly expected: "UNKNOWN";
  /**
   * Set when the analyzer's live verdict is still wrong, for a reason this
   * task does not own: an open-soundness-defect record
   * (`src/testing/open-soundness-defect.ts`), never an expectation. The
   * correct answer (`expected`) stays standing.
   */
  readonly openDefect?: {
    readonly rwf: string;
    readonly observed: VerdictObservation;
  };
}

function prelude(kase: A3bCase): string {
  if (!kase.prelude) {
    return "";
  }
  return kase.language === "js"
    ? `const lib = require("vuln-lib");\n`
    : `import lib = require("vuln-lib");\n`;
}

function project(kase: A3bCase, program: Program, lead = ""): ProjectSpec {
  const common: Record<string, string> = {
    ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/vuln-lib/index.js": program.lib ?? LIB_SOURCE,
    "rules.yml": simpleRuleFile({
      id: ADVISORY_ID,
      packageName: "vuln-lib",
      exportName: "parse",
    }),
    ...program.files,
  };
  const body = prelude(kase) + lead + program.app;
  if (kase.language === "js") {
    return {
      files: {
        ...common,
        "src/index.js": body,
        "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.js"] }),
      },
    };
  }
  // TSX: Node cannot run JSX, so the ground truth runs the source compiled
  // by the repository's own TypeScript (src/testing/oracle/
  // typescript-compile.ts) with the options the project's tsconfig.json
  // declares. `export {}` makes the file a module, as the analyzer reads it.
  const source = body + `export {};\n`;
  const options = kase.tsOptions ?? {};
  return {
    files: {
      ...common,
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          module: "commonjs",
          target: "es2022",
          ...tsconfigOptions(options),
        },
      }),
      "src/index.tsx": source,
      "dist/index.js": compileTypeScript(source, "index.tsx", options),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.tsx"] }),
    },
  };
}

const JSX_EMIT_NAMES: Readonly<Record<number, string>> = {
  1: "preserve",
  2: "react",
  3: "react-native",
  4: "react-jsx",
  5: "react-jsxdev",
};

/** `ts.CompilerOptions` as `tsconfig.json` spells them (the `jsx` enum as its string). */
function tsconfigOptions(options: ts.CompilerOptions): Record<string, unknown> {
  const { jsx, ...rest } = options;
  return jsx === undefined ? rest : { ...rest, jsx: JSX_EMIT_NAMES[jsx] };
}

export function oracleCase(kase: A3bCase): OracleCase {
  const direct = kase.prelude
    ? `lib.parse("x");\n`
    : kase.language === "js"
      ? `const direct = require("vuln-lib");\ndirect.parse("x");\n`
      : `import direct = require("vuln-lib");\ndirect.parse("x");\n`;
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand(
      kase.language === "js" ? "src/index.js" : "dist/index.js",
    ),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(kase, kase.negative, direct),
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

// ---------------------------------------------------------------------------
// AUD-02 -- a module calling its own export
// ---------------------------------------------------------------------------

/** `vuln-lib`, whose `run` reaches `parse` through `call` (or never, for the negative control). */
function selfCallingLib(exportsSource: string): string {
  return HIT_EXPORTS + exportsSource;
}

const RUN_APP = `lib.run(1);\n`;

export const OWN_EXPORTS: readonly A3bCase[] = [
  {
    id: "own-export.exports-member",
    finding: "AUD-02",
    mechanism: "`exports.parse(x)` inside the package that exports it",
    language: "js",
    prelude: true,
    source: {
      app: RUN_APP,
      lib: selfCallingLib(
        `exports.parse = parse;\nexports.safe = safe;\nexports.run = function run(x) { return exports.parse(x); };\n`,
      ),
    },
    negative: {
      app: RUN_APP,
      lib: selfCallingLib(
        `exports.parse = parse;\nexports.safe = safe;\nexports.run = function run(x) { return x; };\n`,
      ),
    },
    expected: "UNKNOWN",
  },
  {
    id: "own-export.module-exports-member",
    finding: "AUD-02",
    mechanism: "`module.exports.parse(x)` inside the package that exports it",
    language: "js",
    prelude: true,
    source: {
      app: RUN_APP,
      lib: selfCallingLib(
        `module.exports = { parse, safe, run(x) { return module.exports.parse(x); } };\n`,
      ),
    },
    negative: {
      app: RUN_APP,
      lib: selfCallingLib(
        `module.exports = { parse, safe, run(x) { return x; } };\n`,
      ),
    },
    expected: "UNKNOWN",
  },
  {
    id: "own-export.element-access",
    finding: "AUD-02",
    mechanism: '`exports["parse"](x)`: a literal element access',
    language: "js",
    prelude: true,
    source: {
      app: RUN_APP,
      lib: selfCallingLib(
        `exports.parse = parse;\nexports.safe = safe;\nexports.run = function run(x) { return exports["parse"](x); };\n`,
      ),
    },
    negative: {
      app: RUN_APP,
      lib: selfCallingLib(
        `exports.parse = parse;\nexports.safe = safe;\nexports.run = function run(x) { return x; };\n`,
      ),
    },
    expected: "UNKNOWN",
  },
  {
    id: "own-export.construct",
    finding: "AUD-02",
    mechanism:
      "`new exports.Parser(x)`: constructing an own export whose constructor calls the target",
    language: "js",
    prelude: true,
    source: {
      app: RUN_APP,
      lib: selfCallingLib(
        `exports.parse = parse;\nexports.safe = safe;\nexports.Parser = class Parser { constructor(x) { parse(x); } };\nexports.run = function run(x) { return new exports.Parser(x); };\n`,
      ),
    },
    negative: {
      app: RUN_APP,
      lib: selfCallingLib(
        `exports.parse = parse;\nexports.safe = safe;\nexports.Parser = class Parser { constructor(x) { parse(x); } };\nexports.run = function run(x) { return x; };\n`,
      ),
    },
    expected: "UNKNOWN",
  },
  {
    id: "own-export.application-module",
    finding: "AUD-02",
    mechanism:
      "an application module (not an entrypoint) calls its own export, which calls the target",
    language: "js",
    prelude: false,
    source: {
      app: `const mod = require("./mod.js");\nmod.run();\n`,
      files: {
        "src/mod.js": `const lib = require("vuln-lib");\nexports.work = function work() { return lib.parse("x"); };\nexports.run = function run() { return exports.work(); };\n`,
      },
    },
    negative: {
      app: `const mod = require("./mod.js");\nmod.run();\n`,
      files: {
        "src/mod.js": `const lib = require("vuln-lib");\nexports.work = function work() { return lib.parse("x"); };\nexports.run = function run() { return 1; };\n`,
      },
    },
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// PRM-116 -- a JSX element is a call to its factory
// ---------------------------------------------------------------------------

/** The classic runtime with a factory `h` (and, for fragments, `Frag`). */
const CLASSIC_H: ts.CompilerOptions = {
  jsx: 2,
  jsxFactory: "h",
  jsxFragmentFactory: "Frag",
};

export const JSX: readonly A3bCase[] = [
  {
    id: "jsx.component",
    finding: "PRM-116",
    mechanism:
      "`<App />`: the factory renders the component, which calls the target (the audit's p3-tsx-jsx-factory)",
    language: "tsx",
    tsOptions: CLASSIC_H,
    prelude: true,
    source: {
      app: `function h(tag: any, props: any) { return typeof tag === "function" ? tag(props) : tag; }\nfunction App() { return lib.parse("x"); }\nconst el = <App />;\n`,
    },
    negative: {
      app: `function h(tag: any, props: any) { return typeof tag === "function" ? tag(props) : tag; }\nfunction App() { return lib.parse("x"); }\n`,
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx.factory-body",
    finding: "PRM-116",
    mechanism: "`<div />`: the factory itself calls the target",
    language: "tsx",
    tsOptions: CLASSIC_H,
    prelude: true,
    source: {
      app: `function h(tag: any) { return lib.parse(String(tag)); }\nconst el = <div />;\n`,
    },
    negative: {
      app: `function h(tag: any) { return lib.parse(String(tag)); }\n`,
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx.attribute-callback",
    finding: "PRM-116",
    mechanism:
      "`<div onClick={() => …} />`: the factory calls a function handed to it as an attribute",
    language: "tsx",
    tsOptions: CLASSIC_H,
    prelude: true,
    source: {
      app: `function h(tag: any, props: any) { props.onClick(); return tag; }\nconst el = <div onClick={() => lib.parse("x")} />;\n`,
    },
    negative: {
      app: `function h(tag: any, props: any) { props.onClick(); return tag; }\nconst handler = () => lib.parse("x");\n`,
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx.child-callback",
    finding: "PRM-116",
    mechanism:
      "`<div>{() => …}</div>`: the factory calls a function handed to it as a child",
    language: "tsx",
    tsOptions: CLASSIC_H,
    prelude: true,
    source: {
      app: `function h(tag: any, props: any, child: any) { child(); return tag; }\nconst el = <div>{() => lib.parse("x")}</div>;\n`,
    },
    negative: {
      app: `function h(tag: any, props: any, child: any) { child(); return tag; }\nconst child = () => lib.parse("x");\n`,
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx.fragment",
    finding: "PRM-116",
    mechanism:
      "`<>…</>`: a fragment calls the factory with the fragment factory, which the factory calls",
    language: "tsx",
    tsOptions: CLASSIC_H,
    prelude: true,
    source: {
      app: `function h(tag: any) { return typeof tag === "function" ? tag() : tag; }\nfunction Frag() { return lib.parse("x"); }\nconst el = <>{1}</>;\n`,
    },
    negative: {
      app: `function h(tag: any) { return typeof tag === "function" ? tag() : tag; }\nfunction Frag() { return lib.parse("x"); }\n`,
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx.pragma-factory",
    finding: "PRM-116",
    mechanism:
      "`/** @jsx h */`: a pragma names the classic factory, which calls the target",
    language: "tsx",
    tsOptions: { jsx: 2 },
    prelude: false,
    source: {
      app: `/** @jsx h */\nimport lib = require("vuln-lib");\nfunction h(tag: any) { return lib.parse(String(tag)); }\nconst el = <div />;\n`,
    },
    negative: {
      app: `/** @jsx h */\nimport lib = require("vuln-lib");\nfunction h(tag: any) { return lib.parse(String(tag)); }\n`,
    },
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// RWF-066 -- the automatic runtime loads a module no source line spells
// ---------------------------------------------------------------------------

export const JSX_RUNTIME_LOADS: readonly A3bCase[] = [
  {
    id: "jsx-runtime.import-source-option",
    finding: "RWF-066",
    mechanism:
      "`jsx: react-jsx`, `jsxImportSource: vuln-lib`: `<div />` requires `vuln-lib/jsx-runtime`, which calls the target",
    language: "tsx",
    tsOptions: { jsx: 4, jsxImportSource: "vuln-lib" },
    prelude: false,
    source: {
      app: `const el = <div />;\n`,
      files: { "node_modules/vuln-lib/jsx-runtime.js": JSX_RUNTIME },
    },
    negative: {
      app: `const el = "div";\n`,
      files: { "node_modules/vuln-lib/jsx-runtime.js": JSX_RUNTIME },
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx-runtime.import-source-pragma",
    finding: "RWF-066",
    mechanism:
      "`/** @jsxImportSource vuln-lib */` in a project whose `jsx` is the classic `react`: the pragma switches the file to the automatic runtime",
    language: "tsx",
    tsOptions: { jsx: 2 },
    prelude: false,
    source: {
      app: `/** @jsxImportSource vuln-lib */\nconst el = <div />;\n`,
      files: { "node_modules/vuln-lib/jsx-runtime.js": JSX_RUNTIME },
    },
    negative: {
      app: `/** @jsxImportSource vuln-lib */\nconst el = "div";\n`,
      files: { "node_modules/vuln-lib/jsx-runtime.js": JSX_RUNTIME },
    },
    expected: "UNKNOWN",
  },
];

/**
 * Task A-3b's independent audit: three forms whose compiled JSX loads a
 * module, each a family-A false `NOT_AFFECTED` in the first version of
 * this task (its runtime decision read neither the project's
 * `jsxImportSource` nor the LAST of repeated pragmas, and decided a classic
 * factory's loader-ness by its spelling).
 */
export const JSX_RUNTIME_LOADS_AUDITED: readonly A3bCase[] = [
  {
    id: "jsx-runtime.import-source-option-classic",
    finding: "RWF-066",
    mechanism:
      "`jsx: react` with the project option `jsxImportSource: vuln-lib`: TypeScript compiles for the automatic runtime",
    language: "tsx",
    tsOptions: { jsx: 2, jsxImportSource: "vuln-lib" },
    prelude: false,
    source: {
      app: `const el = <div />;\n`,
      files: { "node_modules/vuln-lib/jsx-runtime.js": JSX_RUNTIME },
    },
    negative: {
      app: `const el = "div";\n`,
      files: { "node_modules/vuln-lib/jsx-runtime.js": JSX_RUNTIME },
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx-runtime.repeated-pragma-last-wins",
    finding: "RWF-066",
    mechanism:
      "`@jsxRuntime classic` then `@jsxRuntime automatic`: TypeScript reads the last",
    language: "tsx",
    tsOptions: { jsx: 2 },
    prelude: false,
    source: {
      app: `/** @jsxRuntime classic */\n/** @jsxRuntime automatic */\n/** @jsxImportSource vuln-lib */\nconst el = <div />;\n`,
      files: { "node_modules/vuln-lib/jsx-runtime.js": JSX_RUNTIME },
    },
    negative: {
      app: `/** @jsxRuntime classic */\n/** @jsxRuntime automatic */\n/** @jsxImportSource vuln-lib */\nconst el = "div";\n`,
      files: { "node_modules/vuln-lib/jsx-runtime.js": JSX_RUNTIME },
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx-runtime.classic-factory-require-alias",
    finding: "RWF-066",
    mechanism:
      '`jsxFactory: "r"` with `const r = require`: `<vuln-lib />` compiles to `r("vuln-lib", null)`, a require',
    language: "tsx",
    tsOptions: { jsx: 2, jsxFactory: "r" },
    prelude: false,
    source: {
      app: `const r = require;\nconst m: any = <vuln-lib />;\nm.parse("x");\n`,
    },
    negative: { app: `const r = require;\n` },
    expected: "UNKNOWN",
  },
  {
    id: "jsx-runtime.classic-factory-destructuring-write",
    finding: "RWF-066",
    mechanism:
      "a classic factory `h` declared as a function, then rewritten to `Module._load` by a for-of destructuring assignment (the audit's second round)",
    language: "tsx",
    tsOptions: { jsx: 2, jsxFactory: "h" },
    prelude: false,
    source: {
      app: `import M = require("module");\nimport path = require("path");\nfunction h(..._a: any[]): any {}\nfor ({ _load: h } of [M as any]) {}\nconst Mod = "vuln-lib";\nconst m: any = <Mod paths={[path.join(__dirname, "..", "node_modules")]} />;\nm.parse("x");\n`,
    },
    negative: {
      app: `import M = require("module");\nimport path = require("path");\nfunction h(..._a: any[]): any {}\nfor ({ _load: h } of [M as any]) {}\nconst dir = path.join(__dirname, "..");\n`,
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx-runtime.classic-factory-non-null-write",
    finding: "RWF-066",
    mechanism:
      "a classic factory rewritten through a TypeScript-wrapped assignment target, `for ({ _load: h! } of [M as any]) {}` (the audit's third round)",
    language: "tsx",
    tsOptions: { jsx: 2, jsxFactory: "h" },
    prelude: false,
    source: {
      app: `import M = require("module");\nimport path = require("path");\nfunction h(..._a: any[]): any {}\nfor ({ _load: h! } of [M as any]) {}\nconst Mod = "vuln-lib";\nconst m: any = <Mod paths={[path.join(__dirname, "..", "node_modules")]} />;\nm.parse("x");\n`,
    },
    negative: {
      app: `import M = require("module");\nimport path = require("path");\nfunction h(..._a: any[]): any {}\nfor ({ _load: h! } of [M as any]) {}\nconst dir = path.join(__dirname, "..");\n`,
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx-runtime.classic-factory-as-for-of-head-write",
    finding: "RWF-066",
    mechanism:
      "a classic factory rewritten through a TypeScript-wrapped assignment target, `for ((h as any) of [(M as any)._load]) {}` (the audit's third round)",
    language: "tsx",
    tsOptions: { jsx: 2, jsxFactory: "h" },
    prelude: false,
    source: {
      app: `import M = require("module");\nimport path = require("path");\nfunction h(..._a: any[]): any {}\nfor ((h as any) of [(M as any)._load]) {}\nconst Mod = "vuln-lib";\nconst m: any = <Mod paths={[path.join(__dirname, "..", "node_modules")]} />;\nm.parse("x");\n`,
    },
    negative: {
      app: `import M = require("module");\nimport path = require("path");\nfunction h(..._a: any[]): any {}\nfor ((h as any) of [(M as any)._load]) {}\nconst dir = path.join(__dirname, "..");\n`,
    },
    expected: "UNKNOWN",
  },
  {
    id: "jsx-runtime.classic-factory-react-namespace",
    finding: "RWF-066",
    mechanism:
      "`reactNamespace: foo`: the default factory is `foo.createElement`, rewritten to `Module._load` (the audit's fourth round)",
    language: "tsx",
    tsOptions: { jsx: 2, reactNamespace: "foo" },
    prelude: false,
    source: {
      app: `import M = require("module");\nimport path = require("path");\nfunction React() {}\nlet foo: any = {};\nfor ({ _load: foo.createElement } of [M as any]) {}\nconst Mod = "vuln-lib";\nconst m: any = <Mod paths={[path.join(__dirname, "..", "node_modules")]} />;\nm.parse("x");\n`,
    },
    negative: {
      app: `import M = require("module");\nimport path = require("path");\nfunction React() {}\nlet foo: any = {};\nfor ({ _load: foo.createElement } of [M as any]) {}\nconst dir = path.join(__dirname, "..");\n`,
    },
    expected: "UNKNOWN",
  },
];

// ---------------------------------------------------------------------------
// RWF-065 -- `module.parent.require` (lane C's; recorded, not fixed here)
// ---------------------------------------------------------------------------

export const LOADER_GAP: readonly A3bCase[] = [
  {
    id: "module-scope.parent-require",
    finding: "RWF-065",
    mechanism:
      '`module.parent.require("vuln-lib")` loads the package and calls the target; the loader classifier does not recognise the load',
    language: "js",
    prelude: false,
    source: {
      app: `require("./a.js");\n`,
      files: {
        "src/a.js": `module.parent.require("vuln-lib").parse("x");\n`,
      },
    },
    negative: {
      app: `require("./a.js");\n`,
      files: { "src/a.js": `module.exports = 1;\n` },
    },
    expected: "UNKNOWN",
    // Family A: the module-load closure never sees the load, and the call
    // graph's widening edge (task A-3b) cannot reach a closure built from
    // the loader classifier's own whole-file scan. Lane C (backlog BL-040).
    // Measured on the base: the same verdict with one unknown edge (the
    // `.parse` call on the call result); A-3b adds the second, its
    // `loader_capability_escape` edge at `module.parent.require(...)`.
    openDefect: {
      rwf: "RWF-065",
      observed: {
        verdict: "NOT_AFFECTED",
        proofFamily: "A",
        target: "vuln-lib#parse",
        reachableSubgraphComplete: false,
        unknownEdges: 2,
      },
    },
  },
];

/**
 * RWF-067 (task A-3b's independent audit, second round; lane C): a loader
 * capability that escapes through a for-of destructuring assignment is not
 * seen by the module-load closure, with no JSX at all. Recorded here with
 * its correct verdict standing; backlog BL-043. Measured on the branch:
 * one unknown edge, the `.parse` call on the result of `h(...)`.
 */
export const LOADER_GAP_AUDITED: readonly A3bCase[] = [
  {
    id: "module-scope.for-of-destructured-module-load",
    finding: "RWF-067",
    mechanism:
      '`for ({ _load: h } of [require("module")])` rebinds `h` to `Module._load`, which loads the package',
    language: "js",
    prelude: false,
    source: {
      app: `const M = require("module");\nconst path = require("path");\nfunction h() {}\nfor ({ _load: h } of [M]) {}\nconst m = h("vuln-lib", { paths: [path.join(__dirname, "..", "node_modules")] });\nm.parse("x");\n`,
    },
    negative: {
      app: `const M = require("module");\nconst path = require("path");\nfunction h() {}\nfor ({ _load: h } of [M]) {}\nconst dir = path.join(__dirname, "..");\n`,
    },
    expected: "UNKNOWN",
    openDefect: {
      rwf: "RWF-067",
      observed: {
        verdict: "NOT_AFFECTED",
        proofFamily: "A",
        target: "vuln-lib#parse",
        reachableSubgraphComplete: false,
        unknownEdges: 1,
      },
    },
  },
];

export const ALL_CASES: readonly A3bCase[] = [
  ...OWN_EXPORTS,
  ...JSX,
  ...JSX_RUNTIME_LOADS,
  ...JSX_RUNTIME_LOADS_AUDITED,
  ...LOADER_GAP,
  ...LOADER_GAP_AUDITED,
];
