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
 * Task BL-095 (docs/tasks/BL-095-typescript-emit-stores.md; ADR 0008's
 * decision record "BL-081"): the stores TypeScript's emit makes that the
 * source shows as declarations, against real Node.
 *
 * Each program is a TypeScript module, `src/impl.ts`, that the entrypoint
 * `src/index.ts` loads (`import "./impl"`) before it runs the case's
 * trigger (`util.inspect(…)`, `Buffer.isBuffer(1)`). Both are compiled by
 * the repository's own TypeScript at the case's target, as task BL-091's
 * `typeScriptOracleCase`; the module is not the entrypoint because a
 * namespace's exports in an entrypoint are masked (`UNKNOWN` through
 * `entrypoint_root_incomplete`, as FINDINGS RWF-131 records), and the
 * trigger is not in the module because a module-scope name spelled like
 * the global it replaces (`Buffer`) leaves the trigger's receiver
 * unresolved. The controls are task A-1's: the positive control's
 * entrypoint calls `lib.parse("x")` first; the negative control is the
 * case with the stored function calling `lib.safe` instead of `lib.parse`.
 * The loud fixture `vuln-lib` exports both.
 *
 * - RWF-131: a namespace's exported member compiles to a store onto the
 *   namespace's object (`namespace D { export const k = v }` → `D.k = v`),
 *   and every use of an exported variable in its body to a member access
 *   (`k = v` → `D.k = v`, `k.m = v` → `D.k.m = v`). When the object is a
 *   class whose static chain is not the program's own, a decorator's
 *   result, or an object whose [[Prototype]] a `__proto__` store changed,
 *   the store runs a setter the program does not own.
 * - RWF-132: below target ES2022 (`useDefineForClassFields: false`) a
 *   field or parameter property named `__proto__` compiles to an
 *   assignment, which changes the object's [[Prototype]].
 *
 * `base` is the analyzer's verdict on BL-095's base `09d9b61` (BL-092's
 * merge), measured. `rwf131.*` and `rwf132.*` with `base: "NOT_AFFECTED"`
 * and `called: true` are the live false `NOT_AFFECTED`s this task closes;
 * `control.*` keep their precision; `cost.*` is precision given up.
 */
export interface Bl095Case {
  readonly id: string;
  readonly finding: string;
  readonly mechanism: string;
  /** `src/impl.ts` after `import lib = require("vuln-lib");`; `hook` names the export the stored function calls. */
  readonly program: (hook: "parse" | "safe") => string;
  /** `src/index.ts` after `import "./impl";`: the call that runs what the module stored. */
  readonly trigger: string;
  /** The compile target: `es2020` emits a class field as an assignment, `es2022` defines it. */
  readonly target: "es2020" | "es2022";
  /**
   * Why no negative control can be `NOT_AFFECTED` once the case is sound:
   * the controls are then declared inapplicable with this reason (task
   * H-0's `ControlsDeclaration`), and the precision this costs is measured
   * by the `control.*` cases instead.
   */
  readonly controlsInapplicable?: string;
  /** Compile with TypeScript's legacy decorators (`experimentalDecorators`). */
  readonly legacyDecorators?: true;
  readonly called: boolean;
  readonly base: CaseVerdict;
  readonly expected: CaseVerdict;
}

const ADVISORY_ID = "GHSA-bl095-typescript-emit";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

function project(
  kase: Bl095Case,
  hook: "parse" | "safe",
  direct: boolean,
): ProjectSpec {
  const impl = `import lib = require("vuln-lib");\n${kase.program(hook)}export {};\n`;
  const index =
    (direct ? `import lib = require("vuln-lib");\nlib.parse("x");\n` : "") +
    `import "./impl";\n${kase.trigger}export {};\n`;
  const options: ts.CompilerOptions = {
    target:
      kase.target === "es2020"
        ? ts.ScriptTarget.ES2020
        : ts.ScriptTarget.ES2022,
    experimentalDecorators: kase.legacyDecorators === true,
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
          experimentalDecorators: kase.legacyDecorators === true,
        },
      }),
      "src/index.ts": index,
      "src/impl.ts": impl,
      "dist/index.js": compileTypeScript(index, "index.ts", options),
      "dist/impl.js": compileTypeScript(impl, "impl.ts", options),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.ts"] }),
    },
  };
}

