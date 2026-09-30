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
 * Task A-3a (docs/tasks/A-3a-escaped-values.md): function values that
 * escape into code the graph does not model (ADR 0008 § 2's escape row),
 * the documented invoking builtins (§ 4), the assignment form of the
 * escape row (PRM-114), the arguments an implicit constructor forwards to
 * an ambient or builtin base (RWF-060), and `Reflect.construct` (PRM-37's
 * A-1 status update) -- reproduced against real Node.
 *
 * One shared LOUD fixture, the same one tasks A-0 and A-1 use: `vuln-lib`
 * exports `parse` (the rule's target) and `safe` (its inert sibling), both
 * marked with the `hit()` convention, and every case declares both as
 * bound names, so a fabricated attribution resolves loudly to a wrong
 * target instead of degrading to UNKNOWN.
 *
 * THE CONTROLS, as in task A-1's cases:
 *
 * - positive control: `lib.parse("x")` followed by the negative control,
 *   proving the rule, target and entrypoint wiring of this exact project
 *   produce AFFECTED;
 * - negative control: `negative`, which real Node must run without ever
 *   calling the target, and which the analyzer must answer NOT_AFFECTED.
 *
 * For an AFFECTED case, and for an UNKNOWN case whose invocation is
 * accounted by a POSSIBLE edge, the negative control is the case with the
 * hook calling `lib.safe` instead: a possible edge into a region that
 * never reaches the target leaves family C standing (task A-2). For a
 * FAIL-CLOSED case (the invocation is accounted by an UNKNOWN edge, which
 * blocks the negative proof whichever export the hook calls), the
 * negative control keeps every definition and removes what makes it run.
 */

export const ADVISORY_ID = "GHSA-a3a-escaped-values";
export const TARGET_MARKER = "parse";

const LIB_SOURCE =
  HIT_HELPER_SOURCE +
  hitFunction("parse", '"p"') +
  hitFunction("safe", '"s"') +
  `module.exports = { parse, safe };\n`;

const PRELUDE = `const lib = require("vuln-lib");\n`;

export type Finding = "AUD-01" | "PRM-12" | "PRM-114" | "RWF-060" | "PRM-37";

export interface A3aCase {
  /** Stable case id, e.g. `invoking.setTimeout.inline`. */
  readonly id: string;
  readonly finding: Finding;
  /** One line: the mechanism. */
  readonly mechanism: string;
  /** The case program, after the prelude. */
  readonly source: string;
  /** The negative control's program, after the prelude (see the module comment). */
  readonly negative: string;
  /**
   * The only sound verdict once A-3a accounts for the escape. AFFECTED
   * needs a documented invoking builtin (ADR 0008 § 4) AND an
   * attributable value; UNKNOWN is a possible edge (the builtin may run
   * the value) or the fail-closed default (§ 3); NOT_AFFECTED is a
   * precision or identity control.
   */
  readonly expected: "AFFECTED" | "UNKNOWN" | "NOT_AFFECTED";
}

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
        id: ADVISORY_ID,
        packageName: "vuln-lib",
        exportName: "parse",
      }),
      "src/index.js": PRELUDE + body,
      "vulntrace.yml": simpleConfigFile({ entrypoints: ["src/index.js"] }),
    },
  };
}

export function oracleCase(kase: A3aCase): OracleCase {
  return {
    id: kase.id,
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
          project: project(`lib.parse("x");\n` + kase.negative),
        },
        negative: {
          name: "negative-control",
          project: project(kase.negative),
        },
      },
    },
    variant: { name: "case", project: project(kase.source) },
  };
}

/** A case whose negative control is the case with the hook calling `safe`. */
function hooked(
  base: Omit<A3aCase, "source" | "negative">,
  program: (fn: "parse" | "safe") => string,
): A3aCase {
  return { ...base, source: program("parse"), negative: program("safe") };
}

// ---------------------------------------------------------------------------
// AUD-01 -- the documented invoking builtins (ADR 0008 § 4): resolved
// ---------------------------------------------------------------------------

