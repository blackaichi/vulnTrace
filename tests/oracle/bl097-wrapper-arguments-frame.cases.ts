import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";
import {
  type Bl092Case,
  oracleCase as bl092OracleCase,
} from "./bl092-loader-capability-routes.cases.js";

/**
 * Task BL-097 (docs/tasks/BL-097-wrapper-arguments-frame.md): the CommonJS
 * wrapper's `arguments` reached through a function's frame (RWF-137),
 * against real Node.
 *
 * A sloppy function called from module scope has the module wrapper --
 * `function (exports, require, module, __filename, __dirname)` -- as its
 * `caller`, and a function's own `arguments` property, read while it runs,
 * is its arguments object: `g.caller.arguments[2]` is `module` and
 * `[1]` is `require`, with neither spelled. V8's call sites reach the same
 * frame (`getFunction()` is the wrapper, `getThis()` its `this`).
 *
 * THE SETUP is BL-092's (its cases file, whose builder this reuses):
 * `wrap` carries a decoy `vuln-lib@99.0.0` and ends with
 * `require("vuln-lib/index.js").parse("x")`; each case adds statements
 * before that load that make Node load the affected top-level
 * `vuln-lib@1.0.0` instead. The loud fixture and both controls are
 * BL-092's.
 *
 * Measured on the base (`670a839`, BL-095's merge), before the fix: see
 * each case's `base`.
 */

export {
  ADVISORY_ID,
  TARGET_MARKER,
} from "./bl092-loader-capability-routes.cases.js";

export interface Bl097Case extends Bl092Case {
  /**
   * A case BL-097 leaves open: the wrong result the analyzer gives today,
   * held as an open-soundness-defect record, never as an expectation.
   */
  readonly openDefect?: {
    readonly rwf: string;
    readonly observed: VerdictObservation;
  };
}

export const oracleCase = bl092OracleCase;

/** The top-level `vuln-lib`'s `index.js`, an absolute path computed in `wrap`. */
const REAL_PATH = `require("path").join(__dirname, "..", "vuln-lib", "index.js")`;

/**
 * Where the running V8 keeps a sloppy function's `caller` (measured in
 * BL-097 on Node v22.11.0 and v26.12.0). On Node 22 (and Node 20, by CI; Node 24 not measured) it is an own data
 * property of the function (own keys `length`, `name`, `arguments`,
 * `caller`, `prototype`), and `Function.prototype`'s `caller` getter
 * throws for it; on Node 26 the function has no such own property, and
 * that getter returns the caller. `g.caller` reaches the frame on both.
 * The oracle runs the `node` on `PATH`, the same one that runs this file,
 * so a case whose route exists in one layout only states its ground truth
 * from this probe. `Function` builds a sloppy function, which strict code
 * here cannot declare.
 */
const SLOPPY_PROBE = Function("return function () {};")() as object;
const OWN_FRAME_PROPERTIES =
  Object.getOwnPropertyDescriptor(SLOPPY_PROBE, "caller") !== undefined;

/**
 * The enumeration route to a sloppy function's caller in the running V8,
 * by position, spelling no name: its own descriptors' value where the
 * property is its own, otherwise `Function.prototype`'s getter.
 */
const ENUMERATED_CALLER = OWN_FRAME_PROPERTIES
  ? `Object.values(Object.getOwnPropertyDescriptors(g))[${Reflect.ownKeys(SLOPPY_PROBE).indexOf("caller")}].value`
  : `Object.values(Object.getOwnPropertyDescriptors(Function.prototype))[${Reflect.ownKeys(Function.prototype).indexOf("caller")}].get.call(g)`;

/** A `_resolveFilename` replacement that sends `vuln-lib/index.js` to the top-level instance. */
const HOOK = `function (r) { return r === "vuln-lib/index.js" ? __dirname + "/../vuln-lib/index.js" : r; }`;

/**
 * What the analyzer gives for each RWF-144 case, measured in BL-097: a
 * family-B proof (the decoy `vuln-lib@99.0.0` is the instance the graph
 * discovers, and the module-load closure corroborating it is called
 * complete, because the loader classifier sees no frame read).
 */
function rwf144Observed(unknownEdges: number): VerdictObservation {
  return {
    verdict: "NOT_AFFECTED",
    proofFamily: "B",
    target: "vuln-lib#parse",
    reachableSubgraphComplete: false,
    unknownEdges,
  };
}

