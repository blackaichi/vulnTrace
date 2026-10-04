import {
  BUILTIN_BEHAVIOUR,
  type BuiltinBehaviour,
  type BuiltinCallForm,
} from "../../src/code-intelligence/builtin-callables.js";
import type { OracleCase } from "../../src/testing/oracle/case.js";
import {
  callExpressionAt,
  type BuiltinArgKind,
  type BuiltinCallShape,
} from "../../src/testing/oracle/builtin-probe.js";
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
 * Task A-3a: the pieces of the MECHANICAL ADMISSION test
 * (`builtin-admission.test.ts`) for the non-invoking allowlist -- ADR 0008's
 * allowlist admission ruling (2026-09-27), per argument position:
 *
 * (a) every hook the probe observes firing at the position is a member of
 *     § 2's protocol list, an accessor body, or a Proxy trap -- classified
 *     here by {@link classifyHook};
 * (b) for each such hook, an oracle case in which a vulnerable call inside
 *     the hook, reached through the builtin at the position, is never
 *     `NOT_AFFECTED` -- generated here by {@link admissionOracleCases}.
 */

/** The protocol members of ADR 0008 § 2, by the probe's hook names. */
const PROTOCOL_HOOKS: ReadonlySet<string> = new Set([
  "toString",
  "valueOf",
  "toPrimitive",
  "toJSON",
  "then",
  "iterator",
]);

export type HookClass = "protocol" | "accessor" | "proxy_trap" | "other";

/**
 * Condition (a): how ADR 0008 accounts for a hook independently of the
 * call, or `other` when it does not -- the builtin calling a function
 * argument, `util.inspect.custom`, or anything else, which fails the
 * position.
 */
export function classifyHook(hook: string): HookClass {
  if (PROTOCOL_HOOKS.has(hook)) {
    return "protocol";
  }
  if (hook === "getter") {
    return "accessor";
  }
  if (hook.startsWith("proxy:")) {
    return "proxy_trap";
  }
  return "other";
}

/** An admitted position of the behaviour table, with the call shape to probe it. */
export interface AdmittedPosition {
  readonly behaviourKey: string;
  readonly key: string;
  readonly form: BuiltinCallForm;
  readonly position: number;
  readonly shape: BuiltinCallShape;
}

/** The first three positions stand for every position of a variadic builtin admitted as `"all"`. */
const VARIADIC_PROBED = [0, 1, 2];

function positionsOf(behaviour: BuiltinBehaviour): readonly number[] {
  const admitted = behaviour.admitted;
  if (admitted === undefined) {
    return [];
  }
  return admitted === "all" ? VARIADIC_PROBED : admitted;
}

/** The call shape of a builtin key: `global:Array.isArray`, `module:path:join`. */
export function shapeOf(
  key: string,
  form: BuiltinCallForm,
  arity: number,
): BuiltinCallShape {
  if (key.startsWith("global:")) {
    return { setup: "", callee: key.slice("global:".length), form, arity };
  }
  const [, specifier, member] = key.split(":");
  return {
    setup: `const __m = require(${JSON.stringify(specifier)});`,
    callee: member ? `__m.${member}` : "__m",
    form,
    arity,
  };
}

/** Every admitted position the behaviour table lists. */
export function admittedPositions(): readonly AdmittedPosition[] {
  return Object.entries(BUILTIN_BEHAVIOUR).flatMap(
    ([behaviourKey, behaviour]) => {
      const [form, key] = behaviourKey.split(" ") as [BuiltinCallForm, string];
      const positions = positionsOf(behaviour);
      const arity = Math.max(-1, ...positions) + 1;
      return positions.map((position) => ({
        behaviourKey,
        key,
        form,
        position,
        shape: shapeOf(key, form, arity),
      }));
    },
  );
}

// ---------------------------------------------------------------------------
// Condition (b): generated oracle cases
// ---------------------------------------------------------------------------

export const ADMISSION_ADVISORY_ID = "GHSA-a3a-builtin-admission";
export const TARGET_MARKER = "parse";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

function project(body: string): ProjectSpec {
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
        id: ADMISSION_ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "src/index.js": `const lib = require("vuln-lib");\n` + body,
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.js"] }),
    },
  };
}

/**
 * A value whose Proxy trap runs `call` and returns a value every Proxy
 * invariant accepts for the plain target `{ probe: 1 }` (or a function
 * target for `apply` / `construct`) -- without forwarding through
 * `Reflect`, whose arguments the graph cannot attribute, so that the
 * negative control can be `NOT_AFFECTED`.
 */