export const INVOKING: readonly A3aCase[] = [
  hooked(
    {
      id: "invoking.setTimeout.inline",
      finding: "AUD-01",
      mechanism: "setTimeout runs an inline callback",
      expected: "AFFECTED",
    },
    (fn) => `setTimeout(() => lib.${fn}("x"), 0);\n`,
  ),
  hooked(
    {
      id: "invoking.setTimeout.named-local",
      finding: "AUD-01",
      mechanism: "setTimeout runs a same-file function passed by name",
      expected: "AFFECTED",
    },
    (fn) => `function cb() { lib.${fn}("x"); }\nsetTimeout(cb, 0);\n`,
  ),
  hooked(
    {
      id: "invoking.setInterval.inline",
      finding: "AUD-01",
      mechanism:
        "setInterval runs an inline callback (which clears its own timer)",
      expected: "AFFECTED",
    },
    (fn) =>
      `const t = setInterval(() => { clearInterval(t); lib.${fn}("x"); }, 0);\n`,
  ),
  hooked(
    {
      id: "invoking.setImmediate.inline",
      finding: "AUD-01",
      mechanism: "setImmediate runs an inline callback",
      expected: "AFFECTED",
    },
    (fn) => `setImmediate(() => lib.${fn}("x"));\n`,
  ),
  hooked(
    {
      id: "invoking.queueMicrotask.inline",
      finding: "AUD-01",
      mechanism: "queueMicrotask runs an inline callback",
      expected: "AFFECTED",
    },
    (fn) => `queueMicrotask(() => lib.${fn}("x"));\n`,
  ),
  hooked(
    {
      id: "invoking.process.nextTick.inline",
      finding: "AUD-01",
      mechanism: "process.nextTick runs an inline callback",
      expected: "AFFECTED",
    },
    (fn) => `process.nextTick(() => lib.${fn}("x"));\n`,
  ),
  hooked(
    {
      id: "invoking.Promise.executor",
      finding: "AUD-01",
      mechanism: "new Promise runs its executor synchronously",
      expected: "AFFECTED",
    },
    (fn) => `new Promise(() => { lib.${fn}("x"); });\n`,
  ),
  hooked(
    {
      id: "invoking.Array.from.mapper",
      finding: "AUD-01",
      mechanism: "Array.from runs its mapper over a non-empty literal",
      expected: "AFFECTED",
    },
    (fn) => `Array.from([1], () => lib.${fn}("x"));\n`,
  ),
  hooked(
    {
      id: "invoking.Reflect.apply",
      finding: "AUD-01",
      mechanism: "Reflect.apply calls its first argument",
      expected: "AFFECTED",
    },
    (fn) => `function cb() { lib.${fn}("x"); }\nReflect.apply(cb, null, []);\n`,
  ),
  hooked(
    {
      id: "invoking.Reflect.apply.import",
      finding: "AUD-01",
      mechanism: "Reflect.apply calls an imported function passed by value",
      expected: "AFFECTED",
    },
    (fn) => `Reflect.apply(lib.${fn}, null, ["x"]);\n`,
  ),
];

// ---------------------------------------------------------------------------
// AUD-01 / PRM-12 -- escaped values that MAY run: possible edges
// ---------------------------------------------------------------------------

