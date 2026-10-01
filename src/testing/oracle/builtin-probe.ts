import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

/**
 * THE BUILTIN PROBE (task H-0 step 3; extended by task A-3a).
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
 * - `then`: the hook a promise resolution reads (task A-3a);
 * - `iterator`: `Symbol.iterator`, which spreading and iteration read (task A-3a);
 * - `proxy`: every one of the 13 proxy traps, instrumented at once, wrapping
 *   a callable target so `apply`/`construct` are reachable too;
 * - `proxyPlainObject`: the same instrumented handler around a PLAIN OBJECT
 *   target with one own enumerable data property. Added by task A-0: a
 *   builtin may treat a callable argument differently from a plain object
 *   -- `JSON.stringify` returns early for a callable after reading
 *   `toJSON`, so the callable `proxy` kind shows only the `get` trap and
 *   never the `ownKeys` / `getOwnPropertyDescriptor` / `get` enumeration a
 *   plain-object Proxy triggers. A probe that exercised only one of the
 *   two would under-report exactly what an allowlist entry must be proven
 *   not to do.
 *
 * WHAT A RESULT SAYS (task A-3a, ADR 0008's allowlist admission ruling).
 * `fired` holds the hooks that ran, and only hooks: a call that throws is
 * reported in `threw`, never in `fired` (before A-3a a throw was recorded
 * as `THREW:<message>` in `fired`, so a builtin that rejects its argument
 * read as one that ran user code). `fired` is read when the probe process
 * EXITS, not right after the call returns, so a hook the builtin schedules
 * for later -- `Promise.resolve(thenable)` runs `then` in a microtask -- is
 * seen.
 *
 * This module decides no allowlist entry (task H-0 boundary): the
 * admission test (`tests/oracle/builtin-admission.test.ts`) does, from what
 * these probes report.
 */
export type BuiltinArgKind =
  | "function"
  | "getter"
  | "valueOf"
  | "toString"
  | "toPrimitive"
  | "toJSON"
  | "inspectCustom"
  | "then"
  | "iterator"
  | "proxy"
  | "proxyPlainObject";

