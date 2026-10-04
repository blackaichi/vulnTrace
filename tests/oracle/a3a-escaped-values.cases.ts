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

export type Finding =
  "AUD-01" | "PRM-12" | "PRM-114" | "RWF-060" | "PRM-37" | "PRM-104";

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
  /**
   * Only for an UNKNOWN case: `false` when real Node never calls the
   * target, and UNKNOWN is the sound precision cost of a value that may
   * or may not be the one invoked (`setTimeout(a || b)`).
   */
  readonly realNodeCalls?: false;
  /** Further project files of the case (`src/poly.js`), and of its controls. */
  readonly extraFiles?: Readonly<Record<string, string>>;
  readonly negativeExtraFiles?: Readonly<Record<string, string>>;
}

function project(
  body: string,
  extraFiles: Readonly<Record<string, string>> = {},
): ProjectSpec {
  return {
    files: {
      ...extraFiles,
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
          project: project(
            `lib.parse("x");\n` + kase.negative,
            kase.negativeExtraFiles,
          ),
        },
        negative: {
          name: "negative-control",
          project: project(kase.negative, kase.negativeExtraFiles),
        },
      },
    },
    variant: {
      name: "case",
      project: project(kase.source, kase.extraFiles),
    },
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
      mechanism: "setInterval runs an inline callback (which ends the process)",
      expected: "AFFECTED",
    },
    (fn) => `setInterval(() => { lib.${fn}("x"); process.exit(0); }, 0);\n`,
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
    negative: `function run(setTimeout) { setTimeout(() => lib.parse("x")); }\n`,
    // Not the documented invoking builtin (the identity A-3a proves), but
    // VT-213 still gives the inline arrow a RESOLVED edge, because the
    // parameter callee is otherwise unattributable: a fabricated edge,
    // PRM-13's mechanism (task A-5). Before A-3a VT-201's spelling
    // exemption hid it for this one name; the same program with the
    // parameter named `cb` takes the same VT-213 path on the base.
    openDefect: {
      rwf: "PRM-13",
      observed: {
        verdict: "AFFECTED",
        proofFamily: "-",
        target: "vuln-lib#parse",
        reachableSubgraphComplete: false,
        unknownEdges: 0,
      },
    },
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

// ---------------------------------------------------------------------------
// Task A-3a's independent audit: the programs it broke the first version
// with, each measured against real Node. Each failed on 74b1733.
// ---------------------------------------------------------------------------

const POLY = (fn: "parse" | "safe") =>
  `const lib = require("vuln-lib");\n` +
  `const g = typeof globalThis !== "undefined" ? globalThis : global;\n` +
  `g.JSON.parse = function (s) { lib.${fn}("x"); return s; };\n`;

