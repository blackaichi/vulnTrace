import { execFileSync } from "node:child_process";

/**
 * THE BUILTIN PROBE (task H-0 step 3).
 *
 * The project's non-invoking-builtin allowlist (docs/REMEDIATION-PLAN.md
 * decision 1: "each entry proven non-invoking by a real-Node test") may
 * only admit a builtin call once a real-Node test shows it never runs
 * ANY of these argument-kind shapes -- every ECMAScript-level implicit
 * invocation surface a plain value argument can carry:
 *
 * - `function`: the argument itself is a function (does the builtin call it?);
 * - `getter`: an object with an own enumerable accessor property (does the
 *   builtin read it?);
 * - `valueOf` / `toString` / `toPrimitive`: the three hooks `ToNumber` and
 *   `ToPrimitive` coercion consult;
 * - `toJSON`: the hook `JSON.stringify` consults before enumerating properties;
 * - `inspectCustom`: the hook `util.inspect` (and therefore `console.log`) consults;
 * - `proxy`: every one of the 13 proxy traps, instrumented at once, wrapping
 *   a callable target so `apply`/`construct` are reachable too.
 *
 * This module does not decide any allowlist entry (task H-0 boundary) --
 * it only gives a later task the tool to do so, plus a self-test proving
 * the tool itself detects what it claims to.
 */
export type BuiltinArgKind =
  | "function"
  | "getter"
  | "valueOf"
  | "toString"
  | "toPrimitive"
  | "toJSON"
  | "inspectCustom"
  | "proxy";

export const ALL_BUILTIN_ARG_KINDS: readonly BuiltinArgKind[] = [
  "function",
  "getter",
  "valueOf",
  "toString",
  "toPrimitive",
  "toJSON",
  "inspectCustom",
  "proxy",
];

/** Every proxy trap (all 13 fundamental internal methods a Proxy handler can intercept). */
export const PROXY_TRAPS = [
  "get",
  "set",
  "has",
  "deleteProperty",
  "ownKeys",
  "getOwnPropertyDescriptor",
  "defineProperty",
  "getPrototypeOf",
  "setPrototypeOf",
  "isExtensible",
  "preventExtensions",
  "apply",
  "construct",
] as const;

const ARG_PLACEHOLDER = "__ARG__";

function argumentSource(argKind: BuiltinArgKind): string {
  switch (argKind) {
    case "function":
      return `(function probeFn(){ __mark("function"); return 1; })`;
    case "getter":
      return `({ get probe(){ __mark("getter"); return 1; } })`;
    case "valueOf":
      return `({ valueOf(){ __mark("valueOf"); return 1; } })`;
    case "toString":
      return `({ toString(){ __mark("toString"); return "probe"; } })`;
    case "toPrimitive":
      return `({ [Symbol.toPrimitive](hint){ __mark("toPrimitive"); return hint === "number" ? 1 : "probe"; } })`;
    case "toJSON":
      return `({ toJSON(){ __mark("toJSON"); return "probe"; } })`;
    case "inspectCustom":
      return `({ [util.inspect.custom](){ __mark("inspectCustom"); return "probe"; } })`;
    case "proxy": {
      const body = PROXY_TRAPS.map(
        (trap) =>
          `${trap}(...a){ __mark(${JSON.stringify(`proxy:${trap}`)}); return Reflect.${trap}(...a); }`,
      ).join(",\n    ");
      return `new Proxy(function probeTarget(){}, {\n    ${body}\n  })`;
    }
  }
}

export interface BuiltinProbeResult {
  readonly argKind: BuiltinArgKind;
  /** Whether ANY user-code hook fired. */
  readonly ranUserCode: boolean;
  /** Which hook(s)/trap(s) fired, in firing order. */
  readonly fired: readonly string[];
  readonly stdout: string;
}

/**
 * Runs `callTemplate` (a JS statement/expression containing the literal
 * placeholder `__ARG__`) in a REAL, separate Node process, with `__ARG__`
 * substituted for a value of the given {@link BuiltinArgKind}, and reports
 * whether the builtin invoked any user-supplied hook on that value.
 *
 * A separate process, not this process's own `eval`/`vm`: the whole point
 * is to observe REAL Node's ECMAScript semantics, not a re-implementation
 * of them, matching every other real-Node ground truth this harness
 * produces.
 */
export function probeBuiltinArgKind(
  callTemplate: string,
  argKind: BuiltinArgKind,
): BuiltinProbeResult {
  if (!callTemplate.includes(ARG_PLACEHOLDER)) {
    throw new Error(
      `probeBuiltinArgKind: callTemplate must contain the ${ARG_PLACEHOLDER} placeholder, got: ${callTemplate}`,
    );
  }
  const script = [
    `const util = require("util");`,
    `const fired = [];`,
    `function __mark(name) { fired.push(name); }`,
    `const __arg = ${argumentSource(argKind)};`,
    `try {`,
    `  ${callTemplate.split(ARG_PLACEHOLDER).join("__arg")};`,
    `} catch (e) { fired.push("THREW:" + (e && e.message)); }`,
    `console.log(JSON.stringify(fired));`,
  ].join("\n");

  const raw = execFileSync("node", ["-e", script], {
    encoding: "utf-8",
    timeout: 10_000,
  }).trim();
  const lastLine = raw.split("\n").at(-1) ?? raw;
  const fired = JSON.parse(lastLine) as string[];
  return { argKind, ranUserCode: fired.length > 0, fired, stdout: raw };
}

/** {@link probeBuiltinArgKind} over every (or a chosen subset of) argument kind. */
export function probeBuiltinInvocation(
  callTemplate: string,
  argKinds: readonly BuiltinArgKind[] = ALL_BUILTIN_ARG_KINDS,
): Readonly<Record<BuiltinArgKind, BuiltinProbeResult>> {
  const results: Partial<Record<BuiltinArgKind, BuiltinProbeResult>> = {};
  for (const kind of argKinds) {
    results[kind] = probeBuiltinArgKind(callTemplate, kind);
  }
  return results as Record<BuiltinArgKind, BuiltinProbeResult>;
}