export function bl095OracleCase(kase: Bl095Case): OracleCase {
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

const UTIL = `import util = require("util");\n`;
const INSPECT = `import util = require("util");\nutil.inspect({ b: 1, a: 2 });\n`;
const BUFFER_CALL = `Buffer.isBuffer(1);\n`;
const TIMEOUT_CALL = `setTimeout(function () {}, 0);\n`;

const GLOBAL_DECORATOR = `function dec(_: any): any { return globalThis; }\n`;

/**
 * An array pattern takes its elements from an iterator, which may yield any
 * value: the store gets an unknown edge whatever it holds (task BL-081).
 */
const ITERATOR_STORE =
  "an array pattern's store gets an unknown edge whatever it holds (task BL-081: the iterator may yield any value), so the negative control is UNKNOWN too";
/**
 * The field or enum member that changes the [[Prototype]] stores a builtin object -- the
 * only routes to one are a builtin's name and a load, both opaque -- onto
 * an object that is then not proven the program's own: an escape with an
 * unknown edge, as the explicit `this.__proto__ = globalThis` already is
 * (task BL-081's seventh audit round).
 */
const PROTOTYPE_STORE =
  "the field or enum member that changes the [[Prototype]] stores a builtin object onto an object then not proven the program's own: an escape with an unknown edge, as the explicit `this.__proto__ = globalThis` is (BL-081's seventh audit round), so no negative control can be NOT_AFFECTED; precision is measured by the control.* cases";

/**
 * The explicit store that puts a builtin object into the namespace's
 * member (`(D as any).N = globalThis`) writes onto a class or function
 * merged with a namespace, which is not proven the program's own (the
 * audit's round 3, finding 1): an escape with an unknown edge.
 */
const MERGED_PARTNER_STORE =
  "the store that puts a builtin object into the namespace's member writes it onto a class or function merged with a namespace, never proven the program's own (BL-095's audit, round 3): an escape with an unknown edge, so no negative control can be NOT_AFFECTED; precision is measured by the control.* cases";

/**
 * A namespace's or enum's member handed over by a name the resolver binds
 * to an outer declaration is opaque (the audit's round 5, finding 3): an
 * unknown edge, whatever the member holds.
 */
const OPAQUE_MEMBER =
  "the member handed over is named like an outer declaration, so it is opaque (BL-095's audit, round 5): an unknown edge whatever it holds, so no negative control can be NOT_AFFECTED";

/**
 * Since task BL-099 (RWF-141), a call in a namespace's body through a name
 * the body does not declare -- the namespace's exported variable (`h(1)`,
 * which compiles to `N.h(1)`), or an outer name such as `lib` in
 * `lib.safe(x)`, which may be a member the namespace's merged symbol adds
 * -- is an unknown callee, in the negative control too. Before it, the
 * call resolved to the variable's initializer or the outer binding.
 */
const NAMESPACE_MEMBER_READ =
  "a call in the namespace's body through a name the body does not declare (its exported variable, or an outer name such as `lib`) is an unknown callee since task BL-099 (RWF-141): no name is looked up past a namespace, so no negative control can be NOT_AFFECTED";

/**
 * Since task BL-100 (RWF-142), what a decorator returns is handed to
 * TypeScript's decorator helpers at a non-admitted position: a builtin's
 * own function returned (`util.inspect`) is opaque, an unknown edge from
 * the owner that evaluates the class, in the negative control too.
 */
const DECORATOR_RESULT =
  "the decorator returns a builtin's own function, which TypeScript's decorator helpers are handed at a non-admitted position since task BL-100 (RWF-142): an unknown edge, so no negative control can be NOT_AFFECTED";

const sorted = (hook: string) =>
  `{ sorted: function (a: any, b: any) { lib.${hook}(a); return 0; } }`;
const isBuffer = (hook: string) =>
  `{ isBuffer: function (x: any) { lib.${hook}(x); return false; } }`;
const sortedFn = (hook: string) =>
  `function (a: any, b: any) { lib.${hook}(a); return 0; }`;

export const BL095_CASES: readonly Bl095Case[] = [
  // RWF-131: a namespace merged with a class derived from `util.inspect`.
  {
    id: "rwf131.namespace-destructured-export",
    finding: "RWF-131",
    mechanism:
      "`class D extends util.inspect {} namespace D { export const { defaultOptions } = { defaultOptions: … } }`: `D.defaultOptions = …` runs the inherited setter",
    program: (hook) =>
      `${UTIL}class D extends (util.inspect as any) {}\nnamespace D { export const { defaultOptions } = { defaultOptions: ${sorted(hook)} }; }\n`,
    trigger: INSPECT,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.namespace-exported-const",
    finding: "RWF-131",
    mechanism: "`namespace D { export const defaultOptions = … }`",
    program: (hook) =>
      `${UTIL}class D extends (util.inspect as any) {}\nnamespace D { export const defaultOptions = ${sorted(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.namespace-array-destructured-export",
    finding: "RWF-131",
    mechanism: "`namespace D { export const [defaultOptions] = [ … ] }`",
    program: (hook) =>
      `${UTIL}class D extends (util.inspect as any) {}\nnamespace D { export const [defaultOptions] = [${sorted(hook)}]; }\n`,
    trigger: INSPECT,
    controlsInapplicable: ITERATOR_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.namespace-exported-let-assigned-in-the-body",
    finding: "RWF-131",
    mechanism:
      "`namespace D { export let defaultOptions: any; defaultOptions = … }`: the assignment compiles to `D.defaultOptions = …`",
    program: (hook) =>
      `${UTIL}class D extends (util.inspect as any) {}\nnamespace D { export let defaultOptions: any; defaultOptions = ${sorted(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.namespace-exported-let-assigned-in-another-block",
    finding: "RWF-131",
    mechanism:
      "`namespace D { export let defaultOptions: any; } namespace D { defaultOptions = … }`: another block of the merged namespace",
    program: (hook) =>
      `${UTIL}class D extends (util.inspect as any) {}\nnamespace D { export let defaultOptions: any; }\nnamespace D { defaultOptions = ${sorted(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.namespace-exported-let-member-store",
    finding: "RWF-131",
    mechanism:
      "`namespace D { export let defaultOptions: any = { sorted: g }; defaultOptions.sorted = f }`: compiles to `D.defaultOptions.sorted = f`, whose base is the inherited getter's result -- Node's own defaults object (the initializer's store hands over only `g`, which calls `safe`)",
    program: (hook) =>
      `${UTIL}class D extends (util.inspect as any) {}\nnamespace D { export let defaultOptions: any = ${sorted("safe")}; defaultOptions.sorted = ${sortedFn(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.nested-namespace-member",
    finding: "RWF-131",
    mechanism:
      "`namespace D { export namespace defaultOptions { export const sorted = f } }`: compiles to `N = D.defaultOptions || …; N.sorted = f`, a store onto Node's own defaults object",
    program: (hook) =>
      `${UTIL}class D extends (util.inspect as any) {}\nnamespace D { export namespace defaultOptions { export const sorted = ${sortedFn(hook)}; } }\n`,
    trigger: INSPECT,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.namespace-merged-with-a-decorated-class",
    finding: "RWF-131",
    mechanism:
      "`@dec class D {} namespace D { export const defaultOptions = … }` with `dec` returning `util.inspect`: the namespace's object is the decorator's result",
    program: (hook) =>
      `${UTIL}const dec = (_: any, _c: any) => util.inspect as any;\n@dec class D {}\nnamespace D { export const defaultOptions = ${sorted(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // With TypeScript's legacy decorators (`experimentalDecorators`) a class
  // decorator's result replaces the class whatever it is: here the global
  // object, so the namespace's stores replace globals. The stored function
  // or class is the replacement itself (it carries no own members, which
  // BL-081 gives an unknown edge of their own): a later `setTimeout(…)` or
  // `new Promise(…)` calls it.
  {
    id: "rwf131.exported-function-onto-a-legacy-decorated-class",
    finding: "RWF-131",
    mechanism:
      "`@dec class D {} namespace D { export function setTimeout(cb) { … } }` with a legacy decorator returning `globalThis`: `D.setTimeout = setTimeout` replaces the global",
    program: (hook) =>
      `${GLOBAL_DECORATOR}@dec class D {}\nnamespace D { export function setTimeout(cb: any, _ms?: any) { lib.${hook}(cb); } }\n`,
    trigger: TIMEOUT_CALL,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    legacyDecorators: true,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.exported-class-onto-a-legacy-decorated-class",
    finding: "RWF-131",
    mechanism:
      "`namespace D { export class Promise { constructor(x) { … } } }`: `D.Promise = Promise`, then `new Promise(…)`",
    program: (hook) =>
      `${GLOBAL_DECORATOR}@dec class D {}\nnamespace D { export class Promise { constructor(x: any) { lib.${hook}(x); } } }\n`,
    trigger: `new Promise(function () {});\n`,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    legacyDecorators: true,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.export-import-alias-onto-a-legacy-decorated-class",
    finding: "RWF-131",
    mechanism:
      "`namespace D { export import setTimeout = B; }`: compiles to `D.setTimeout = B`",
    program: (hook) =>
      `${GLOBAL_DECORATOR}const B = function (cb: any, _ms?: any) { lib.${hook}(cb); };\n@dec class D {}\nnamespace D { export import setTimeout = B; }\n`,
    trigger: TIMEOUT_CALL,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    legacyDecorators: true,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf131.exported-const-onto-a-legacy-decorated-class",
    finding: "RWF-131",
    mechanism: "`namespace D { export const Buffer = … }`",
    program: (hook) =>
      `${GLOBAL_DECORATOR}@dec class D {}\nnamespace D { export const Buffer = ${isBuffer(hook)}; }\n`,
    trigger: BUFFER_CALL,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    legacyDecorators: true,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Another block of a namespace the program owns: `h = …` there compiles
  // to `N.h = …`, the same store as written out, which changes what `h`
  // holds in the first block.
  {
    id: "rwf131.exported-variable-written-from-another-block",
    finding: "RWF-131",
    mechanism:
      "`namespace N { export let h: any = function () {}; setTimeout(() => h(1)); } namespace N { h = lib.parse; }`",
    program: (hook) =>
      `namespace N { export let h: any = function (x: any) { return x; }; setTimeout(function () { h(1); }, 0); }\nnamespace N { h = lib.${hook}; }\n`,
    trigger: "",
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Already `UNKNOWN` through another account: no freshness proof accepts
  // a namespace's name, so a store written onto a namespace's object is an
  // escape of its own. (`N.o = globalThis` with `o.Buffer = …` inside the
  // namespace is the same, and its negative control is `UNKNOWN` too: not
  // a case.) A namespace merged with a class or function was not covered
  // on the base: `audit3.*` below.
  {
    id: "masked.exported-variable-written-from-outside",
    finding: "RWF-131",
    mechanism:
      "`namespace N { export let h: any = function () {}; setTimeout(() => h(1)); } N.h = lib.parse`: `h(1)` compiles to `N.h(1)`; the outer store is an escape",
    program: (hook) =>
      `namespace N { export let h: any = function (x: any) { return x; }; setTimeout(function () { h(1); }, 0); }\nN.h = lib.${hook};\n`,
    trigger: "",
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // Controls: the namespace's object is the program's own.
  {
    id: "control.namespace-merged-with-a-base-class",
    finding: "RWF-131",
    mechanism:
      "`class D {} namespace D { export const defaultOptions = … }`: a base class inherits from `Function.prototype`",
    program: (hook) =>
      `${UTIL}class D {}\nnamespace D { export const defaultOptions = ${sorted(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.namespace-merged-with-a-class-derived-from-the-programs-own",
    finding: "RWF-131",
    mechanism: "`class B {} class D extends B {} namespace D { export … }`",
    program: (hook) =>
      `${UTIL}class B {}\nclass D extends B {}\nnamespace D { export const defaultOptions = ${sorted(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.standalone-namespace",
    finding: "RWF-131",
    mechanism:
      "`namespace N { export const Buffer = … }`: the namespace's object is a fresh `{}`",
    program: (hook) =>
      `namespace N { export const Buffer = ${isBuffer(hook)}; }\n`,
    trigger: BUFFER_CALL,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.namespace-member-not-exported",
    finding: "RWF-131",
    mechanism:
      "`class D extends util.inspect {} namespace D { const defaultOptions = … }`: a member that is not exported stays local",
    program: (hook) =>
      `${UTIL}class D extends (util.inspect as any) {}\nnamespace D { const defaultOptions = ${sorted(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // The task's independent audit, round 1 (its findings 1 to 6): live
  // false NOT_AFFECTEDs in the same rules, each also on the base.
  {
    id: "audit.nested-namespace-named-constructor",
    finding: "RWF-131",
    mechanism:
      "`namespace N { export namespace constructor { export function keys … } }`: `constructor = N.constructor || …` reads the inherited `Object`, and `constructor.keys = keys` replaces `Object.keys`",
    program: (hook) =>
      `namespace N { export namespace constructor { export function keys(o: any) { lib.${hook}(o); return []; } } }\n`,
    trigger: `Object.keys({});\n`,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.dotted-namespace-named-constructor",
    finding: "RWF-131",
    mechanism: "`namespace N.constructor { export function keys … }`",
    program: (hook) =>
      `namespace N.constructor { export function keys(o: any) { lib.${hook}(o); return []; } }\n`,
    trigger: `Object.keys({});\n`,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.nested-namespace-parent-member-stored",
    finding: "RWF-131",
    mechanism:
      "`class D {} (D as any).N = globalThis; namespace D { export namespace N { export const Buffer = … } }`",
    program: (hook) =>
      `class D {}\n(D as any).N = globalThis;\nnamespace D { export namespace N { export const Buffer = ${isBuffer(hook)}; } }\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: MERGED_PARTNER_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.nested-namespace-parent-static-field",
    finding: "RWF-131",
    mechanism:
      "`class D { static N: any = globalThis; } namespace D { export namespace N { … } }`",
    program: (hook) =>
      `class D { static N: any = globalThis; }\nnamespace D { export namespace N { export const Buffer = ${isBuffer(hook)}; } }\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: MERGED_PARTNER_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.dotted-namespace-parent-function-member",
    finding: "RWF-131",
    mechanism:
      "`function D() {} (D as any).N = globalThis; namespace D.N { export const Buffer = … }`",
    program: (hook) =>
      `function D() {}\n(D as any).N = globalThis;\nnamespace D.N { export const Buffer = ${isBuffer(hook)}; }\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: MERGED_PARTNER_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.own-class-member-stored-in-the-body",
    finding: "RWF-131",
    mechanism:
      "`class N {} namespace N { export let o: any = {}; (N as any).o = globalThis; o.Buffer = … }`: `N.o.Buffer = …` lands on the global object",
    program: (hook) =>
      `class N {}\nnamespace N { export let o: any = {}; (N as any).o = globalThis; o.Buffer = ${isBuffer(hook)}; }\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: MERGED_PARTNER_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.own-function-member-stored-in-the-body",
    finding: "RWF-131",
    mechanism: "the same with `function N() {}`",
    program: (hook) =>
      `function N() {}\nnamespace N { export let o: any = {}; (N as any).o = globalThis; o.Buffer = ${isBuffer(hook)}; }\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: MERGED_PARTNER_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.own-static-accessor-answers-the-member",
    finding: "RWF-131",
    mechanism:
      "`class B { static get o() { return globalThis } … } class N extends B {} namespace N { export let o: any = {}; o.Buffer = … }`",
    program: (hook) =>
      `class B { static get o(): any { return globalThis; } static set o(_v: any) {} }\nclass N extends B {}\nnamespace N { export let o: any = {}; o.Buffer = ${isBuffer(hook)}; }\n`,
    trigger: BUFFER_CALL,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.enum-member-named-proto",
    finding: "RWF-131",
    mechanism:
      "`enum E { __proto__ = <any>globalThis } namespace E { export const Buffer = … }`: the enum's emit stores under `__proto__`",
    program: (hook) =>
      `enum E { __proto__ = <any>globalThis }\nnamespace E { export const Buffer = ${isBuffer(hook)}; }\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",

    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.export-declare-assigned-in-the-body",
    finding: "RWF-131",
    mechanism:
      "`namespace D { export declare let defaultOptions: any; defaultOptions = … }`: rewritten to `D.defaultOptions = …`",
    program: (hook) =>
      `${UTIL}class D extends (util.inspect as any) {}\nnamespace D { export declare let defaultOptions: any; defaultOptions = ${sorted(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.tc39-decorated-class-static-field",
    finding: "RWF-132",
    mechanism:
      "`@dec class C { static defaultOptions: any = … }` with a TC39 decorator returning `util.inspect`, at target ES2020: `_classThis.defaultOptions = …`",
    program: (hook) =>
      `${UTIL}const dec = (_c: any, _ctx: any): any => util.inspect;\n@dec class C { static defaultOptions: any = ${sorted(hook)}; }\n`,
    trigger: INSPECT,
    target: "es2020",
    controlsInapplicable: DECORATOR_RESULT,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The task's independent audit, round 2 (its findings 1 to 4): live
  // false NOT_AFFECTEDs in the same rules, each also on the base.
  {
    id: "audit2.write-from-another-block-shadowing-an-outer-declaration",
    finding: "RWF-131",
    mechanism:
      "`let h = …; namespace N { export let h = …; setTimeout(() => h(1)); } namespace N { h = lib.parse; }`: the second block's `h` is `N.h`, not the outer `h`",
    program: (hook) =>
      `let h: any = function (x: any) { return x; };\nnamespace N { export let h: any = function (x: any) { return x; }; setTimeout(function () { h(1); }, 0); }\nnamespace N { h = lib.${hook}; }\n`,
    trigger: "",
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit2.nested-namespace-split-across-parent-blocks",
    finding: "RWF-131",
    mechanism:
      "`namespace N { export namespace constructor { export let keys: any; } } namespace N { export namespace constructor { keys = … } }`: one namespace across two parent blocks",
    program: (hook) =>
      `namespace N { export namespace constructor { export let keys: any; } }\nnamespace N { export namespace constructor { keys = function (o: any) { lib.${hook}(o); return []; }; } }\n`,
    trigger: `Object.keys({});\n`,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit2.dotted-namespace-split-blocks",
    finding: "RWF-131",
    mechanism:
      "`namespace A.B { export let h = …; setTimeout(() => h(1)); } namespace A.B { h = lib.parse; }`",
    program: (hook) =>
      `namespace A.B { export let h: any = function (x: any) { return x; }; setTimeout(function () { h(1); }, 0); }\nnamespace A.B { h = lib.${hook}; }\n`,
    trigger: "",
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit2.namespace-merged-with-a-bodiless-overload",
    finding: "RWF-131",
    mechanism:
      "`function Buffer(): void; namespace Buffer { export function isBuffer … }`: an overload alone emits no binding, so the emit writes onto the global `Buffer`",
    program: (hook) =>
      `function Buffer(): void;\nnamespace Buffer { export function isBuffer(x: any) { lib.${hook}(x); return false; } }\n`,
    trigger: BUFFER_CALL,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit2.exported-enum-read-from-its-parent",
    finding: "RWF-131",
    mechanism:
      "`namespace N { export enum constructor { keys = <any>(function …) } }`: `constructor = N.constructor || …` is `Object`, and the enum stores `keys` onto it",
    program: (hook) =>
      `namespace N { export enum constructor { keys = <any>(function (o: any) { lib.${hook}(o); return []; }) } }\n`,
    trigger: `Object.keys({});\n`,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit2.enum-member-named-proto-then-a-member",
    finding: "RWF-131",
    mechanism:
      "`enum E { __proto__ = <any>util.inspect, defaultOptions = <any>{ sorted: f } }`: the second member runs the setter the first made `E` inherit",
    program: (hook) =>
      `${UTIL}enum E { __proto__ = <any>util.inspect, defaultOptions = <any>${sorted(hook)} }\n`,
    trigger: INSPECT,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The task's independent audit, round 3 (its finding 1, the escape-row
  // half): a store onto a class or function merged with a namespace.
  {
    id: "audit3.store-onto-a-class-merged-with-a-namespace",
    finding: "RWF-131",
    mechanism:
      "`class N {} namespace N { export let h = function () {}; N.h = lib.parse; h(1); }`: the emit reads `N.h`, which the store replaced",
    program: (hook) =>
      `class N {}\nnamespace N { export let h: any = function (x: any) { return x; }; N.h = lib.${hook}; h(1); }\n`,
    trigger: "",
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit3.store-onto-a-function-merged-with-a-namespace-through-an-alias",
    finding: "RWF-131",
    mechanism:
      "`function N() {} namespace N { … } const M: any = N; M.h = lib.parse;` with `setTimeout(() => h(1))` inside",
    program: (hook) =>
      `function N() {}\nnamespace N { export let h: any = function (x: any) { return x; }; setTimeout(function () { h(1); }, 0); }\nconst M: any = N;\nM.h = lib.${hook};\n`,
    trigger: "",
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The task's independent audit, round 4 (its findings 1 and 2).
  {
    id: "audit4.namespace-named-module",
    finding: "RWF-131",
    mechanism:
      "`namespace module { export function require(id) { … } }`: `var module;` keeps the CommonJS wrapper's `module`, whose `require` the emit replaces",
    program: (hook) =>
      `namespace module { export function require(id: any) { lib.${hook}(id); return {}; } }\nimport fs = require("fs");\nfs;\n`,
    trigger: "",
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit4.enum-named-module",
    finding: "RWF-131",
    mechanism: "`enum module { require = <any>function (id) { … } }`",
    program: (hook) =>
      `enum module { require = <any>function (id: any) { lib.${hook}(id); return {}; } }\nimport fs = require("fs");\nfs;\n`,
    trigger: "",
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit4.static-block-this-of-a-class-merged-with-a-namespace",
    finding: "RWF-131",
    mechanism:
      "`class N { static { setTimeout(() => { this.h = lib.parse; }) } } namespace N { export let h = f; setTimeout(() => h(1)); }`",
    program: (hook) =>
      `class N { static { setTimeout(() => { (this as any).h = lib.${hook}; }, 0); } }\nnamespace N { export let h: any = function (x: any) { return x; }; setTimeout(function () { h(1); }, 0); }\n`,
    trigger: "",
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit4.static-field-this-of-a-class-merged-with-a-namespace",
    finding: "RWF-131",
    mechanism:
      "the same through `static t = void setTimeout(() => { this.h = lib.parse; })`",
    program: (hook) =>
      `class N { static t = void setTimeout(() => { (this as any).h = lib.${hook}; }, 0); }\nnamespace N { export let h: any = function (x: any) { return x; }; setTimeout(function () { h(1); }, 0); }\n`,
    trigger: "",
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // The task's independent audit, round 5 (its findings 1 to 3).
  {
    id: "audit5.alias-of-an-exported-variable",
    finding: "RWF-131",
    mechanism:
      "`class D { static get o() { return globalThis; } … } namespace D { export const o = {}; const a = o; a.Buffer = … }`: `a` holds `D.o`, which the own getter answers",
    program: (hook) =>
      `class D { static get o(): any { return globalThis; } static set o(_v: any) {} }\nnamespace D { export const o: any = {}; const a = o; a.Buffer = ${isBuffer(hook)}; }\n`,
    trigger: BUFFER_CALL,
    target: "es2020",
    controlsInapplicable: NAMESPACE_MEMBER_READ,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit5.enum-member-read-in-an-initializer",
    finding: "RWF-131",
    mechanism:
      "`const A = {}; enum E { A = <any>globalThis, B = <any>((A as any).Buffer = …, 0) }`: `A` in the initializer is `E.A`",
    program: (hook) =>
      `const A: any = {};\nenum E { A = <any>globalThis, B = <any>((A as any).Buffer = ${isBuffer(hook)}, 0) }\n`,
    trigger: BUFFER_CALL,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit5.namespace-member-handed-over-with-an-outer-same-name",
    finding: "RWF-131",
    mechanism:
      "`const k = …safe…; namespace N { export const k = …parse…; } namespace N { Buffer.isBuffer = k; }`: the second block's `k` is `N.k`",
    program: (hook) =>
      `const k = function (x: any) { lib.safe(x); return false; };\nnamespace N { export const k: any = function (x: any) { lib.${hook}(x); return false; }; }\nnamespace N { (Buffer as any).isBuffer = k; }\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: OPAQUE_MEMBER,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit5.enum-member-handed-over-with-an-outer-same-name",
    finding: "RWF-131",
    mechanism:
      "`const A = …safe…; enum E { A = <any>function …parse…, B = <any>((Buffer as any).isBuffer = A, 0) }`",
    program: (hook) =>
      `const A = function (x: any) { lib.safe(x); return false; };\nenum E { A = <any>function (x: any) { lib.${hook}(x); return false; }, B = <any>((Buffer as any).isBuffer = A, 0) }\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: OPAQUE_MEMBER,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // RWF-132: a field named `__proto__` under the legacy class-field emit.
  {
    id: "rwf132.instance-field",
    finding: "RWF-132",
    mechanism:
      "`class C { __proto__: any = globalThis; constructor() { this.Buffer = … } }`: `this.__proto__ = globalThis` at target ES2020",
    program: (hook) =>
      `class C { __proto__: any = globalThis; constructor() { (this as any).Buffer = ${isBuffer(hook)}; } }\nnew C();\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf132.string-key-instance-field",
    finding: "RWF-132",
    mechanism: '`class C { "__proto__": any = globalThis; … }`',
    program: (hook) =>
      `class C { "__proto__": any = globalThis; constructor() { (this as any).Buffer = ${isBuffer(hook)}; } }\nnew C();\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf132.computed-literal-key-instance-field",
    finding: "RWF-132",
    mechanism: '`class C { ["__proto__"]: any = globalThis; … }`',
    program: (hook) =>
      `class C { ["__proto__"]: any = globalThis; constructor() { (this as any).Buffer = ${isBuffer(hook)}; } }\nnew C();\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf132.computed-variable-key-instance-field",
    finding: "RWF-132",
    mechanism: '`const k = "__proto__"; class C { [k]: any = globalThis; … }`',
    program: (hook) =>
      `const k = "__proto__";\nclass C { [k]: any = globalThis; constructor() { (this as any).Buffer = ${isBuffer(hook)}; } }\nnew C();\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf132.parameter-property",
    finding: "RWF-132",
    mechanism:
      "`class C { constructor(public __proto__: any) { this.Buffer = … } } new C(globalThis)`",
    program: (hook) =>
      `class C { constructor(public __proto__: any) { (this as any).Buffer = ${isBuffer(hook)}; } }\nnew C(globalThis);\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf132.static-field",
    finding: "RWF-132",
    mechanism:
      "`class C { static __proto__: any = util.inspect; } C.defaultOptions = …`: `C.__proto__ = util.inspect`",
    program: (hook) =>
      `${UTIL}class C { static __proto__: any = util.inspect; }\n(C as any).defaultOptions = ${sorted(hook)};\n`,
    trigger: INSPECT,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf132.later-instance-field",
    finding: "RWF-132",
    mechanism:
      "`class C { __proto__: any = globalThis; Buffer: any = … }`: the second field compiles to `this.Buffer = …` onto the changed object",
    program: (hook) =>
      `class C { __proto__: any = globalThis; Buffer: any = ${isBuffer(hook)}; }\nnew C();\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf132.later-static-field",
    finding: "RWF-132",
    mechanism:
      "`class C { static __proto__: any = globalThis; static Buffer: any = … }`",
    program: (hook) =>
      `class C { static __proto__: any = globalThis; static Buffer: any = ${isBuffer(hook)}; }\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2020",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "control.field-named-otherwise",
    finding: "RWF-132",
    mechanism:
      "`class C { proto: any = globalThis; constructor() { this.Buffer = … } }`",
    program: (hook) =>
      `class C { proto: any = globalThis; constructor() { (this as any).Buffer = ${isBuffer(hook)}; } }\nnew C();\n`,
    trigger: BUFFER_CALL,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "control.later-instance-field-without-a-proto-field",
    finding: "RWF-132",
    mechanism:
      "`class C { Buffer: any = … }`: `this.Buffer = …` onto a fresh instance",
    program: (hook) =>
      `class C { Buffer: any = ${isBuffer(hook)}; }\nnew C();\n`,
    trigger: BUFFER_CALL,
    target: "es2020",
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "cost.instance-field-under-define-semantics",
    finding: "RWF-132",
    mechanism:
      "the first case at target ES2022: the field is defined as an own property, the [[Prototype]] is unchanged; the analyzer does not read the target",
    program: (hook) =>
      `class C { __proto__: any = globalThis; constructor() { (this as any).Buffer = ${isBuffer(hook)}; } }\nnew C();\n`,
    trigger: BUFFER_CALL,
    controlsInapplicable: PROTOTYPE_STORE,
    target: "es2022",
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
];