export const ALL_CASES: readonly Bl097Case[] = [
  // ---------------------------------------------------------------------
  // RWF-137: the three reproductions BL-092's independent audit recorded.
  // ---------------------------------------------------------------------
  {
    id: "rwf137.caller-module-paths",
    finding: "RWF-137",
    mechanism:
      "`function g() { return g.caller.arguments[2]; } g().paths.shift()`: the wrapper's `module` through `g`'s caller",
    redirect:
      `function g() { return g.caller.arguments[2]; }\n` +
      `const m = g();\n` +
      `m.paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf137.caller-require",
    finding: "RWF-137",
    mechanism:
      "`function g() { return g.caller.arguments[1]; } g()(<the top-level vuln-lib>)`: the wrapper's `require`",
    redirect:
      `function g() { return g.caller.arguments[1]; }\n` +
      `g()(${REAL_PATH}).parse("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "rwf137.caller-arguments-second-module",
    finding: "RWF-137",
    mechanism:
      "`function g() { return g.caller.arguments; } g()[2].constructor._resolveFilename = hook` in a second module of `wrap`'s",
    redirect: `require("./hook.js");\n`,
    files: {
      "node_modules/wrap/hook.js":
        `function g() { return g.caller.arguments; }\n` +
        `g()[2].constructor._resolveFilename = ${HOOK};\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // ---------------------------------------------------------------------
  // Measured beside them: the same frame, other routes.
  // ---------------------------------------------------------------------
  {
    id: "measured.reflect-get-caller",
    finding: "RWF-137",
    mechanism:
      '`Reflect.get(g, "caller").arguments[2]`: the caller read through a reflective call',
    redirect:
      `function g() { return Reflect.get(g, "caller").arguments[2]; }\n` +
      `g().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.descriptor-caller",
    finding: "RWF-137",
    mechanism:
      '`Object.getOwnPropertyDescriptor(g, "caller").value`: a sloppy function\'s own `caller` property',
    redirect:
      `function g() { return Object.getOwnPropertyDescriptor(g, "caller").value.arguments[2]; }\n` +
      `g().paths.shift();\n`,
    // Node 26 has no own `caller`: the read throws, and Node calls nothing.
    called: OWN_FRAME_PROPERTIES,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.function-prototype-caller-getter",
    finding: "RWF-137",
    mechanism:
      '`Object.getOwnPropertyDescriptor(Function.prototype, "caller").get.call(g)`: the inherited accessor, which answers on Node 26',
    redirect:
      `function g() { return Object.getOwnPropertyDescriptor(Function.prototype, "caller").get.call(g).arguments[2]; }\n` +
      `g().paths.shift();\n`,
    // On Node 20 and 22 the getter throws for a sloppy function.
    called: !OWN_FRAME_PROPERTIES,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.destructured-caller",
    finding: "RWF-137",
    mechanism:
      "`const { caller } = g; caller.arguments[2]`: the caller read by a destructuring key",
    redirect:
      `function g() { const { caller } = g; return caller.arguments[2]; }\n` +
      `g().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.callee-caller",
    finding: "RWF-137",
    mechanism:
      "`arguments.callee.caller.arguments[2]`: the function reached through its own arguments object",
    redirect:
      `function g() { return arguments.callee.caller.arguments[2]; }\n` +
      `g().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.caller-two-hops",
    finding: "RWF-137",
    mechanism:
      "`g.caller.caller.arguments[2]` with `g` called by `h`, called at module scope",
    redirect:
      `function g() { return g.caller.caller.arguments[2]; }\n` +
      `function h() { return g(); }\n` +
      `h().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.caller-stored-not-returned",
    finding: "RWF-137",
    mechanism:
      "`m = g.caller.arguments[2]` stored into a module-scope `let`, no `return`",
    redirect:
      `let m;\n` +
      `function g() { m = g.caller.arguments[2]; }\n` +
      `g();\n` +
      `m.paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.exported-function-caller",
    finding: "RWF-137",
    mechanism:
      "a second module exports `function g() { return g.caller.arguments[2]; }`; `wrap` calls it at module scope and gets its own `module`",
    redirect: `require("./frame.js").g().paths.shift();\n`,
    files: {
      "node_modules/wrap/frame.js": `exports.g = function g() { return g.caller.arguments[2]; };\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "measured.call-site-get-function",
    finding: "RWF-137",
    mechanism:
      "`Error.prepareStackTrace = (e, s) => s`; the module-scope frame's `getFunction()` is the wrapper, whose `arguments` hold `module`",
    redirect:
      `const prev = Error.prepareStackTrace;\n` +
      `Error.prepareStackTrace = (e, s) => s;\n` +
      `const frames = new Error().stack;\n` +
      `Error.prepareStackTrace = prev;\n` +
      `frames[0].getFunction().arguments[2].paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // Found by the independent audit (F-1, F-3): a name spelled where the
  // first rule did not read it.
  {
    id: "audit.with-caller",
    finding: "RWF-137",
    mechanism:
      "`with (g) { return caller.arguments[2]; }`: a bare name in a `with` body is the head's member",
    redirect:
      `function g() { with (g) { return caller.arguments[2]; } }\n` +
      `g().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.with-caller-second-module",
    finding: "RWF-137",
    mechanism:
      "`with (g) { return caller.arguments; }` in a second module of `wrap`'s, whose `module.constructor` it hooks",
    redirect: `require("./hook.js");\n`,
    files: {
      "node_modules/wrap/hook.js":
        `function g() { with (g) { return caller.arguments; } }\n` +
        `g()[2].constructor._resolveFilename = ${HOOK};\n`,
    },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.with-call-site",
    finding: "RWF-137",
    mechanism:
      "`with (frames[0]) { getFunction().arguments[2].paths.shift(); }`: a call site's member under a `with`",
    redirect:
      `const prev = Error.prepareStackTrace;\n` +
      `Error.prepareStackTrace = (e, s) => s;\n` +
      `const frames = new Error().stack;\n` +
      `Error.prepareStackTrace = prev;\n` +
      `with (frames[0]) { getFunction().arguments[2].paths.shift(); }\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  {
    id: "audit.regex-source",
    finding: "RWF-137",
    mechanism: "`g[/caller/.source]`: the name spelled as a regular expression",
    redirect:
      `function g() { return g[/caller/.source].arguments[2]; }\n` +
      `g().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  },
  // ---------------------------------------------------------------------
  // RWF-144 (open, backlog BL-080): a frame name computed at run time
  // spells no name, nor does a frame member reached by enumeration. Live false NOT_AFFECTEDs, measured in BL-097 on the
  // base and after its fix alike.
  // ---------------------------------------------------------------------
  {
    id: "rwf144.computed-caller-concatenation",
    finding: "RWF-144",
    mechanism:
      '`g["call" + "er"].arguments[2]`: the caller under a concatenated key',
    redirect:
      `function g() { return g["call" + "er"].arguments[2]; }\n` +
      `g().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-144", observed: rwf144Observed(1) },
  },
  {
    id: "rwf144.computed-caller-join",
    finding: "RWF-144",
    mechanism:
      '`Reflect.get(g, ["call", "er"].join(""))`: the caller under a key joined at run time',
    redirect:
      `function g() { return Reflect.get(g, ["call", "er"].join("")).arguments[2]; }\n` +
      `g().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-144", observed: rwf144Observed(3) },
  },
  {
    id: "rwf144.computed-caller-template",
    finding: "RWF-144",
    mechanism:
      '``g[`${a}er`]`` with `a` = `"call"`: the caller under a template key',
    redirect:
      `const a = "call";\n` +
      "function g() { return g[`${a}er`].arguments[2]; }\n" +
      `g().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-144", observed: rwf144Observed(1) },
  },
  {
    id: "rwf144.computed-call-site-get-function",
    finding: "RWF-144",
    mechanism:
      "a call site's `getFunction` under a key joined at run time: the wrapper, whose `arguments` hold `module`",
    redirect:
      `const k = ["get", "Function"].join("");\n` +
      `const prev = Error.prepareStackTrace;\n` +
      `Error.prepareStackTrace = (e, s) => s;\n` +
      `const frames = new Error().stack;\n` +
      `Error.prepareStackTrace = prev;\n` +
      `frames[0][k]().arguments[2].paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-144", observed: rwf144Observed(4) },
  },
  // Found by the independent audit (F-2): a frame member reached by
  // enumerating an object's properties, with no key at all.
  {
    id: "rwf144.enumerated-caller-descriptor",
    finding: "RWF-144",
    mechanism:
      "a sloppy function's `caller` by its position among the descriptors (its own, `Object.values(Object.getOwnPropertyDescriptors(g))[3].value`, on Node 20 and 22; `Function.prototype`'s getter on Node 26)",
    redirect:
      `function g() { return ${ENUMERATED_CALLER}.arguments[2]; }\n` +
      `g().paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: {
      rwf: "RWF-144",
      observed: rwf144Observed(OWN_FRAME_PROPERTIES ? 2 : 4),
    },
  },
  {
    id: "rwf144.enumerated-call-site-get-function",
    finding: "RWF-144",
    mechanism:
      "a call site's prototype's sixth own method (`getFunction`), by enumeration: the wrapper, whose `arguments` hold `module`",
    redirect:
      `const prev = Error.prepareStackTrace;\n` +
      `Error.prepareStackTrace = (e, s) => s;\n` +
      `const frames = new Error().stack;\n` +
      `Error.prepareStackTrace = prev;\n` +
      `Object.values(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(frames[0])))[6].value.call(frames[0]).arguments[2].paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-144", observed: rwf144Observed(6) },
  },
  // ---------------------------------------------------------------------
  // Precision: a function's own `arguments`, read by name, is not the
  // wrapper's, and stays proven.
  // ---------------------------------------------------------------------
  {
    id: "precision.own-arguments-property",
    finding: "RWF-137",
    mechanism:
      "`function g(a) { return g.arguments[0] + arguments.length; } g(1)`: a function's own arguments, by its `arguments` property and by name",
    redirect: `function g(a) { return g.arguments[0] + arguments.length; }\ng(1);\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