const TRAP_RETURNS: Readonly<Record<string, string>> = {
  get: "1",
  set: "true",
  has: "true",
  deleteProperty: "true",
  ownKeys: `["probe"]`,
  getOwnPropertyDescriptor:
    "({ value: 1, writable: true, enumerable: true, configurable: true })",
  defineProperty: "true",
  getPrototypeOf: "null",
  setPrototypeOf: "true",
  isExtensible: "true",
  preventExtensions: "false",
  apply: "1",
  construct: "({})",
};

function trapTarget(trap: string): string {
  return trap === "apply" || trap === "construct"
    ? "function probeTarget() {}"
    : "{ probe: 1 }";
}

function trapHandler(trap: string, call: string): string {
  return `{ ${trap}() { ${call} return ${TRAP_RETURNS[trap] ?? "undefined"}; } }`;
}

function protocolObject(hook: string, call: string): string {
  switch (hook) {
    case "toString":
      return `({ toString() { ${call} return "p"; } })`;
    case "valueOf":
      return `({ valueOf() { ${call} return 1; } })`;
    case "toPrimitive":
      return `({ [Symbol.toPrimitive]() { ${call} return 1; } })`;
    case "toJSON":
      return `({ toJSON() { ${call} return 1; } })`;
    case "then":
      return `({ then() { ${call} } })`;
    default:
      return `({ [Symbol.iterator]() { ${call} return { next() { return { done: true }; } }; } })`;
  }
}

function oracleCase(
  id: string,
  source: string,
  controls: { readonly negative: string } | { readonly inapplicable: string },
): OracleCase {
  const provider = () =>
    syntheticProvider([
      { id: ADMISSION_ADVISORY_ID, packageName: "vuln-lib", fixed: "99.0.0" },
    ]);
  return {
    id,
    loudFixture: { specifier: "vuln-lib", boundNames: ["parse", "safe"] },
    provider,
    groundTruthCommand: nodeEntryCommand("src/index.js"),
    controls:
      "inapplicable" in controls
        ? { kind: "inapplicable", reason: controls.inapplicable }
        : {
            kind: "controls",
            controls: {
              positive: {
                name: "positive-control",
                project: project(`lib.parse("x");\n` + controls.negative),
              },
              negative: {
                name: "negative-control",
                project: project(controls.negative),
              },
            },
          },
    variant: { name: "case", project: project(source) },
  };
}

/**
 * The condition-(b) oracle cases for one fired `hook` at one admitted
 * position, called in the context (`filler`) the probe saw it fire in.
 * The builtin call is wrapped in `try`, since several builtins fire a hook
 * while rejecting the argument (an error message inspecting it).
 */
export function admissionOracleCases(
  at: AdmittedPosition,
  hook: string,
  firedWith: { readonly kind: BuiltinArgKind; readonly filler: string },
): readonly OracleCase[] {
  const id = `${at.behaviourKey}#${String(at.position)}.${hook}`;
  const invoke = `try { ${callExpressionAt(at.shape, at.position, "__arg", firedWith.filler)}; } catch {}\n`;
  const setup = at.shape.setup ? `${at.shape.setup}\n` : "";
  const PARSE = `lib.parse("x");`;
  const SAFE = `lib.safe("x");`;
  const hookClass = classifyHook(hook);

  if (hookClass === "proxy_trap") {
    const trap = hook.slice("proxy:".length);
    const inline = (call: string) =>
      `${setup}const __arg = new Proxy(${trapTarget(trap)}, ${trapHandler(trap, call)});\n${invoke}`;
    const handler = `const __h = ${trapHandler(trap, PARSE)};\n`;
    return [
      oracleCase(`${id}.inline-handler`, inline(PARSE), {
        negative: inline(SAFE),
      }),
      oracleCase(
        `${id}.named-handler`,
        `${setup}${handler}const __arg = new Proxy(${trapTarget(trap)}, __h);\n${invoke}`,
        { negative: handler },
      ),
    ];
  }
  if (hookClass === "accessor") {
    // Since task A-4 the getter is its own owner, reached by a possible
    // edge from the module: with `safe` in its body the region is complete.
    const program = (call: string) =>
      `${setup}const __arg = { get probe() { ${call} return 1; } };\n${invoke}`;
    return [
      oracleCase(`${id}.getter`, program(PARSE), { negative: program(SAFE) }),
    ];
  }
  if (hookClass === "protocol") {
    const program = (call: string) =>
      `${setup}const __arg = ${protocolObject(hook, call)};\n${invoke}`;
    return [
      oracleCase(`${id}.protocol-member`, program(PARSE), {
        negative: program(SAFE),
      }),
    ];
  }
  return [];
}
