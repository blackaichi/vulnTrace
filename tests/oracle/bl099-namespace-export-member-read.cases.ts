import ts from "typescript";
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
import type { CaseVerdict } from "./e1-export-write-set.cases.js";

/**
 * Task BL-099 (docs/tasks/BL-099-namespace-export-member-read.md): a use
 * of a namespace's exported member, against real Node (FINDINGS RWF-141).
 *
 * TypeScript compiles a namespace's exports onto the namespace's object,
 * and rewrites the uses (measured on the repository's own TypeScript at
 * targets ES5, ES2020 and ES2022):
 *
 * - in the block that exports it, every use of an exported variable
 *   (`export let` / `var` / `const`, a destructured one included) and of
 *   an `export import` alias is a member read (`h(1)` → `N.h(1)`); an
 *   exported function or class keeps its local binding;
 * - in another block of the merged namespace, and in a namespace nested
 *   in it (`namespace N.P`), every use of any exported member is a member
 *   read, the function and class included.
 *
 * The read runs whatever the object answers: the program's own static
 * accessor on a class merged with the namespace, one it inherits, or a
 * value another block stored. The call graph resolved the name to the
 * variable's initializer (classes B and C, AGENTS.md § F), or from
 * another block to an outer declaration spelled the same (class A).
 *
 * Each program is `src/impl.ts`, loaded by the entrypoint `src/index.ts`
 * (`import "./impl"`), as task BL-095's cases are: a namespace's exports
 * in an entrypoint are masked (`entrypoint_root_incomplete`). The loud
 * fixture `vuln-lib` exports `parse` and `safe`; the controls are task
 * A-1's (the positive control's entrypoint calls `lib.parse("x")` first;
 * the negative control is the case with `lib.safe` for `lib.parse`).
 *
 * `base` is the analyzer's verdict on BL-099's base `692b365` (BL-097's
 * merge), measured. A case with `base: "NOT_AFFECTED"` and `called: true`
 * is a live false `NOT_AFFECTED` this task closes; `control.*` keep their
 * precision; `cost.*` is precision given up, measured.
 */
export interface Bl099Case {
  readonly id: string;
  readonly finding: string;
  readonly mechanism: string;
  /** `src/impl.ts` after `import lib = require("vuln-lib");`; `hook` names the export the case's code calls. */
  readonly program: (hook: "parse" | "safe") => string;
  /** The compile target. */
  readonly target: "es5" | "es2020" | "es2022";
  /**
   * `src/impl.ts` is a script, not a module: no `import … = require`, no
   * `export {}` (`lib` is `require`d into a `const`), so its namespaces
   * merge with other files' (the audit's round 1, finding 3).
   */
  readonly script?: true;
  /** Compile `src/` as one program, not file by file (a module augmentation needs the checker). */
  readonly wholeProgram?: true;
  /** What `src/index.ts` runs instead of `import "./impl";`: a use of what the module exports. */
  readonly trigger?: string;
  /**
   * Why no negative control can be `NOT_AFFECTED` once the case is sound
   * (task H-0's `ControlsDeclaration`).
   */
  readonly controlsInapplicable?: string;
  readonly called: boolean;
  readonly base: CaseVerdict;
  readonly expected: CaseVerdict;
}

const ADVISORY_ID = "GHSA-bl099-namespace-member";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

const TARGETS = {
  es5: ts.ScriptTarget.ES5,
  es2020: ts.ScriptTarget.ES2020,
  es2022: ts.ScriptTarget.ES2022,
} as const;

