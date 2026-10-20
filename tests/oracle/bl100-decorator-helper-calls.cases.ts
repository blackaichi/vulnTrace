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
 * Task BL-100 (docs/tasks/BL-100-decorator-helper-calls.md): what
 * TypeScript's decorator helpers do with a decorator's RESULT, against
 * real Node (FINDINGS RWF-142).
 *
 * A decorator's call is a site (task A-1, PRM-115). Its result is handed
 * to the emit's helpers, which invoke it, or members of it, later
 * (measured on the repository's own TypeScript, targets ES2020 and
 * ES2022):
 *
 * - legacy decorators (`experimentalDecorators`): `__decorate` installs a
 *   field's, method's or accessor's result with `Object.defineProperty`
 *   (a returned setter runs on a later store), and a class decorator's
 *   result replaces the class (`new C()` constructs it); a parameter
 *   decorator's result is discarded by `__param`;
 * - TC39 decorators: `__esDecorate` makes a field's result an initializer
 *   that `__runInitializers` runs on the field's value, a method's result
 *   the method, an accessor's result's `get` / `set` / `init` the
 *   accessor's, and a class decorator's result the class.
 *
 * Each program is `src/impl.ts`, loaded by the entrypoint `src/index.ts`
 * (`import "./impl"`), as tasks BL-095's and BL-099's cases are; a case
 * may add further modules (`src/decs.ts`) that `impl.ts` imports its
 * decorator or class from.
 * The loud fixture `vuln-lib` exports `parse` and `safe`; the controls are
 * task A-1's (the positive control's entrypoint calls `lib.parse("x")`
 * first; the negative control is the case with `lib.safe` for
 * `lib.parse`).
 *
 * `base` is the analyzer's verdict on BL-100's base `9b8ea34` (BL-099's
 * merge), measured. A case with `base: "NOT_AFFECTED"` and `called: true`
 * is a live false `NOT_AFFECTED` this task closes; `masked.*` were
 * already `UNKNOWN` through another account; `control.*` keep their
 * precision; `cost.*` is precision given up, measured.
 */
export interface Bl100Case {
  readonly id: string;
  readonly finding: string;
  readonly mechanism: string;
  /** `src/impl.ts` after `import lib = require("vuln-lib");`; `hook` names the export the case's code calls. */
  readonly program: (hook: "parse" | "safe") => string;
  /** Further modules of the program, `src/<name>.ts`, each after `import lib = require("vuln-lib");`: where `impl.ts` imports its decorator or class from. */
  readonly modules?: (
    hook: "parse" | "safe",
  ) => Readonly<Record<string, string>>;
  /** TypeScript's decorator mode: `legacy` is `experimentalDecorators`. */
  readonly mode: "legacy" | "tc39";
  /** The compile target: `es2020` emits a class field as an assignment, `es2022` defines it. */
  readonly target: "es2020" | "es2022";
  /**
   * Why no negative control can be `NOT_AFFECTED` once the case is sound
   * (task H-0's `ControlsDeclaration`).
   */
  readonly controlsInapplicable?: string;
  readonly called: boolean;
  readonly base: CaseVerdict;
  readonly expected: CaseVerdict;
}

const ADVISORY_ID = "GHSA-bl100-decorator-helpers";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

const TARGETS = {
  es2020: ts.ScriptTarget.ES2020,
  es2022: ts.ScriptTarget.ES2022,
} as const;

function project(
  kase: Bl100Case,
  hook: "parse" | "safe",
  direct: boolean,
): ProjectSpec {
  const lib = `import lib = require("vuln-lib");\n`;
  const impl = `${lib}${kase.program(hook)}export {};\n`;
  const index =
    (direct ? `${lib}lib.parse("x");\n` : "") +
    `import "./impl";\nexport {};\n`;
  const legacy = kase.mode === "legacy";
  const options: ts.CompilerOptions = {
    target: TARGETS[kase.target],
    experimentalDecorators: legacy,
  };
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
        compilerOptions: {
          module: "commonjs",
          target: kase.target,
          experimentalDecorators: legacy,
        },
      }),
      "src/index.ts": index,
      "src/impl.ts": impl,
      "dist/index.js": compileTypeScript(index, "index.ts", options),
      "dist/impl.js": compileTypeScript(impl, "impl.ts", options),
      ...Object.fromEntries(
        Object.entries(kase.modules?.(hook) ?? {}).flatMap(([name, body]) => [
          [`src/${name}.ts`, `${lib}${body}`],
          [
            `dist/${name}.js`,
            compileTypeScript(`${lib}${body}`, `${name}.ts`, options),
          ],
        ]),
      ),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.ts"] }),
    },
  };
}