export const ESCAPED: readonly A3aCase[] = [
  hooked(
    {
      id: "escaped.JSON.parse.reviver",
      finding: "AUD-01",
      mechanism:
        "JSON.parse runs its reviver (not a documented invoking position)",
      expected: "UNKNOWN",
    },
    (fn) => `JSON.parse('{"a":1}', (k, v) => { lib.${fn}("x"); return v; });\n`,
  ),
  hooked(
    {
      id: "escaped.process.on.emit",
      finding: "AUD-01",
      mechanism: "a listener registered with process.on runs on process.emit",
      expected: "UNKNOWN",
    },
    (fn) =>
      `process.on("vt-event", () => lib.${fn}("x"));\nprocess.emit("vt-event");\n`,
  ),
  hooked(
    {
      id: "escaped.fs.readFile.import",
      finding: "PRM-12",
      mechanism: "fs.readFile runs an imported function passed as its callback",
      expected: "UNKNOWN",
    },
    (fn) =>
      `const fs = require("fs");\nfs.readFile("no-such-file", lib.${fn});\n`,
  ),
  hooked(
    {
      id: "escaped.fs.readFile.named-local",
      finding: "PRM-12",
      mechanism: "fs.readFile runs a same-file function passed as its callback",
      expected: "UNKNOWN",
    },
    (fn) =>
      `const fs = require("fs");\nfunction done() { lib.${fn}("x"); }\nfs.readFile("no-such-file", done);\n`,
  ),
  hooked(
    {
      id: "escaped.fs.readFile.destructured",
      finding: "PRM-12",
      mechanism:
        "a destructured builtin member runs a function passed as its callback",
      expected: "UNKNOWN",
    },
    (fn) =>
      `const { readFile } = require("fs");\nfunction done() { lib.${fn}("x"); }\nreadFile("no-such-file", done);\n`,
  ),
  hooked(
    {
      id: "escaped.stream.Readable.read",
      finding: "AUD-01",
      mechanism:
        "new Readable({ read }) runs the read method, a member of an object-literal argument",
      expected: "UNKNOWN",
    },
    (fn) =>
      `const { Readable } = require("stream");\n` +
      `const r = new Readable({ read() { lib.${fn}("x"); } });\n` +
      (fn === "parse" ? `r.resume();\n` : ``),
  ),
  {
    id: "escaped.Function.prototype.apply.call",
    finding: "AUD-01",
    mechanism:
      "Function.prototype.apply.call(fn) calls fn: an ambient callee not in the builtin table (fail-closed)",
    expected: "UNKNOWN",
    source: `function cb() { lib.parse("x"); }\nFunction.prototype.apply.call(cb, null, []);\n`,
    negative: `function cb() { lib.parse("x"); }\n`,
  },
];

// ---------------------------------------------------------------------------
// PRM-114, AUD-01 -- the assignment form of the escape row
// ---------------------------------------------------------------------------

export const ASSIGNED: readonly A3aCase[] = [
  hooked(
    {
      id: "assigned.Error.prepareStackTrace",
      finding: "PRM-114",
      mechanism:
        "Error.prepareStackTrace = fn registers a hook V8 runs when .stack is read",
      expected: "UNKNOWN",
    },
    (fn) =>
      `Error.prepareStackTrace = () => { lib.${fn}("x"); return ""; };\n` +
      (fn === "parse" ? `new Error("boom").stack;\n` : ``),
  ),
  {
    id: "assigned.globalThis.hook",
    finding: "AUD-01",
    mechanism:
      "a function stored on globalThis is later called through it (fail-closed: the call is unattributable)",
    expected: "UNKNOWN",
    source: `globalThis.vtHook = () => lib.parse("x");\nglobalThis.vtHook();\n`,
    negative: `const vtHook = () => lib.parse("x");\n`,
  },
  hooked(
    {
      id: "assigned.Math.max.monkeypatch",
      finding: "AUD-01",
      mechanism:
        "a builtin member replaced by assignment, then called with primitive arguments",
      expected: "UNKNOWN",
    },
    (fn) =>
      `Math.max = () => lib.${fn}("x");\n` +
      (fn === "parse" ? `Math.max(1, 2);\n` : ``),
  ),
];

// ---------------------------------------------------------------------------
// AUD-01 -- ambient identity is lexical, not by spelling
// ---------------------------------------------------------------------------

export const IDENTITY: readonly A3aCase[] = [
  {
    id: "identity.parameter-named-JSON",
    finding: "AUD-01",
    mechanism:
      "a parameter named JSON is not the ambient JSON: its parse member is the program's own",
    expected: "UNKNOWN",
    source:
      `const my = { parse(s) { return lib.parse(s); } };\n` +
      `function run(JSON) { JSON.parse("x"); }\nrun(my);\n`,
    negative:
      `const my = { parse(s) { return lib.parse(s); } };\n` +
      `function run(JSON) { JSON.parse("x"); }\n`,
  },
  {
    id: "identity.parameter-named-setTimeout",
    finding: "AUD-01",
    mechanism:
      "identity control: a parameter named setTimeout that never runs its argument is not the documented invoking builtin",
    expected: "NOT_AFFECTED",
    source:
      `function run(setTimeout) { setTimeout(() => lib.parse("x")); }\n` +
      `run(function never(f) {});\n`,
    negative:
      `function run(setTimeout) { setTimeout(() => lib.parse("x")); }\n` +
      `run(function never(f) {});\n`,
  },
];

