import type { BuiltinArgKind } from "../../src/testing/oracle/builtin-probe.js";
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
 * The task A-0 cases (docs/tasks/A-0-adr0008-coverage-reproduction.md):
 * implicit invocations that ADR 0008's protocol-member rule does not name
 * -- `util.inspect.custom` (S1), getters read by builtins (S2), Proxy
 * traps that are not protocol methods (S3) -- plus the precision controls
 * lane A must keep (S4).
 *
 * One shared LOUD fixture: `vuln-lib` exports `parse` (the rule's target)
 * and `safe` (its inert sibling), both marked with the `hit()` convention,
 * and every case declares both as bound names, so a fabricated attribution
 * resolves loudly to a wrong target instead of degrading to UNKNOWN.
 *
 * Every case is written as a {@link Scenario}: a `setup` that defines the
 * hook, parameterized by the export the hook calls, and a `trigger` that
 * is the ONLY thing that can run the hook. The three project variants are
 * derived from it the same way for every case:
 *
 * - case: the hook calls `lib.parse`, and only the trigger can run it;
 * - negative control: identical, but the hook calls `lib.safe`, so the
 *   only difference from the case is which export the hook calls;
 * - positive control: the negative control plus one direct top-level
 *   `lib.parse("x")` call, proving the rule, target and entrypoint wiring
 *   of this exact project produce AFFECTED.
 *
 * The controls are measured on `main`. A lane-A task that changes how the
 * trigger is accounted for re-measures them with the case (for example,
 * a trigger builtin that is not admitted to the non-invoking allowlist
 * may make the negative control UNKNOWN, which is sound).
 */

export const ADVISORY_ID = "GHSA-a0-adr0008-coverage";
export const TARGET_MARKER = "parse";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

const PRELUDE = `const util = require("util");\nconst lib = require("vuln-lib");\n`;

function project(entrySource: string): ProjectSpec {
  return {
    files: {
      ...simplePackageFiles("app", "vuln-lib", "1.0.0"),
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/vuln-lib/index.js": LIB_SOURCE,
      "src/index.js": entrySource,
      "rules.yml": simpleRuleFile({
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.js"] }),
    },
  };
}

export type Group = "S1" | "S2" | "S3" | "S4";

export interface Scenario {
  /** Stable case id, e.g. `S1.console.log`. */
  readonly id: string;
  readonly group: Group;
  /** One line: the mechanism, as the report's evidence table names it. */
  readonly mechanism: string;
  /** Defines the hook; `fn` is the export the hook calls (`parse` or `safe`). */
  readonly setup: (fn: "parse" | "safe") => string;
  /** The only code that can run the hook. */
  readonly trigger: string;
  /**
   * The builtin call (or operator) the trigger performs, as an H-0
   * builtin-probe template (`__ARG__` for the object the hook is on).
   */
  readonly probeTemplate: string;
  /**
   * What the H-0 builtin probe must observe for `probeTemplate`: the
   * argument kind carrying this case's hook and the marker it must fire,
   * or `"none"` when no argument kind may run user code at all (S4).
   */
  readonly probeExpect:
    { readonly kind: BuiltinArgKind; readonly fires: string } | "none";
}

export function entrySource(
  scenario: Scenario,
  fn: "parse" | "safe",
  direct = false,
): string {
  return (
    PRELUDE +
    scenario.setup(fn) +
    scenario.trigger +
    (direct ? `lib.parse("x");\n` : "")
  );
}

export function oracleCase(scenario: Scenario): OracleCase {
  return {
    id: scenario.id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider: () =>
      syntheticProvider([
        { id: ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
      ]),
    groundTruthCommand: nodeEntryCommand("src/index.js"),
    controls: {
      kind: "controls",
      controls: {
        positive: {
          name: "positive-control",
          project: project(entrySource(scenario, "safe", true)),
        },
        negative: {
          name: "negative-control",
          project: project(entrySource(scenario, "safe")),
        },
      },
    },
    variant: { name: "case", project: project(entrySource(scenario, "parse")) },
  };
}

// ---------------------------------------------------------------------------
// S1 -- util.inspect.custom
// ---------------------------------------------------------------------------

const inspectCustomObject = (fn: string) =>
  `const obj = { [util.inspect.custom]() { return lib.${fn}("x"); } };\n`;

export const S1: readonly Scenario[] = [
  {
    id: "S1.console.log",
    group: "S1",
    mechanism: "util.inspect.custom via console.log(obj)",
    setup: inspectCustomObject,
    trigger: `console.log(obj);\n`,
    probeTemplate: "console.log(__ARG__)",
    probeExpect: { kind: "inspectCustom", fires: "inspectCustom" },
  },
  {
    id: "S1.util.inspect",
    group: "S1",
    mechanism: "util.inspect.custom via util.inspect(obj)",
    setup: inspectCustomObject,
    trigger: `const shown = util.inspect(obj);\n`,
    probeTemplate: "util.inspect(__ARG__)",
    probeExpect: { kind: "inspectCustom", fires: "inspectCustom" },
  },
  {
    id: "S1.util.format-o",
    group: "S1",
    mechanism: 'util.inspect.custom via util.format("%o", obj)',
    setup: inspectCustomObject,
    trigger: `const shown = util.format("%o", obj);\n`,
    probeTemplate: 'util.format("%o", __ARG__)',
    probeExpect: { kind: "inspectCustom", fires: "inspectCustom" },
  },
];

// ---------------------------------------------------------------------------
// S2 -- getters read by builtins
// ---------------------------------------------------------------------------

interface GetterForm {
  readonly key: string;
  readonly label: string;
  readonly define: (fn: string) => string;
}

const GETTER_FORMS: readonly GetterForm[] = [
  {
    key: "literal",
    label: "object-literal getter",
    define: (fn) => `const o = { get v() { return lib.${fn}("x"); } };\n`,
  },
  {
    key: "class-instance",
    label: "class instance getter",
    define: (fn) =>
      `class C { get v() { return lib.${fn}("x"); } }\nconst o = new C();\n`,
  },
  {
    key: "class-static",
    label: "class static getter",
    define: (fn) =>
      `class C { static get v() { return lib.${fn}("x"); } }\nconst o = C;\n`,
  },
  {
    key: "defineProperty",
    label: "Object.defineProperty getter (function expression)",
    define: (fn) =>
      `const o = {};\nObject.defineProperty(o, "v", { get: function () { return lib.${fn}("x"); } });\n`,
  },
  {
    // ADDED by task A-0 (a deviation, reported): the form above is
    // non-enumerable by default, so none of the four builtins reads it.
    // This variant is the one that exercises the mechanism the task named.
    key: "defineProperty-enumerable",
    label:
      "Object.defineProperty getter (function expression), enumerable: true",
    define: (fn) =>
      `const o = {};\nObject.defineProperty(o, "v", { enumerable: true, get: function () { return lib.${fn}("x"); } });\n`,
  },
];

interface GetterReader {
  readonly key: string;
  readonly label: string;
  readonly trigger: string;
  readonly probeTemplate: string;
}

const GETTER_READERS: readonly GetterReader[] = [
  {
    key: "JSON.stringify",
    label: "JSON.stringify(o)",
    trigger: `const text = JSON.stringify(o);\n`,
    probeTemplate: "JSON.stringify(__ARG__)",
  },
  {
    key: "Object.assign",
    label: "Object.assign({}, o)",
    trigger: `const copy = Object.assign({}, o);\n`,
    probeTemplate: "Object.assign({}, __ARG__)",
  },
  {
    key: "spread",
    label: "{...o}",
    trigger: `const copy = { ...o };\n`,
    probeTemplate: "({ ...__ARG__ })",
  },
  {
    key: "Object.entries",
    label: "Object.entries(o)",
    trigger: `const pairs = Object.entries(o);\n`,
    probeTemplate: "Object.entries(__ARG__)",
  },
];

export const S2: readonly Scenario[] = GETTER_FORMS.flatMap((form) =>
  GETTER_READERS.map((reader): Scenario => ({
    id: `S2.${form.key}.${reader.key}`,
    group: "S2",
    mechanism: `${form.label} read by ${reader.label}`,
    setup: form.define,
    trigger: reader.trigger,
    probeTemplate: reader.probeTemplate,
    probeExpect: { kind: "getter", fires: "getter" },
  })),
);

// ---------------------------------------------------------------------------
// S3 -- Proxy traps that are not protocol methods
// ---------------------------------------------------------------------------

const ownKeysProxy = (fn: string) =>
  `const p = new Proxy({ a: 1 }, { ownKeys(t) { lib.${fn}("x"); return Reflect.ownKeys(t); } });\n`;
const hasProxy = (fn: string) =>
  `const p = new Proxy({}, { has(t, k) { lib.${fn}("x"); return Reflect.has(t, k); } });\n`;
const getProxy = (fn: string) =>
  `const p = new Proxy({ a: 1 }, { get(t, k, r) { lib.${fn}("x"); return Reflect.get(t, k, r); } });\n`;

export const S3: readonly Scenario[] = [
  {
    id: "S3.Object.keys.ownKeys",
    group: "S3",
    mechanism: "Proxy ownKeys trap via Object.keys(p)",
    setup: ownKeysProxy,
    trigger: `const keys = Object.keys(p);\n`,
    probeTemplate: "Object.keys(__ARG__)",
    probeExpect: { kind: "proxyPlainObject", fires: "proxy:ownKeys" },
  },
  {
    id: "S3.Object.getOwnPropertyNames.ownKeys",
    group: "S3",
    mechanism: "Proxy ownKeys trap via Object.getOwnPropertyNames(p)",
    setup: ownKeysProxy,
    trigger: `const names = Object.getOwnPropertyNames(p);\n`,
    probeTemplate: "Object.getOwnPropertyNames(__ARG__)",
    probeExpect: { kind: "proxyPlainObject", fires: "proxy:ownKeys" },
  },
  {
    id: "S3.in.has",
    group: "S3",
    mechanism: 'Proxy has trap via "k" in p',
    setup: hasProxy,
    trigger: `const found = "k" in p;\n`,
    probeTemplate: '"k" in __ARG__',
    probeExpect: { kind: "proxyPlainObject", fires: "proxy:has" },
  },
  {
    id: "S3.JSON.stringify.ownKeys",
    group: "S3",
    mechanism: "Proxy ownKeys trap via JSON.stringify(p)",
    setup: ownKeysProxy,
    trigger: `const text = JSON.stringify(p);\n`,
    probeTemplate: "JSON.stringify(__ARG__)",
    probeExpect: { kind: "proxyPlainObject", fires: "proxy:ownKeys" },
  },
  {
    id: "S3.JSON.stringify.get",
    group: "S3",
    mechanism: "Proxy get trap via JSON.stringify(p)",
    setup: getProxy,
    trigger: `const text = JSON.stringify(p);\n`,
    probeTemplate: "JSON.stringify(__ARG__)",
    probeExpect: { kind: "proxyPlainObject", fires: "proxy:get" },
  },
  {
    // ADDED by task A-0: the handler is a named object, not an object
    // literal written in `new Proxy(...)`'s argument list -- the shape
    // that separates "a function value that is an object member of an
    // argument" (ADR 0008 § 2's escape row) from a method of an object
    // that is passed by name.
    id: "S3.Object.keys.ownKeys.named-handler",
    group: "S3",
    mechanism:
      "Proxy ownKeys trap via Object.keys(p), handler bound to a const",
    setup: (fn) =>
      `const handler = { ownKeys(t) { lib.${fn}("x"); return Reflect.ownKeys(t); } };\nconst p = new Proxy({ a: 1 }, handler);\n`,
    trigger: `const keys = Object.keys(p);\n`,
    probeTemplate: "Object.keys(__ARG__)",
    probeExpect: { kind: "proxyPlainObject", fires: "proxy:ownKeys" },
  },
  {
    // ADDED by task A-0: the named-handler shape triggered by an OPERATOR,
    // not a builtin call. `in` is not an invocation-capable site in ADR
    // 0008 § 2, and `new Proxy(target, handler)` runs no user code during
    // the call (the H-0 probe, below), so this is the shape the ADR as
    // written does not close (Amendment A-0).
    id: "S3.in.has.named-handler",
    group: "S3",
    mechanism: 'Proxy has trap via "k" in p, handler bound to a const',
    setup: (fn) =>
      `const handler = { has(t, k) { lib.${fn}("x"); return Reflect.has(t, k); } };\nconst p = new Proxy({}, handler);\n`,
    trigger: `const found = "k" in p;\n`,
    probeTemplate: '"k" in __ARG__',
    probeExpect: { kind: "proxyPlainObject", fires: "proxy:has" },
  },
];

// ---------------------------------------------------------------------------
// S4 -- precision controls: a builtin that never touches the object
// ---------------------------------------------------------------------------

const methodObject = (fn: string) =>
  `const obj = { run() { return lib.${fn}("x"); } };\n`;

export const S4: readonly Scenario[] = [
  {
    id: "S4.Array.isArray",
    group: "S4",
    mechanism: "object with a method, passed to Array.isArray(obj)",
    setup: methodObject,
    trigger: `const isArray = Array.isArray(obj);\n`,
    probeTemplate: "Array.isArray(__ARG__)",
    probeExpect: "none",
  },
  {
    id: "S4.Object.is",
    group: "S4",
    mechanism: "object with a method, passed to Object.is(obj, x)",
    setup: methodObject,
    trigger: `const same = Object.is(obj, 1);\n`,
    probeTemplate: "Object.is(__ARG__, 1)",
    probeExpect: "none",
  },
];