export function bl100OracleCase(kase: Bl100Case): OracleCase {
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

/**
 * The returned function calls the value it is handed (the field's value,
 * `lib.parse` or `lib.safe`): a call through a parameter, an unknown edge
 * in the negative control too.
 */
const PARAMETER_CALL =
  "the decorator's returned function calls its parameter, the field's value: a call through a parameter is an unknown edge, so the negative control is UNKNOWN too";

/**
 * The decorator returns an object held by a name: the helper may run
 * anything reachable from it, which is not attributed (ADR 0008 Amendment
 * A-0, "Not proposed": an object passed by name is opaque).
 */
const OPAQUE_RESULT =
  "the decorator returns an object held by a name, which is opaque (ADR 0008 Amendment A-0): an unknown edge whatever it holds, so the negative control is UNKNOWN too";

/** A legacy setter descriptor whose setter calls `lib.<hook>`. */
const legacySetterDec = (hook: string) =>
  `function dec(_t: any, _k: string, _d?: any): any { return { set(_v: any) { lib.${hook}(1); }, configurable: true }; }\n`;

export const BL100_CASES: readonly Bl100Case[] = [
  // Legacy decorators: `__decorate` installs a member decorator's result.
  {
    id: "rwf142.legacy-field-store-runs-the-returned-setter",
    finding: "RWF-142",
    mechanism:
      "a legacy field decorator returns a setter descriptor; `__decorate` installs it on `C.prototype` and the field's assignment (target ES2020) runs it",
    program: (hook) =>
      `${legacySetterDec(hook)}class C { @dec x: any = 1; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.legacy-returned-setter-calls-the-value",
    finding: "RWF-142",
    mechanism:
      "the record's reproduction: `{ set(v) { v(1); } }` installed by `__decorate`, run by `this.x = lib.parse`",
    program: (hook) =>
      `function dec(_t: any, _k: string): any { return { set(v: any) { v(1); }, configurable: true }; }\nclass C { @dec x: any = lib.${hook}; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    controlsInapplicable: PARAMETER_CALL,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.legacy-constructor-store-runs-the-returned-setter",
    finding: "RWF-142",
    mechanism:
      "a field with no initializer, assigned in the constructor: `this.x = 1` runs the installed setter",
    program: (hook) =>
      `${legacySetterDec(hook)}class C { @dec x: any; constructor() { this.x = 1; } }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.legacy-method-decorator-returns-a-setter",
    finding: "RWF-142",
    mechanism:
      "a legacy method decorator returns a setter descriptor, which replaces the method; a store to the member runs it",
    program: (hook) =>
      `${legacySetterDec(hook)}class C { @dec m(): void {} }\nconst c: any = new C();\nc.m = 1;\n`,
    mode: "legacy",
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.legacy-returned-setter-is-the-target",
    finding: "RWF-142",
    mechanism:
      "the decorator returns `{ set: lib.parse }`: the field's assignment calls `lib.parse` as the setter",
    program: (hook) =>
      `function dec(_t: any, _k: string): any { return { set: lib.${hook}, configurable: true }; }\nclass C { @dec x: any = 1; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.legacy-arrow-decorator",
    finding: "RWF-142",
    mechanism:
      "the decorator is a `const` arrow whose concise body is the descriptor",
    program: (hook) =>
      `const dec = (_t: any, _k: string): any => ({ set(_v: any) { lib.${hook}(1); }, configurable: true });\nclass C { @dec x: any = 1; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.legacy-imported-decorator",
    finding: "RWF-142",
    mechanism:
      "the decorator is imported from another module of the program, which returns the setter descriptor",
    modules: (hook) => ({ decs: `export ${legacySetterDec(hook)}` }),
    program: () =>
      `import { dec } from "./decs";\nclass C { @dec x: any = 1; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.legacy-class-decorator-replaces-the-class",
    finding: "RWF-142",
    mechanism:
      "a legacy class decorator returns another class; `C = __decorate([dec], C)` makes `new C()` construct it",
    program: (hook) =>
      `function dec(_c: any): any { return class { constructor() { lib.${hook}(1); } }; }\n@dec class C {}\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.legacy-returned-setter-reads-this",
    finding: "RWF-142",
    mechanism:
      "the returned setter runs with the INSTANCE as `this`, not the descriptor: `this.h(v)` calls the class's own `h`, not the literal's",
    program: (hook) =>
      `function dec(_t: any, _k: string): any { return { set(this: any, v: any) { this.h(v); }, h(_v: any) {}, configurable: true }; }\nclass C { @dec x: any = 1; h(_v: any) { lib.${hook}(1); } }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    controlsInapplicable:
      "`this.h(v)` in the returned setter is an unknown callee (`unsupported_this_receiver`; measured: never bound to the literal's own `h`), so the negative control is UNKNOWN too",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.legacy-returned-object-by-name",
    finding: "RWF-142",
    mechanism:
      "the decorator returns a descriptor held by a `const`: opaque, so unknown",
    program: (hook) =>
      `function setter(_v: any) { lib.${hook}(1); }\nfunction dec(_t: any, _k: string): any { const d = { set: setter, configurable: true }; return d; }\nclass C { @dec x: any = 1; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    controlsInapplicable: OPAQUE_RESULT,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // TC39 decorators: `__esDecorate` takes a decorator's result as the
  // member, the initializer or the class.
  {
    id: "rwf142.tc39-field-initializer",
    finding: "RWF-142",
    mechanism:
      "a TC39 field decorator returns an initializer, which `__runInitializers` runs on the field's value",
    program: (hook) =>
      `function dec(_v: any, _c: any): any { return function (v: any) { lib.${hook}(1); return v; }; }\nclass C { @dec x: any = 1; }\nnew C();\n`,
    mode: "tc39",
    target: "es2022",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.tc39-field-initializer-calls-the-value",
    finding: "RWF-142",
    mechanism:
      "the record's reproduction: `(v) => { v(1); … }` run by `__runInitializers` on `lib.parse`",
    program: (hook) =>
      `function dec(_v: any, _c: any): any { return (v: any) => { v(1); return v; }; }\nclass C { @dec x: any = lib.${hook}; }\nnew C();\n`,
    mode: "tc39",
    target: "es2022",
    controlsInapplicable: PARAMETER_CALL,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "masked.tc39-method-replacement",
    finding: "RWF-142",
    mechanism:
      "a TC39 method decorator's result replaces the method; `new C().m()` calls it",
    program: (hook) =>
      `function dec(_v: any, _c: any): any { return function () { lib.${hook}(1); }; }\nclass C { @dec m(): void {} }\nnew C().m();\n`,
    mode: "tc39",
    target: "es2022",
    controlsInapplicable:
      "`new C().m()` is a call on a literal receiver, an unknown edge (`unsupported_literal_receiver`) in the negative control too",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.tc39-accessor-init",
    finding: "RWF-142",
    mechanism:
      "a TC39 `accessor` decorator returns `{ init }`, which runs on the field's value at construction",
    program: (hook) =>
      `function dec(_v: any, _c: any): any { return { init(v: any) { lib.${hook}(1); return v; } }; }\nclass C { @dec accessor y: any = 1; }\nnew C();\n`,
    mode: "tc39",
    target: "es2022",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.tc39-accessor-set",
    finding: "RWF-142",
    mechanism:
      "a TC39 `accessor` decorator returns `{ set }`, which becomes the accessor's setter; a store runs it",
    program: (hook) =>
      `function dec(_v: any, _c: any): any { return { set(_v: any) { lib.${hook}(1); } }; }\nclass C { @dec accessor y: any = 1; }\nconst c: any = new C();\nc.y = 2;\n`,
    mode: "tc39",
    target: "es2022",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.tc39-class-decorator-replaces-the-class",
    finding: "RWF-142",
    mechanism:
      "a TC39 class decorator returns another class, which `new C()` constructs",
    program: (hook) =>
      `function dec(_v: any, _c: any): any { return class { constructor() { lib.${hook}(1); } }; }\n@dec class C {}\nnew C();\n`,
    mode: "tc39",
    target: "es2022",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // A class decorator's result replaces the class: `new C()` constructs
  // the result, not the class the source declares.
  {
    id: "rwf142.legacy-replaced-class-constructor-not-run",
    finding: "RWF-142",
    mechanism:
      "a legacy class decorator returns another class: `new C()` never runs the declared constructor, which calls `lib.parse`",
    program: (hook) =>
      `function dec(_c: any): any { return class {}; }\n@dec class C { constructor() { lib.${hook}(1); } }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.tc39-replaced-class-constructor-not-run",
    finding: "RWF-142",
    mechanism:
      "a TC39 class decorator returns another class: `new C()` never runs the declared constructor, which calls `lib.parse`",
    program: (hook) =>
      `function dec(_v: any, _c: any): any { return class {}; }\n@dec class C { constructor() { lib.${hook}(1); } }\nnew C();\n`,
    mode: "tc39",
    target: "es2022",
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.implicit-super-into-a-replaced-base",
    finding: "RWF-142",
    mechanism:
      "a derived class with no constructor constructs its base through `super(...args)`: the decorator's result, not the declared base",
    program: (hook) =>
      `function dec(_c: any): any { return class { constructor() { lib.${hook}(1); } }; }\n@dec class B {}\nclass D extends B {}\nnew D();\n`,
    mode: "legacy",
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "masked.explicit-super-into-a-replaced-base",
    finding: "RWF-142",
    mechanism:
      "an explicit `super()` constructs the decorator's result, not the declared base",
    program: (hook) =>
      `function dec(_c: any): any { return class { constructor() { lib.${hook}(1); } }; }\n@dec class B {}\nclass D extends B { constructor() { super(); } }\nnew D();\n`,
    mode: "legacy",
    target: "es2020",
    controlsInapplicable:
      "an explicit `super()` is an unknown edge (`unsupported_construct`) in the negative control too",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.reflect-construct-of-a-replaced-class",
    finding: "RWF-142",
    mechanism:
      "`Reflect.construct(C, [])` constructs the decorator's result: the declared constructor, which calls `lib.parse`, never runs",
    program: (hook) =>
      `function dec(_c: any): any { return class {}; }\n@dec class C { constructor() { lib.${hook}(1); } }\nReflect.construct(C, []);\n`,
    mode: "legacy",
    target: "es2020",
    controlsInapplicable:
      "a decorated class handed to a builtin may carry its own members (task BL-081, `mayCarryOwnMembers`): an unknown edge, so the negative control is UNKNOWN too",
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf142.replaced-class-constructed-from-another-module",
    finding: "RWF-142",
    mechanism:
      "the decorated class is exported and constructed by another module: `new C()` constructs the decorator's result",
    modules: (hook) => ({
      decs: `function dec(_c: any): any { return class {}; }\n@dec export class C { constructor() { lib.${hook}(1); } }\n`,
    }),
    program: () => `import { C } from "./decs";\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "masked.re-exported-decorator",
    finding: "RWF-142",
    mechanism:
      "the decorator is imported through a re-export (`export { dec } from`), and returns the setter descriptor",
    modules: (hook) => ({
      decs: `export { dec } from "./decs2";\n`,
      decs2: `export ${legacySetterDec(hook)}`,
    }),
    program: () =>
      `import { dec } from "./decs";\nclass C { @dec x: any = 1; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    controlsInapplicable:
      "the decorator reached through a re-export is an unknown callee (`loaded_module_not_evaluated`) in the negative control too",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "audit.shadowed-undefined-is-a-value",
    finding: "RWF-149",
    mechanism:
      "the independent audit's finding 3: `const undefined = class {…}; return undefined;` returns the class, not `undefined`",
    program: (hook) =>
      `function dec(_c: any): any { const undefined = class { constructor() { lib.${hook}(1); } }; return undefined; }\n@dec class C { constructor() { lib.safe(1); } }\nnew C();\n`,
    mode: "legacy",
    target: "es2022",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "control.class-decorator-returns-nothing",
    finding: "RWF-142",
    mechanism:
      "a class decorator with no `return` keeps the class: `new C()` runs its constructor, which calls `lib.parse`",
    program: (hook) =>
      `function dec(_c: any): void {}\n@dec class C { constructor() { lib.${hook}(1); } }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  },
  // Already UNKNOWN on the base through another account.
  {
    id: "masked.decorator-factory",
    finding: "RWF-142",
    mechanism:
      "`@make()`: the decorator is a call's result, which the site already calls through an unknown edge (task A-1)",
    program: (hook) =>
      `function make(): any { return (_t: any, _k: string): any => ({ set(_v: any) { lib.${hook}(1); }, configurable: true }); }\nclass C { @make() x: any = 1; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    controlsInapplicable:
      "the decorator is a call's result: the site's own unknown edge (task A-1), so the negative control is UNKNOWN too",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "masked.tc39-add-initializer",
    finding: "RWF-142",
    mechanism:
      "`context.addInitializer(f)`: a call through the decorator's parameter, an unknown callee whose escaped argument gets a possible edge",
    program: (hook) =>
      `function dec(_v: any, c: any): void { c.addInitializer(function () { lib.${hook}(1); }); }\nclass C { @dec m(): void {} }\nnew C();\n`,
    mode: "tc39",
    target: "es2022",
    controlsInapplicable:
      "`c.addInitializer` is a call through a parameter, an unknown edge, so the negative control is UNKNOWN too",
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Precision kept.
  {
    id: "control.legacy-decorator-returns-nothing",
    finding: "RWF-142",
    mechanism:
      "a legacy field decorator with no `return`: `__decorate` installs nothing, and the stored `lib.parse` is never called",
    program: (hook) =>
      `function dec(_t: any, _k: string): void {}\nclass C { @dec x: any = lib.${hook}; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.tc39-decorator-returns-nothing",
    finding: "RWF-142",
    mechanism:
      "a TC39 field decorator with no `return`: no initializer, and the stored `lib.parse` is never called",
    program: (hook) =>
      `function dec(_v: any, _c: any): void {}\nclass C { @dec x: any = lib.${hook}; }\nnew C();\n`,
    mode: "tc39",
    target: "es2022",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.returned-setter-calls-nothing",
    finding: "RWF-142",
    mechanism:
      "the returned setter ignores its value: it runs, and calls nothing",
    program: (hook) =>
      `function dec(_t: any, _k: string): any { return { set(_v: any) {}, configurable: true }; }\nclass C { @dec x: any = lib.${hook}; }\nnew C();\n`,
    mode: "legacy",
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.legacy-parameter-decorator-result-discarded",
    finding: "RWF-142",
    mechanism:
      "a legacy parameter decorator's result is discarded by `__param`: the returned setter is never installed",
    program: (hook) =>
      `function pdec(_t: any, _k: any, _i: number): any { return { set(_v: any) { lib.${hook}(1); } }; }\nclass C { x: any = 1; constructor(@pdec _a: any) {} }\nnew C(1);\n`,
    mode: "legacy",
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // Precision given up: the decorator mode and the target are not read.
  {
    id: "cost.legacy-method-decorator-returns-a-function",
    finding: "RWF-142",
    mechanism:
      "under legacy decorators a returned FUNCTION is taken as a descriptor (it has no `get` / `set` / `value`), so the method becomes `undefined` and nothing runs; under TC39 decorators it would be the method",
    program: (hook) =>
      `function dec(_t: any, _k: string, _d?: any): any { return function () { lib.${hook}(1); }; }\nclass C { @dec m(): void {} }\nconst c: any = new C();\nc.m;\n`,
    mode: "legacy",
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];