function project(
  kase: Bl099Case,
  hook: "parse" | "safe",
  direct: boolean,
): ProjectSpec {
  const impl =
    kase.script === true
      ? `const lib = require("vuln-lib");\n${kase.program(hook)}`
      : `import lib = require("vuln-lib");\n${kase.program(hook)}export {};\n`;
  const index =
    (direct ? `import lib = require("vuln-lib");\nlib.parse("x");\n` : "") +
    `${kase.trigger ?? `import "./impl";\n`}export {};\n`;
  const options: ts.CompilerOptions = { target: TARGETS[kase.target] };
  return {
    files: {
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
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "commonjs", target: kase.target },
      }),
      "src/index.ts": index,
      "src/impl.ts": impl,
      ...(kase.wholeProgram === true
        ? compileWholeProgram({ "index.ts": index, "impl.ts": impl }, options)
        : {
            "dist/index.js": compileTypeScript(index, "index.ts", options),
            "dist/impl.js": compileTypeScript(impl, "impl.ts", options),
          }),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.ts"] }),
    },
  };
}

/**
 * The `dist/` files of `sources` emitted as ONE program by the repository's
 * TypeScript, in memory: a rewrite that needs the checker -- a module
 * augmentation's members (`declare module "./impl" { namespace N { … } }`)
 * -- is invisible to `transpileModule`, which compiles a file alone. Type
 * errors (here, the unresolved `vuln-lib`) do not stop the emit, as with
 * `tsc` by default (`noEmitOnError` is off).
 */
function compileWholeProgram(
  sources: Readonly<Record<string, string>>,
  options: ts.CompilerOptions,
): Record<string, string> {
  const root = "/bl099/src/";
  const compilerOptions: ts.CompilerOptions = {
    ...options,
    module: ts.ModuleKind.CommonJS,
    rootDir: root,
    outDir: "/bl099/dist/",
  };
  const host = ts.createCompilerHost(compilerOptions);
  const inMemory = (fileName: string): string | undefined =>
    fileName.startsWith(root)
      ? sources[fileName.slice(root.length)]
      : undefined;
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.readFile = (fileName) => inMemory(fileName) ?? readFile(fileName);
  host.fileExists = (fileName) =>
    inMemory(fileName) !== undefined || fileExists(fileName);
  // Module resolution asks for the directory before the file.
  const directoryExists = host.directoryExists?.bind(host);
  host.directoryExists = (directory) =>
    directory.startsWith("/bl099") || (directoryExists?.(directory) ?? false);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = inMemory(fileName);
    return text !== undefined
      ? ts.createSourceFile(fileName, text, languageVersion, true)
      : getSourceFile(fileName, languageVersion, ...rest);
  };
  const emitted: Record<string, string> = {};
  host.writeFile = (fileName, text) => {
    if (fileName.startsWith("/bl099/dist/") && fileName.endsWith(".js")) {
      emitted[`dist/${fileName.slice("/bl099/dist/".length)}`] = text;
    }
  };
  ts.createProgram(
    Object.keys(sources).map((name) => root + name),
    compilerOptions,
    host,
  ).emit();
  return emitted;
}

export function bl099OracleCase(kase: Bl099Case): OracleCase {
  return {
    id: kase.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand("dist/index.js"),
    controls:
      kase.controlsInapplicable !== undefined
        ? { kind: "inapplicable", reason: kase.controlsInapplicable }
        : {
            kind: "controls",
            controls: {
              positive: {
                name: "positive-control",
                project: project(kase, "safe", true),
              },
              negative: {
                name: "negative-control",
                project: project(kase, "safe", false),
              },
            },
          },
    variant: { name: "case", project: project(kase, "parse", false) },
  };
}

/** A class merged with `N` whose own static accessor answers `N.<name>` with `lib.<hook>`. */
const accessorClass = (name: string, hook: string) =>
  `class N { static get ${name}(): any { return lib.${hook}; } static set ${name}(_v: any) {} }\n`;
const IDENTITY = "function (x: any) { return x; }";

/**
 * Why no negative control can be `NOT_AFFECTED` once a case is sound: the
 * member read is an unknown callee whatever the object answers -- task
 * BL-099 never proves what the namespace's object holds -- so the negative
 * control (`lib.safe` for `lib.parse`) is `UNKNOWN` too. Precision is
 * measured by the `control.*` and `cost.*` cases instead.
 */