export const ALL_BUILTIN_ARG_KINDS: readonly BuiltinArgKind[] = [
  "function",
  "getter",
  "valueOf",
  "toString",
  "toPrimitive",
  "toJSON",
  "inspectCustom",
  "then",
  "iterator",
  "proxy",
  "proxyPlainObject",
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

/** The line prefix the probe script writes its report after, at exit. */
const REPORT_PREFIX = "__VT_PROBE__";

/**
 * The source of an argument of `argKind` whose hook runs `hookBody` --
 * `__mark("<hook>")` for the probe; a vulnerable call for an admission
 * oracle case (condition (b) of the allowlist admission ruling). The hook
 * names are the ones {@link BuiltinProbeResult.fired} reports.
 */
export function argumentSource(
  argKind: BuiltinArgKind,
  hookBody: (hook: string) => string = (hook) =>
    `__mark(${JSON.stringify(hook)});`,
): string {
  switch (argKind) {
    case "function":
      return `(function probeFn(){ ${hookBody("function")} return 1; })`;
    case "getter":
      return `({ get probe(){ ${hookBody("getter")} return 1; } })`;
    case "valueOf":
      return `({ valueOf(){ ${hookBody("valueOf")} return 1; } })`;
    case "toString":
      return `({ toString(){ ${hookBody("toString")} return "probe"; } })`;
    case "toPrimitive":
      return `({ [Symbol.toPrimitive](hint){ ${hookBody("toPrimitive")} return hint === "number" ? 1 : "probe"; } })`;
    case "toJSON":
      return `({ toJSON(){ ${hookBody("toJSON")} return "probe"; } })`;
    case "inspectCustom":
      return `({ [require("util").inspect.custom](){ ${hookBody("inspectCustom")} return "probe"; } })`;
    case "then":
      return `({ then(){ ${hookBody("then")} } })`;
    case "iterator":
      return `({ [Symbol.iterator](){ ${hookBody("iterator")} return [][Symbol.iterator](); } })`;
    case "proxy":
      return `new Proxy(function probeTarget(){}, {\n    ${instrumentedHandlerBody(hookBody)}\n  })`;
    case "proxyPlainObject":
      return `new Proxy({ probe: 1 }, {\n    ${instrumentedHandlerBody(hookBody)}\n  })`;
  }
}

/** A handler instrumenting every one of {@link PROXY_TRAPS}, each marking `proxy:<trap>`. */
function instrumentedHandlerBody(hookBody: (hook: string) => string): string {
  return PROXY_TRAPS.map(
    (trap) =>
      `${trap}(...a){ ${hookBody(`proxy:${trap}`)} return Reflect.${trap}(...a); }`,
  ).join(",\n    ");
}

export interface BuiltinProbeResult {
  readonly argKind: BuiltinArgKind;
  /** Whether ANY user-code hook fired. A throw is not a hook. */
  readonly ranUserCode: boolean;
  /** Which hook(s)/trap(s) fired, in firing order, until the probe process exited. */
  readonly fired: readonly string[];
  /** The message of the exception the call threw, if it threw. */
  readonly threw?: string;
  readonly stdout: string;
}

interface ProbeReport {
  readonly log: readonly (readonly [string, string])[];
  readonly threw?: string;
}

/**
 * The common prelude of every probe script: `__mark` records a hook with
 * the phase it fired in, and the report is written when the process
 * exits, so a deferred hook is included.
 */
const SCRIPT_PRELUDE = [
  `const __log = [];`,
  `let __phase = "call";`,
  `let __threw;`,
  `function __mark(name) { __log.push([__phase, name]); }`,
  `process.on("exit", () => { process.stdout.write("\\n${REPORT_PREFIX}" + JSON.stringify({ log: __log, threw: __threw }) + "\\n"); });`,
].join("\n");

function parseReport(raw: string): ProbeReport {
  const line = raw
    .split("\n")
    .reverse()
    .find((l) => l.startsWith(REPORT_PREFIX));
  if (line === undefined) {
    throw new Error(`builtin probe: no report in output: ${raw}`);
  }
  return JSON.parse(line.slice(REPORT_PREFIX.length)) as ProbeReport;
}

function probeScript(
  callStatement: string,
  argKind: BuiltinArgKind,
  setup: string,
): string {
  return [
    setup,
    SCRIPT_PRELUDE,
    `const __arg = ${argumentSource(argKind)};`,
    `try {`,
    `  ${callStatement};`,
    `} catch (e) { __threw = String(e && e.message); }`,
  ].join("\n");
}

function toResult(argKind: BuiltinArgKind, raw: string): BuiltinProbeResult {
  const report = parseReport(raw);
  const fired = report.log.map(([, hook]) => hook);
  return {
    argKind,
    ranUserCode: fired.length > 0,
    fired,
    ...(report.threw === undefined ? {} : { threw: report.threw }),
    stdout: raw,
  };
}

function substitute(callTemplate: string): string {
  if (!callTemplate.includes(ARG_PLACEHOLDER)) {
    throw new Error(
      `probeBuiltinArgKind: callTemplate must contain the ${ARG_PLACEHOLDER} placeholder, got: ${callTemplate}`,
    );
  }
  return callTemplate.split(ARG_PLACEHOLDER).join("__arg");
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
  // `util` is in scope for a template, as it always was (`util.inspect(__ARG__)`).
  const script = probeScript(
    substitute(callTemplate),
    argKind,
    `const util = require("util");`,
  );
  const raw = execFileSync("node", ["-e", script], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  return toResult(argKind, raw);
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

// ---------------------------------------------------------------------------
// Task A-3a: probing one argument POSITION of a builtin, in several contexts
// ---------------------------------------------------------------------------

/** How a builtin is called, for a probe of one of its argument positions. */
export interface BuiltinCallShape {
  /** Statements run first, e.g. `const path = require("path");`. */
  readonly setup: string;
  /** The callee expression, e.g. `path.join`, `Array.isArray`, `Promise`. */
  readonly callee: string;
  readonly form: "call" | "construct";
  /** How many arguments the probe passes. */
  readonly arity: number;
}

/**
 * The values the probe puts at every OTHER argument position, one context
 * at a time: a builtin may take a different path through its argument
 * depending on its other arguments (it may throw on one first, or read an
 * option), so a position is probed against each.
 */
export const OTHER_POSITION_FILLERS: readonly string[] = [
  `"x"`,
  `0`,
  `{}`,
  `undefined`,
];

/** The call expression for `shape` with `argument` at `position` and `filler` everywhere else. */
export function callExpressionAt(
  shape: BuiltinCallShape,
  position: number,
  argument: string,
  filler: string,
): string {
  const args = Array.from({ length: shape.arity }, (_, i) =>
    i === position ? argument : filler,
  );
  return `${shape.form === "construct" ? "new " : ""}${shape.callee}(${args.join(", ")})`;
}

const execFileAsync = promisify(execFile);

async function runScript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("node", ["-e", script], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  return stdout;
}

/** One probe of `shape` with an `argKind` value at `position` and `filler` elsewhere. */
export async function probePosition(
  shape: BuiltinCallShape,
  position: number,
  argKind: BuiltinArgKind,
  filler: string,
): Promise<BuiltinProbeResult> {
  const script = probeScript(
    callExpressionAt(shape, position, "__arg", filler),
    argKind,
    shape.setup,
  );
  return toResult(argKind, await runScript(script));
}

/**
 * Operations a later program could apply to a value: a read, a write, `in`,
 * enumeration, coercion, serialization, inspection, iteration, a call and a
 * construction. Applied to a builtin's RESULT (recursively, into its own
 * values, a few levels deep) and to the ARGUMENT after the call, by
 * {@link probeRetention}.
 */
const OPERATIONS_SOURCE = `
function __ops(v, depth) {
  if (!((typeof v === "object" && v !== null) || typeof v === "function")) return;
  try { v.probe; } catch {}
  try { v.probe = 2; } catch {}
  try { "probe" in v; } catch {}
  try { Object.keys(v); } catch {}
  try { String(v); } catch {}
  try { v + 1; } catch {}
  try { JSON.stringify(v); } catch {}
  try { require("util").inspect(v); } catch {}
  try { for (const x of v) { break; } } catch {}
  if (typeof v === "function") {
    try { v(); } catch {}
    try { new v(); } catch {}
  }
  if (depth > 0) {
    let keys = [];
    try { keys = Reflect.ownKeys(v); } catch {}
    for (const k of keys) {
      let d;
      try { d = Reflect.getOwnPropertyDescriptor(v, k); } catch {}
      if (d && "value" in d) __ops(d.value, depth - 1);
    }
  }
}`;

export interface RetentionResult {
  /** Hooks fired by the operations applied to the call's result. */
  readonly onResult: readonly string[];
  /** Hooks fired by the operations applied to the argument after the call. */
  readonly onArgumentAfterCall: readonly string[];
  /** The same operations on the same argument in a run that never made the call. */
  readonly onArgumentWithoutCall: readonly string[];
}

/**
 * Amendment A-0 part A's non-retaining test, for one argument kind at one
 * position: a builtin RETAINS an argument when it returns, or stores, an
 * object through which a later operation can invoke user code taken from
 * that argument. Observed two ways: operations on the call's result must
 * fire nothing, and the same operations on the argument must fire exactly
 * what they fire in a run that never made the call (so the call left
 * nothing behind on the argument). A store into state the program cannot
 * reach through the result or the argument (a listener registry) is not
 * observable this way; the admission test admits no builtin whose purpose
 * is to store.
 */
export async function probeRetention(
  shape: BuiltinCallShape,
  position: number,
  argKind: BuiltinArgKind,
  filler: string,
): Promise<RetentionResult> {
  const call = callExpressionAt(shape, position, "__arg", filler);
  const withCall = [
    shape.setup,
    SCRIPT_PRELUDE,
    OPERATIONS_SOURCE,
    `const __arg = ${argumentSource(argKind)};`,
    `let __result;`,
    `try { __result = ${call}; } catch (e) { __threw = String(e && e.message); }`,
    `setTimeout(() => { __phase = "result"; __ops(__result, 3); __phase = "argument"; __ops(__arg, 0); }, 20);`,
  ].join("\n");
  const withoutCall = [
    shape.setup,
    SCRIPT_PRELUDE,
    OPERATIONS_SOURCE,
    `const __arg = ${argumentSource(argKind)};`,
    `setTimeout(() => { __phase = "argument"; __ops(__arg, 0); }, 20);`,
  ].join("\n");
  const [a, b] = await Promise.all([
    runScript(withCall),
    runScript(withoutCall),
  ]);
  const inPhase = (report: ProbeReport, phase: string): string[] =>
    report.log.filter(([p]) => p === phase).map(([, hook]) => hook);
  const after = parseReport(a);
  const without = parseReport(b);
  return {
    onResult: inPhase(after, "result"),
    onArgumentAfterCall: inPhase(after, "argument"),
    onArgumentWithoutCall: inPhase(without, "argument"),
  };
}