// ---------------------------------------------------------------------------
// RWF-060 -- an implicit constructor forwards its arguments to its base.
// Fail-closed negatives: the implicit constructor's own construction of an
// ambient or builtin base receives its forwarded arguments as values it
// cannot see, so it carries an unknown edge whichever export the callback
// calls (ADR 0008 § 3).
// ---------------------------------------------------------------------------

export const FORWARDED: readonly A3aCase[] = [
  {
    id: "forwarded.Promise-subclass.inline-executor",
    finding: "RWF-060",
    mechanism:
      "new P(executor), class P extends Promise {}: the implicit constructor passes the executor to Promise",
    expected: "AFFECTED",
    source: `class P extends Promise {}\nnew P(() => { lib.parse("x"); });\n`,
    negative: `class P extends Promise {}\nconst ex = () => { lib.parse("x"); };\n`,
  },
  {
    id: "forwarded.Promise-subclass.named-executor",
    finding: "RWF-060",
    mechanism: "the same, with the executor passed by name",
    expected: "AFFECTED",
    source: `class P extends Promise {}\nfunction ex() { lib.parse("x"); }\nnew P(ex);\n`,
    negative: `class P extends Promise {}\nfunction ex() { lib.parse("x"); }\n`,
  },
  {
    id: "forwarded.Promise-subclass.two-levels",
    finding: "RWF-060",
    mechanism:
      "the implicit-constructor chain crosses a second derived class with no constructor",
    expected: "AFFECTED",
    source: `class P extends Promise {}\nclass Q extends P {}\nnew Q(() => { lib.parse("x"); });\n`,
    negative: `class P extends Promise {}\nclass Q extends P {}\nconst ex = () => { lib.parse("x"); };\n`,
  },
  {
    id: "forwarded.Readable-subclass.require-member",
    finding: "RWF-060",
    mechanism:
      "class R extends require('stream').Readable {}: new R({ read }) hands read to Readable",
    expected: "UNKNOWN",
    source:
      `class R extends require("stream").Readable {}\n` +
      `new R({ read() { lib.parse("x"); } }).resume();\n`,
    negative:
      `class R extends require("stream").Readable {}\n` +
      `const opts = { read() { lib.parse("x"); } };\n`,
  },
];

// ---------------------------------------------------------------------------
// PRM-37 (A-1 status update) -- Reflect.construct reaches the constructor
// ---------------------------------------------------------------------------

export const CONSTRUCTED: readonly A3aCase[] = [
  hooked(
    {
      id: "constructed.Reflect.construct.field-initializer",
      finding: "PRM-37",
      mechanism:
        "Reflect.construct(A, []) runs A's instance field initializers (a tagged template)",
      expected: "AFFECTED",
    },
    (fn) =>
      `function tag(s) { return lib.${fn}(s[0]); }\n` +
      `class A { f = tag\`x\`; }\nReflect.construct(A, []);\n`,
  ),
  hooked(
    {
      id: "constructed.Reflect.construct.explicit-constructor",
      finding: "PRM-37",
      mechanism: "Reflect.construct(A, []) runs A's explicit constructor",
      expected: "AFFECTED",
    },
    (fn) =>
      `class A { constructor() { lib.${fn}("x"); } }\nReflect.construct(A, []);\n`,
  ),
];

export const ALL_CASES: readonly A3aCase[] = [
  ...INVOKING,
  ...ESCAPED,
  ...ASSIGNED,
  ...IDENTITY,
  ...FORWARDED,
  ...CONSTRUCTED,
];