/** In a script, every name leaving a namespace may be another file's member: an unknown callee, in the negative control too. */
const SCRIPT_NAMESPACE =
  "in a file that is not a module a namespace merges with other files' blocks, so every name a use in it leaves the namespace for is refused (an unknown callee), in the negative control too";

const UNKNOWN_CALLEE =
  "a use of a namespace's exported member is a member read, an unknown callee whatever the namespace's object answers (BL-099 never proves what it holds), so the negative control is UNKNOWN too; precision is measured by the control.* and cost.* cases";
/** A function that calls `lib.<hook>`: reached only through an edge to it. */
const calling = (hook: string) =>
  `function (x: any) { lib.${hook}(x); return x; }`;

export const BL099_CASES: readonly Bl099Case[] = [
  // RWF-141: the program's own accessor answers the member read.
  {
    id: "rwf141.static-getter-on-a-merged-class",
    finding: "RWF-141",
    mechanism:
      "`class N { static get h() { return lib.parse; } … } namespace N { export let h = f; h(1); }`: `N.h(1)` runs the getter's result (the record's reproduction)",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export let h: any = ${IDENTITY}; h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.exported-const",
    finding: "RWF-141",
    mechanism: "`namespace N { export const h = f; h(1); }`",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export const h: any = ${IDENTITY}; h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.exported-var-at-es5",
    finding: "RWF-141",
    mechanism: "`namespace N { export var h = f; h(1); }` at target ES5",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export var h: any = ${IDENTITY}; h(1); }\n`,
    target: "es5",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.inherited-static-getter",
    finding: "RWF-141",
    mechanism:
      "`class B { static get h() … } class N extends B {} namespace N { export let h = f; h(1); }`: the getter is inherited",
    program: (hook) =>
      `class B { static get h(): any { return lib.${hook}; } static set h(_v: any) {} }\nclass N extends B {}\nnamespace N { export let h: any = ${IDENTITY}; h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.call-in-a-nested-function",
    finding: "RWF-141",
    mechanism:
      "`namespace N { export let h = f; function run() { h(1); } run(); }`: the read in a nested function is `N.h` too",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export let h: any = ${IDENTITY}; function run() { h(1); } run(); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.alias-of-the-exported-variable",
    finding: "RWF-141",
    mechanism:
      "`namespace N { export let h = f; const a = h; a(1); }`: `const a = N.h`",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export let h: any = ${IDENTITY}; const a = h; a(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.handed-to-a-callback-builtin",
    finding: "RWF-141",
    mechanism:
      "`namespace N { export let h = f; setTimeout(h, 0); }`: `setTimeout(N.h, 0)` calls what the getter returns",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export let h: any = ${IDENTITY}; setTimeout(h, 0); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.tagged-template",
    finding: "RWF-141",
    mechanism: "`namespace N { export let h = f; h`t`; }`",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export let h: any = ${IDENTITY}; h\`t\`; }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.new-expression",
    finding: "RWF-141",
    mechanism: "`namespace N { export let h = f; new h(1); }`",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export let h: any = ${IDENTITY}; new h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Already `UNKNOWN` on the base through another account, its negative
  // control too. (A value stored from another block is BL-095's
  // `rwf131.exported-variable-written-from-another-block`: an escape.)
  {
    id: "masked.call-method",
    finding: "RWF-141",
    mechanism:
      "`namespace N { export let h = f; h.call(null, 1); }`: `unsupported_receiver_binding` on the base",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export let h: any = ${IDENTITY}; h.call(null, 1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.destructured-export",
    finding: "RWF-141",
    mechanism:
      "`namespace N { export let { h } = { h: f }; h(1); }`: `N.h = _a.h; N.h(1)`; `unsupported_callee_binding` on the base",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export let { h }: any = { h: ${IDENTITY} }; h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.export-import-alias",
    finding: "RWF-141",
    mechanism:
      "`namespace I { export const f = g; } namespace N { export import h = I.f; h(1); }`: `N.h = I.f; N.h(1)`; `unsupported_callee_binding` on the base",
    program: (hook) =>
      `namespace I { export const f: any = ${IDENTITY}; }\n${accessorClass("h", hook)}namespace N { export import h = I.f; h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // RWF-141, binding identity: from another block of the merged namespace,
  // or a nested one, a use of any exported member is `N.<name>`, never the
  // outer declaration spelled the same.
  {
    id: "rwf141.another-block-shadows-an-outer-const",
    finding: "RWF-141",
    mechanism:
      "`const h = f; namespace N { export let h = g; } namespace N { h(1); }`: `h` is `N.h`, not the outer `h`",
    program: (hook) =>
      `const h: any = ${IDENTITY};\nnamespace N { export let h: any = ${calling(hook)}; }\nnamespace N { h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.another-block-shadows-an-outer-function",
    finding: "RWF-141",
    mechanism:
      "`function f() {} namespace N { export function f() { … } } namespace N { f(1); }`: an exported function is `N.f` from another block",
    program: (hook) =>
      `function f(x: any) { return x; }\nnamespace N { export function f(x: any) { lib.${hook}(x); return x; } }\nnamespace N { f(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.nested-dotted-namespace",
    finding: "RWF-141",
    mechanism:
      "`const h = f; namespace N { export let h = g; } namespace N.P { h(1); }`: a nested namespace reads its parent's export",
    program: (hook) =>
      `const h: any = ${IDENTITY};\nnamespace N { export let h: any = ${calling(hook)}; }\nnamespace N.P { h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf141.nested-namespace-block",
    finding: "RWF-141",
    mechanism:
      "`const h = f; namespace N { export let h = g; } namespace N { namespace P { h(1); } }`",
    program: (hook) =>
      `const h: any = ${IDENTITY};\nnamespace N { export let h: any = ${calling(hook)}; }\nnamespace N { namespace P { h(1); } }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "scope.import-alias-in-a-namespace-shadows-an-outer-const",
    finding: "RWF-145",
    mechanism:
      "`const g = f; namespace I { export const h = …; } namespace N { import g = I.h; g(1); }`: a namespace's own `import g =` is a local binding (`var g = I.h`) the resolver did not record, so `g` bound to the outer `const g`",
    program: (hook) =>
      `const g: any = ${IDENTITY};\nnamespace I { export const h: any = ${calling(hook)}; }\nnamespace N { import g = I.h; g(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "masked.nested-namespace-shadows-an-outer-const",
    finding: "RWF-145",
    mechanism:
      "`const M = { run: f }; namespace N { namespace M { export const run = g; } M.run(1); }`: the nested namespace is a local `var M`, but the resolver records no namespace declaration and binds `M` to the outer `const` (open, backlog BL-102); masked end to end by `unsupported_receiver_binding`",
    program: (hook) =>
      `const M: any = { run: ${IDENTITY} };\nnamespace N { namespace M { export const run: any = ${calling(hook)}; } M.run(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.enum-shadows-an-outer-const",
    finding: "RWF-145",
    mechanism:
      "`const E = { A: f }; function main() { enum E { A = g as any } E.A(1); }`: an enum is a local `let E` whose member holds `g`, but the resolver records no enum declaration and binds `E` to the outer `const` (open, backlog BL-102); masked end to end by `unsupported_receiver_binding`",
    program: (hook) =>
      `const E: any = { A: ${IDENTITY} };\nconst g: any = ${calling(hook)};\nfunction main() { enum E { A = g as any } (E.A as any)(1); }\nmain();\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // The task's independent audit, round 1, finding 1: an ambient block's
  // declarations are exported without the keyword, and a use from another
  // block is rewritten to a member read. `N.call` on a function is
  // `Function.prototype.call`, which runs `N`.
  {
    id: "audit1.ambient-variable-merged-with-a-function",
    finding: "RWF-141",
    mechanism:
      "`const call = f; function N(x) { lib.parse(x); } declare namespace N { let call: any; } namespace N { call(1); }`: `N.call(1)` runs `N`",
    program: (hook) =>
      `const call: any = ${IDENTITY};\nfunction N(x: any) { lib.${hook}(x); }\ndeclare namespace N { let call: any; }\nnamespace N { call(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit1.ambient-function",
    finding: "RWF-141",
    mechanism:
      "`function call() {} … declare namespace N { function call(...a): any; } namespace N { call(1); }`",
    program: (hook) =>
      `function call(x: any) { return x; }\nfunction N(x: any) { lib.${hook}(x); }\ndeclare namespace N { function call(...a: any[]): any; }\nnamespace N { call(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit1.ambient-member-from-a-nested-namespace",
    finding: "RWF-141",
    mechanism:
      "`… declare namespace N { let call: any; } namespace N.Q { call(1); }`: a nested namespace reads its parent's ambient member",
    program: (hook) =>
      `const call: any = ${IDENTITY};\nfunction N(x: any) { lib.${hook}(x); }\ndeclare namespace N { let call: any; }\nnamespace N.Q { call(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "masked.exported-onto-the-exports-object",
    finding: "RWF-141",
    mechanism:
      "`class N { static get run() … } namespace N { export let run = f; exports.run = run; }`: `exports.run = N.run` exports what the getter returns; the importer's call of `run` is unattributed on the base (`unsupported_callee_binding`)",
    program: (hook) =>
      `${accessorClass("run", hook)}namespace N { export let run: any = ${IDENTITY}; exports.run = run; }\n`,
    trigger: `import { run } from "./impl";\n(run as any)(1);\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // The audit's round 2, finding 1: introduced by this task's first fix,
  // which recorded `import x = require("m")` in a namespace as a binding.
  // TypeScript emits nothing for it there (an error it still emits), so
  // `x` is the outer binding; the import was taken for a load of
  // `vuln-lib` and `x.safe` attributed to its `safe`. `NOT_AFFECTED` on
  // the round's commit `55890a6`; `UNKNOWN` on the base and now.
  {
    id: "audit2.import-require-in-a-namespace",
    finding: "RWF-145",
    mechanism:
      '`const x = { safe: g }; namespace N { import x = require("vuln-lib"); x.safe(1); }`: no binding is emitted, `x.safe` is the outer `g`',
    program: (hook) =>
      `const x: any = { safe: ${calling(hook)} };\nnamespace N { import x = require("vuln-lib"); x.safe(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // The audit's round 2, finding 2: a module augmentation merges members
  // into a namespace the module exports, from this file or another, and the
  // checker rewrites their uses (compiled as one program).
  {
    id: "audit2.module-augmentation-in-the-same-file",
    finding: "RWF-141",
    mechanism:
      '`export function N(x) { lib.parse(x); } export namespace N { call(1); } declare module "./impl" { namespace N { let call: any; } }`: `N.call(1)` runs `N`',
    program: (hook) =>
      `const call: any = ${IDENTITY};\nexport function N(x: any) { lib.${hook}(x); }\nexport namespace N { call(1); }\ndeclare module "./impl" { namespace N { let call: any; } }\n`,
    wholeProgram: true,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit2.module-augmentation-from-another-file",
    finding: "RWF-141",
    mechanism:
      'the entrypoint declares `declare module "./impl" { namespace N { let call: any; } }`; `impl.ts`\'s `export namespace N { call(1); }` is rewritten to `N.call(1)`',
    program: (hook) =>
      `const call: any = ${IDENTITY};\nexport function N(x: any) { lib.${hook}(x); }\nexport namespace N { call(1); }\n`,
    trigger: `import "./impl";\ndeclare module "./impl" { namespace N { let call: any; } }\n`,
    wholeProgram: true,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The audit's round 3: a module augmentation reaches a namespace through
  // an alias, and TypeScript emits an `export { h }` in a namespace it
  // reports. Each led to the rule that no name is looked up past a
  // namespace. `P.call(1)` on a function runs it.
  {
    id: "audit3.augmentation-through-export-assignment",
    finding: "RWF-141",
    mechanism:
      '`namespace N { export function P(x) { lib.parse(x); } export namespace P { call(1); } } export = N.P;` and elsewhere `declare module "./impl" { let call: any; }`',
    program: (hook) =>
      `const call: any = ${IDENTITY};\nnamespace N { export function P(x: any) { lib.${hook}(x); } export namespace P { call(1); } }\nexport = N.P;\n`,
    trigger: `import "./impl";\ndeclare module "./impl" { let call: any; }\n`,
    wholeProgram: true,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit3.augmentation-through-an-exported-alias",
    finding: "RWF-141",
    mechanism:
      '`import P = N.P; export { P };` and elsewhere `declare module "./impl" { namespace P { let call: any; } }`',
    program: (hook) =>
      `const call: any = ${IDENTITY};\nnamespace N { export function P(x: any) { lib.${hook}(x); } export namespace P { call(1); } }\nimport P = N.P;\nexport { P };\n`,
    trigger: `import "./impl";\ndeclare module "./impl" { namespace P { let call: any; } }\n`,
    wholeProgram: true,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit3.augmentation-through-export-import",
    finding: "RWF-141",
    mechanism:
      '`export import X = N.P;` and elsewhere `declare module "./impl" { namespace X { let call: any; } }`',
    program: (hook) =>
      `const call: any = ${IDENTITY};\nnamespace N { export function P(x: any) { lib.${hook}(x); } export namespace P { call(1); } }\nexport import X = N.P;\n`,
    trigger: `import "./impl";\ndeclare module "./impl" { namespace X { let call: any; } }\n`,
    wholeProgram: true,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit3.export-declaration-in-a-namespace",
    finding: "RWF-141",
    mechanism:
      "`class Q { static get h() … } namespace Q { const h = 2; export { h }; } namespace Q { h(1); }`: TypeScript reports the `export { h }` and still rewrites `h(1)` to `Q.h(1)`",
    program: (hook) =>
      `const h: any = ${IDENTITY};\n${accessorClass("h", hook).replace("class N", "class Q")}namespace Q { const h: any = 2; export { h }; }\nnamespace Q { h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The audit's round 4 (RWF-147): in strict code a function declared in a
  // nested block is scoped to it, so the name outside the block is the
  // outer binding -- in a namespace, the member read `N.h`. The resolver
  // hoisted it to the enclosing function scope.
  {
    id: "audit4.block-function-in-a-namespace",
    finding: "RWF-147",
    mechanism:
      "`namespace N { export var h = lib.parse; } namespace N { { function h(x) { return x; } } h(1); }`: `N.h(1)`",
    program: (hook) =>
      `namespace N { export var h: any = lib.${hook}; }\nnamespace N { { function h(x: any) { return x; } } h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit4.block-function-in-an-if-in-a-namespace",
    finding: "RWF-147",
    mechanism:
      "`namespace N { if (true) { function h(x) { return x; } } h(1); }` with `h` exported by another block",
    program: (hook) =>
      `namespace N { export var h: any = lib.${hook}; }\nnamespace N { if (true) { function h(x: any) { return x; } } h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit4.block-function-in-a-plain-function",
    finding: "RWF-147",
    mechanism:
      "no namespace: `const h = lib.parse; function g() { { function h(x) { return x; } } h(1); } g();` in a module (strict)",
    program: (hook) =>
      `const h: any = lib.${hook};\nfunction g() { { function h(x: any) { return x; } } h(1); }\ng();\n`,
    target: "es2020",
    controlsInapplicable:
      "the call through a name bound to a function declared in a nested block, seen from outside that block, is an unknown callee since BL-099 (RWF-147), so the negative control is UNKNOWN too",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The audit's round 5: a class static block is a var scope (findings 1
  // and 2); a use inside the block binds to the block's function before a
  // declaration between it and the hoisting scope (finding 3); an `export
  // var` in a nested block of a namespace, an error TypeScript still emits
  // as a member (finding 4).
  {
    id: "audit5.static-block-function-in-a-namespace",
    finding: "RWF-147",
    mechanism:
      "`namespace N { export var h = g; } namespace N { class C { static { function h(x) { return x; } } } h(1); }`: the function is the static block's own, `h(1)` is `N.h(1)`",
    program: (hook) =>
      `namespace N { export var h: any = ${calling(hook)}; }\nnamespace N { class C { static { function h(x: any) { return x; } } } h(1); }\n`,
    target: "es2022",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit5.static-block-var-in-a-namespace",
    finding: "RWF-147",
    mechanism:
      "`… namespace N { class C { static { var h = f; } } h(1); }`: the `var` is the static block's own",
    program: (hook) =>
      `namespace N { export var h: any = ${calling(hook)}; }\nnamespace N { class C { static { var h: any = ${IDENTITY}; } } h(1); }\n`,
    target: "es2022",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit5.block-function-used-inside-its-block",
    finding: "RWF-147",
    mechanism:
      "`function g() { const h = f; { function h(x) { lib.parse(x); } h(1); } } g();`: inside its block `h` is the block's function, not the `const` between (in a namespace the same holds, but `lib` is then an outer name, refused)",
    program: (hook) =>
      `function g() { const h: any = ${IDENTITY}; { function h(x: any) { lib.${hook}(x); return x; } h(1); } }\ng();\n`,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "AFFECTED",
  },
  {
    id: "audit5.exported-variable-in-a-nested-block",
    finding: "RWF-141",
    mechanism:
      "`class N { static get h() … } namespace N { { export var h = f; } h(1); }`: an error TypeScript still emits as `{ N.h = f } N.h(1)`",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { { export var h: any = ${IDENTITY}; } h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "control.block-function-used-inside-its-block",
    finding: "RWF-147",
    mechanism:
      "`const h = lib.parse; function g() { { function h(x) { return x; } h(1); } } g();`: inside its block `h` is the function",
    program: (hook) =>
      `const h: any = lib.${hook};\nfunction g() { { function h(x: any) { return x; } h(1); } }\ng();\n`,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // Controls: a use that stays a local binding.
  {
    id: "control.exported-function-in-its-own-block",
    finding: "RWF-141",
    mechanism:
      "`class N { static get f() … } namespace N { export function f() {} f(1); }`: an exported function keeps its local binding in its own block",
    program: (hook) =>
      `${accessorClass("f", hook)}namespace N { export function f(x: any) { return x; } f(1); }\n`,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.member-not-exported",
    finding: "RWF-141",
    mechanism:
      "`class N { static get h() … } namespace N { let h = f; h(1); }`: a member that is not exported stays local",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { let h: any = ${IDENTITY}; h(1); }\n`,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.inner-declaration-shadows-the-export",
    finding: "RWF-141",
    mechanism:
      "`namespace N { export let h = g; function run() { const h = f; h(1); } run(); }`: an inner `h` is its own binding",
    program: (hook) =>
      `${accessorClass("h", hook)}namespace N { export let h: any = ${IDENTITY}; function run() { const h: any = ${IDENTITY}; h(1); } run(); }\n`,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.outer-name-outside-the-namespace",
    finding: "RWF-141",
    mechanism:
      "`const h = f; namespace N { export let h = g; } h(1);`: outside the namespace, `h` is the outer binding",
    program: (hook) =>
      `const h: any = ${IDENTITY};\nnamespace N { export let h: any = ${calling(hook)}; }\nh(1);\n`,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // Precision given up: the namespace's object holds the initializer, but
  // nothing here proves it (task BL-099 does not prove what the object
  // holds).
  {
    id: "cost.standalone-namespace-exported-variable",
    finding: "RWF-141",
    mechanism:
      "`namespace N { export let h = f; h(1); }` with no accessor: `N.h` holds `f`, which calls `lib.parse`",
    program: (hook) =>
      `namespace N { export let h: any = ${calling(hook)}; h(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.outer-name-used-in-a-namespace",
    finding: "RWF-141",
    mechanism:
      "`function f(x) { lib.parse(x); } namespace N { f(1); }`: no name is looked up past a namespace, which may have members no file's syntax shows (the audit's rounds 2 and 3)",
    program: (hook) =>
      `function f(x: any) { lib.${hook}(x); return x; }\nnamespace N { f(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.import-alias-of-a-type-only-namespace",
    finding: "RWF-145",
    mechanism:
      "`const X = f; namespace M { export interface I {} } namespace N { import X = M; X(1); }`: an alias of a namespace with no value is elided, `X` stays the outer `f` (the audit's round 3, finding 3)",
    program: (hook) =>
      `const X: any = ${calling(hook)};\nnamespace M { export interface I {} }\nnamespace N { import X = M; X(1); }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.require-in-a-script-namespace",
    finding: "RWF-141",
    mechanism:
      'a file that is not a module: `namespace N { const l = require("vuln-lib"); l.parse("x"); }`: `require` too is refused past the namespace, so the load\'s result is opaque (the audit\'s round 3, finding 5)',
    program: (hook) =>
      `namespace N { const l = require("vuln-lib"); l.${hook}("x"); }\n`,
    script: true,
    target: "es2020",
    controlsInapplicable: SCRIPT_NAMESPACE,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.annex-b-block-function-in-a-script",
    finding: "RWF-147",
    mechanism:
      "a file that is not a module, sloppy: `if (true) { function g(x) { lib.parse(x); } } g(1);`: Annex B makes `g` visible after the block, but the resolver no longer decides strict from sloppy",
    program: (hook) =>
      `if (true) { function g(x: any) { lib.${hook}(x); return x; } }\ng(1);\n`,
    script: true,
    target: "es2020",
    controlsInapplicable:
      "the call through a name bound to a function declared in a nested block, seen from outside that block, is an unknown callee since BL-099 (RWF-147), so the negative control is UNKNOWN too",
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  // The audit's round 1, finding 3: two more costs, measured.
  {
    id: "cost.namespace-in-a-script-file",
    finding: "RWF-141",
    mechanism:
      "a file that is not a module: `function f(x) { lib.parse(x); } namespace N { f(1); }`; its namespaces merge with other files' blocks, so every name leaving one is refused",
    program: (hook) =>
      `function f(x: any) { lib.${hook}(x); return x; }\nnamespace N { f(1); }\n`,
    script: true,
    target: "es2020",
    controlsInapplicable: SCRIPT_NAMESPACE,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "cost.unexported-nested-namespaces-grouped-by-name",
    finding: "RWF-141",
    mechanism:
      "`function f(x) { lib.parse(x); } namespace N { namespace P { export function f … } } namespace N { namespace P { f(1); } }`: two unexported `P`s are distinct objects, but are grouped by qualified name, so `f` is refused",
    program: (hook) =>
      `function f(x: any) { lib.${hook}(x); return x; }\nnamespace N { namespace P { export function f(x: any) { return x; } } }\nnamespace N { namespace P { f(1); } }\n`,
    target: "es2020",
    controlsInapplicable: UNKNOWN_CALLEE,
    called: true,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
];