export const AUDITED: readonly A3aCase[] = [
  {
    id: "audit.global-object-conditional-alias",
    finding: "AUD-01",
    mechanism:
      "a builtin monkeypatched in another file through a conditional alias of the global object",
    expected: "UNKNOWN",
    source: `require("./poly");\nJSON.parse("1");\n`,
    extraFiles: { "src/poly.js": POLY("parse") },
    negative: `require("./poly");\nJSON.parse("1");\n`,
    negativeExtraFiles: { "src/poly.js": POLY("safe") },
  },
  {
    id: "audit.destructuring-assignment-replaces-global",
    finding: "AUD-01",
    mechanism:
      "a destructuring assignment replaces setTimeout; the call runs the program's function",
    expected: "UNKNOWN",
    source:
      `({ setTimeout } = { setTimeout: (cb) => { lib.parse("x"); } });\n` +
      `setTimeout(1);\n`,
    negative: `const unused = 1;\n`,
  },
  {
    id: "audit.for-of-head-replaces-global",
    finding: "AUD-01",
    mechanism: "a for-of head replaces setTimeout",
    expected: "UNKNOWN",
    source:
      `for (setTimeout of [(cb) => { lib.parse("x"); }]) {}\n` +
      `setTimeout(1);\n`,
    negative: `const unused = 1;\n`,
  },
  {
    id: "audit.with-statement",
    finding: "AUD-01",
    mechanism: "inside a with body, setTimeout is a property of its object",
    expected: "UNKNOWN",
    source:
      `const o = { setTimeout(cb) { lib.parse("x"); } };\n` +
      `with (o) { setTimeout(1); }\n`,
    negative: `const o = { setTimeout(cb) { lib.parse("x"); } };\n`,
  },
  hooked(
    {
      id: "audit.logical-operator-at-invoking-position",
      finding: "AUD-01",
      mechanism:
        "setTimeout(a || b): either may be invoked, neither is the one -- possible, never resolved",
      expected: "UNKNOWN",
      realNodeCalls: false,
    },
    (fn) =>
      `function a() { lib.safe("x"); }\nfunction b() { lib.${fn}("x"); }\nsetTimeout(a || b, 0);\n`,
  ),
  hooked(
    {
      id: "audit.conditional-at-construct-position",
      finding: "AUD-01",
      mechanism: "Reflect.construct(c ? B : A, []): possible, never resolved",
      expected: "UNKNOWN",
      realNodeCalls: false,
    },
    (fn) =>
      `class A { constructor() { lib.safe("x"); } }\n` +
      `class B { constructor() { lib.${fn}("x"); } }\n` +
      `Reflect.construct(Math.random() > 2 ? B : A, []);\n`,
  ),
  {
    id: "audit.fs.existsSync-url-shaped-argument",
    finding: "AUD-01",
    mechanism:
      "fs.existsSync converts a URL-shaped object with fileURLToPath, coercing pathname with toString",
    expected: "UNKNOWN",
    source:
      `const fs = require("fs");\n` +
      `const u = { href: "file:///x", protocol: "file:", hostname: "", pathname: { length: 0, toString() { lib.parse("x"); return "/no-such-file"; } } };\n` +
      `fs.existsSync(u);\n`,
    // Since task A-4 the `toString` definition is itself a protocol member,
    // reached by a possible edge from the module whatever reads it; the
    // negative control keeps the definition, calling `safe` from it, and
    // drops the trigger.
    negative: `const u = { href: "file:///x", protocol: "file:", hostname: "", pathname: { length: 0, toString() { lib.safe("x"); return "/no-such-file"; } } };\n`,
  },
  {
    id: "audit.reassigned-function-declaration",
    finding: "PRM-104",
    mechanism:
      "a function declaration reassigned before it escapes: the stale body is not the value invoked",
    expected: "UNKNOWN",
    source:
      `function cb() { lib.safe("x"); }\n` +
      `cb = function () { lib.parse("x"); };\nsetTimeout(cb, 0);\n`,
    negative:
      `function cb() { lib.safe("x"); }\n` +
      `cb = function () { lib.parse("x"); };\n`,
  },
  {
    id: "audit.destructured-setTimeout-never-calls",
    finding: "AUD-01",
    mechanism:
      "a destructuring assignment replaces setTimeout with a function that never calls its argument",
    expected: "NOT_AFFECTED",
    source:
      `({ setTimeout } = { setTimeout: () => {} });\n` +
      `setTimeout(() => lib.parse("x"), 0);\n`,
    negative: `({ setTimeout } = { setTimeout: () => {} });\n`,
    // No longer the documented invoking builtin; but the callee is now
    // unattributable, and VT-213 gives the one inline callback a RESOLVED
    // edge: PRM-13's fabricated edge, as for a parameter named setTimeout.
    openDefect: {
      rwf: "PRM-13",
      observed: {
        verdict: "AFFECTED",
        proofFamily: "-",
        target: "vuln-lib#parse",
        reachableSubgraphComplete: false,
        unknownEdges: 0,
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Task A-3a's second independent audit: each failed on e6dfd21.
// ---------------------------------------------------------------------------

const PATCH_PATH = (fn: "parse" | "safe") =>
  `const lib = require("vuln-lib");\n` +
  `function patch(m) { m.join = function () { lib.${fn}("x"); return ""; }; }\n` +
  `patch(require("path"));\n`;

export const REAUDITED: readonly A3aCase[] = [
  {
    id: "reaudit.require-member-callee-patched-through-parameter",
    finding: "AUD-01",
    mechanism:
      "require('path').join, patched through a parameter in another file: not trusted as the builtin",
    expected: "UNKNOWN",
    source: `require("./poly");\nrequire("path").join("a");\n`,
    extraFiles: { "src/poly.js": PATCH_PATH("parse") },
    negative: `const unused = 1;\n`,
  },
  hooked(
    {
      id: "reaudit.tagged-template-positions",
      finding: "AUD-01",
      mechanism:
        "setTimeout`${f}` hands f to position 1, not to the invoked position 0",
      expected: "UNKNOWN",
      realNodeCalls: false,
    },
    (fn) =>
      `function f() { lib.${fn}("x"); }\ntry { setTimeout\`\${f}\`; } catch (e) {}\n`,
  ),
  {
    id: "reaudit.reassigned-declaration-through-alias",
    finding: "PRM-104",
    mechanism:
      "a const alias of a reassigned function declaration escapes: not the stale body",
    expected: "UNKNOWN",
    source:
      `function cb() { lib.safe("x"); }\n` +
      `cb = function () { lib.parse("x"); };\nconst a = cb;\nsetTimeout(a, 0);\n`,
    negative:
      `function cb() { lib.safe("x"); }\n` +
      `cb = function () { lib.parse("x"); };\nconst a = cb;\n`,
  },
  {
    id: "reaudit.builtin-written-over-builtin",
    finding: "AUD-01",
    mechanism:
      "Array.isArray = setTimeout: a builtin's own function stored over another is an escape",
    expected: "UNKNOWN",
    source:
      `Array.isArray = setTimeout;\n` +
      `const obj = { m() { lib.parse("x"); } };\nArray.isArray(obj.m, 0);\n`,
    negative: `const obj = { m() { lib.parse("x"); } };\n`,
  },
  {
    id: "reaudit.builtin-module-const-alias",
    finding: "AUD-01",
    mechanism:
      "a write through a const alias of a require binding patches the builtin module",
    expected: "UNKNOWN",
    source:
      `const p = require("path");\nconst q = p;\n` +
      `q.join = function () { lib.parse("x"); return ""; };\np.join("a");\n`,
    negative: `const p = require("path");\n`,
  },
  {
    id: "reaudit.getter-returns-invoked-function",
    finding: "AUD-01",
    mechanism:
      "an object-literal getter returns the function the builtin invokes (a thenable's then)",
    expected: "UNKNOWN",
    source: `Promise.resolve({ get then() { return (r) => { lib.parse("x"); r(1); }; } });\n`,
    negative: `const unused = 1;\n`,
  },
  {
    id: "reaudit.global-object-member-replaces-invoking-builtin",
    finding: "AUD-01",
    mechanism:
      "globalThis.setTimeout = stub in the same file: setTimeout is no longer the documented invoking builtin",
    expected: "NOT_AFFECTED",
    source:
      `globalThis.setTimeout = () => 0;\n` +
      `setTimeout(() => lib.parse("x"), 0);\n`,
    negative: `globalThis.setTimeout = () => 0;\n`,
    // No longer the builtin; but the callee is then unattributable and
    // VT-213 gives the one inline callback a RESOLVED edge (PRM-13).
    openDefect: {
      rwf: "PRM-13",
      observed: {
        verdict: "AFFECTED",
        proofFamily: "-",
        target: "vuln-lib#parse",
        reachableSubgraphComplete: false,
        unknownEdges: 0,
      },
    },
  },
];

// Task A-3a's third audit round: each was a false NOT_AFFECTED on 438cf21.
const POISONED = (fn: "parse" | "safe") =>
  `const lib = require("vuln-lib");\nif (false) { Math = 0; }\n` +
  `Math.max = function () { lib.${fn}("x"); return 0; };\n`;

export const AUDITED_THIRD: readonly A3aCase[] = [
  {
    id: "audit3.bare-name-write-does-not-hide-member-write",
    finding: "AUD-01",
    mechanism:
      "a file that also assigns Math's bare name still escapes its Math.max = f",
    expected: "UNKNOWN",
    source: `require("./poly");\nMath.max(1, 2);\n`,
    extraFiles: { "src/poly.js": POISONED("parse") },
    negative: `require("./poly");\nMath.max(1, 2);\n`,
    negativeExtraFiles: { "src/poly.js": POISONED("safe") },
  },
  {
    id: "audit3.builtin-value-handed-to-mutating-builtin",
    finding: "AUD-01",
    mechanism:
      "Object.assign(Array, { isArray: setTimeout }) replaces Array.isArray with an invoker",
    expected: "UNKNOWN",
    source:
      `Object.assign(Array, { isArray: setTimeout });\n` +
      `const obj = { m() { lib.parse("x"); } };\nArray.isArray(obj.m, 0);\n`,
    negative: `const obj = { m() { lib.parse("x"); } };\n`,
  },
];

/** The task's own reproductions (`a3a-escaped-values.test.ts`). */
export const TASK_CASES: readonly A3aCase[] = [
  ...INVOKING,
  ...ESCAPED,
  ...ASSIGNED,
  ...IDENTITY,
  ...FORWARDED,
  ...CONSTRUCTED,
];

/** The independent audit's three rounds (`a3a-escaped-values.audit.test.ts`). */
export const AUDIT_CASES: readonly A3aCase[] = [
  ...AUDITED,
  ...REAUDITED,
  ...AUDITED_THIRD,
];

export const ALL_CASES: readonly A3aCase[] = [...TASK_CASES, ...AUDIT_CASES];
