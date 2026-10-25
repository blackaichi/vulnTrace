import type { OracleCase } from "../../src/testing/oracle/case.js";
import type { VerdictObservation } from "../../src/testing/open-soundness-defect.js";
import {
  type Bl092Case,
  oracleCase as bl092OracleCase,
} from "./bl092-loader-capability-routes.cases.js";

/**
 * Task BL-096 (docs/tasks/BL-096-module-paths-read-only-exemptions.md):
 * the loader classifier's read-only exemptions for a `Module` instance's
 * lookup list (`module.paths`), against real Node -- RWF-136 (each assumes
 * Node's own `Array.prototype`) and the routes of the same exemptions this
 * task measured beside it.
 *
 * THE SETUP is BL-092's (see its cases file): `wrap` carries a decoy
 * `wrap/node_modules/vuln-lib@99.0.0`, and `wrap/index.js` ends with
 * `require("vuln-lib/index.js").parse("x")`. Each case adds statements
 * before that load: a TAMPER, which installs user code Node runs with the
 * list as `this` or as an argument, and a USE of the list the classifier
 * exempts as read-only. The tamper's code calls {@link DROP}, which drops
 * the list's first directory (`wrap/node_modules`) when it is handed
 * `wrap`'s own list, so Node loads the affected top-level `vuln-lib@1.0.0`
 * and calls `parse`.
 *
 * Measured on the base (`904d032`, BL-109's merge) with real Node
 * v22.11.0: see each case's `base`. Each case asserts the sound verdict;
 * a case this decision task leaves open is an open-soundness-defect record
 * (`openDefect`), never an expectation.
 */

export {
  ADVISORY_ID,
  TARGET_MARKER,
} from "./bl092-loader-capability-routes.cases.js";

export interface Bl096Case extends Bl092Case {
  /** The entry's source, when the case's tamper runs there. */
  readonly entry?: string;
  /**
   * A case BL-096 leaves open: the wrong result the analyzer gives today,
   * held as an open-soundness-defect record, never as an expectation.
   */
  readonly openDefect?: {
    readonly rwf: string;
    readonly observed: VerdictObservation;
  };
}

const ENTRY = "src/index.js";

export function oracleCase(kase: Bl096Case): OracleCase {
  const base = bl092OracleCase(kase);
  if (kase.entry === undefined) {
    return base;
  }
  return {
    ...base,
    variant: {
      ...base.variant,
      project: {
        ...base.variant.project,
        files: { ...base.variant.project.files, [ENTRY]: kase.entry },
      },
    },
  };
}

/**
 * Drops the first directory of `a` when `a` is `wrap`'s own lookup list:
 * an array whose first entry is `wrap`'s `node_modules`. Reads only an own
 * element and calls `Array.prototype.shift`, which no case replaces.
 */
const DROP =
  `function __drop(a) {\n` +
  `  if (Array.isArray(a) && typeof a[0] === "string" && a[0].endsWith("/wrap/node_modules")) a.shift();\n` +
  `}\n`;

/** `Array.prototype.<m>` replaced by a function that drops its receiver's first directory. */
function replaceArrayMethod(m: string, base = "Array.prototype"): string {
  return (
    DROP +
    `const __o = ${base}.${m};\n` +
    `${base}.${m} = function (...a) { __drop(this); return __o.apply(this, a); };\n`
  );
}

const ALIAS = `const p = module.paths;\n`;

/**
 * `const m0 = module; const m1 = m0; … const m45 = m44;`: a chain past the
 * classifier's alias depth budget, which resolves to `ambiguous`.
 */
const DEEP_MODULE_CHAIN =
  `const m0 = module;\n` +
  Array.from({ length: 45 }, (_, i) => `const m${i + 1} = m${i};\n`).join("");

/**
 * What the analyzer gives on the base for a case it misses, measured in
 * BL-096: a family-B proof -- the decoy `vuln-lib@99.0.0` is the instance
 * the graph discovers, and the module-load closure corroborating it is
 * called complete, because the classifier takes the use for read-only.
 * `unknownEdges` is the scan's dynamic-call count, which differs by case.
 */
function familyB(unknownEdges: number): VerdictObservation {
  return {
    verdict: "NOT_AFFECTED",
    proofFamily: "B",
    target: "vuln-lib#parse",
    reachableSubgraphComplete: false,
    unknownEdges,
  };
}

export const ALL_CASES: readonly Bl096Case[] = [
  // ---------------------------------------------------------------------
  // RWF-136: the three reproductions BL-092's independent audit recorded.
  // ---------------------------------------------------------------------
  {
    id: "rwf136.includes-replaced",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.includes` replaced, then `p.includes(x)` on an alias of the list: the replacement runs with the list as `this`",
    redirect: replaceArrayMethod("includes") + ALIAS + `p.includes("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "rwf136.iterator-replaced",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype[Symbol.iterator]` replaced, then `for (const d of module.paths)`: the replacement runs with the list as `this`",
    redirect:
      DROP +
      `const __o = Array.prototype[Symbol.iterator];\n` +
      `Array.prototype[Symbol.iterator] = function () { __drop(this); return __o.call(this); };\n` +
      `for (const d of module.paths) {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "rwf136.join-replaced-template",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.join` replaced, then `` `${module.paths}` ``: the primitive conversion runs `toString`, which runs the replaced `join` with the list as `this`",
    redirect: replaceArrayMethod("join") + "`${module.paths}`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  // ---------------------------------------------------------------------
  // The same exemptions, reached by routes RWF-136's record does not name.
  // ---------------------------------------------------------------------
  {
    id: "measured.includes-spelled",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.includes` replaced, then the spelled `module.paths.includes(x)`: a method call rooted in `module` is the call graph's `loader_capability_escape` on the base already (BL-092)",
    redirect: replaceArrayMethod("includes") + `module.paths.includes("x");\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  {
    id: "measured.tamper-in-sibling-file",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.includes` replaced in another file of `wrap` it loads first, then `p.includes(x)`: the tamper and the use are in different files",
    redirect: `require("./poly.js");\n` + ALIAS + `p.includes("x");\n`,
    files: { "node_modules/wrap/poly.js": replaceArrayMethod("includes") },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "measured.tamper-in-entry",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.includes` replaced by the application's entry before it loads `wrap`, then `p.includes(x)` in `wrap`",
    redirect: ALIAS + `p.includes("x");\n`,
    entry: replaceArrayMethod("includes") + `require("wrap");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "measured.tamper-unspelled-prototype",
    finding: "RWF-136",
    mechanism:
      "`Object.getPrototypeOf([]).includes` replaced -- `Array.prototype` reached without its name -- then `p.includes(x)`",
    redirect:
      replaceArrayMethod("includes", "Object.getPrototypeOf([])") +
      ALIAS +
      `p.includes("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "measured.method-accessor",
    finding: "RWF-136",
    mechanism:
      "`includes` redefined as an accessor on `Array.prototype`: reading the method off the list runs its getter with the list as `this`",
    redirect:
      DROP +
      `const __o = Array.prototype.includes;\n` +
      `Object.defineProperty(Array.prototype, "includes", { configurable: true, get() { __drop(this); return __o; } });\n` +
      ALIAS +
      `p.includes("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "measured.slice-constructor-getter",
    finding: "RWF-136",
    mechanism:
      "a `constructor` accessor on `Array.prototype`, then `p.slice()`: the species lookup reads `constructor` on the list, running the getter with the list as `this`",
    redirect:
      DROP +
      `Object.defineProperty(Array.prototype, "constructor", { configurable: true, get() { __drop(this); return Array; } });\n` +
      ALIAS +
      `p.slice();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "measured.named-member-getter",
    finding: "RWF-136",
    mechanism:
      "a getter for `foo` on `Object.prototype`, then the read `module.paths.foo`: a member the list does not own runs the inherited getter with the list as `this`",
    redirect:
      DROP +
      `Object.defineProperty(Object.prototype, "foo", { configurable: true, get() { __drop(this); } });\n` +
      `module.paths.foo;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "measured.non-own-index-getter",
    finding: "RWF-136",
    mechanism:
      "a getter for index `77777` on `Object.prototype`, then the element read `module.paths[77777]`: an index the list does not own is an inherited lookup",
    redirect:
      DROP +
      `Object.defineProperty(Object.prototype, "77777", { configurable: true, get() { __drop(this); } });\n` +
      `module.paths[77777];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "measured.proxy-parent-index",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype`'s [[Prototype]] set to a Proxy, then `module.paths[77777]`: the Proxy's `get` trap receives the list as its receiver",
    redirect:
      DROP +
      `Object.setPrototypeOf(Array.prototype, new Proxy(Object.prototype, { get(t, k, r) { __drop(r); return Reflect.get(t, k, r); } }));\n` +
      `module.paths[77777];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(8) },
  },
  {
    id: "measured.to-primitive-plus",
    finding: "RWF-136",
    mechanism:
      '`Array.prototype[Symbol.toPrimitive]` defined, then `module.paths + ""`: the conversion calls it with the list as `this`',
    redirect:
      DROP +
      `Array.prototype[Symbol.toPrimitive] = function () { __drop(this); return ""; };\n` +
      `module.paths + "";\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "measured.in-left-to-string",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.toString` replaced, then `module.paths in {}`: the key conversion calls it with the list as `this`",
    redirect: replaceArrayMethod("toString") + `(module.paths in {});\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "measured.property-key-to-string",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.toString` replaced, then `({})[module.paths]`: the list as a property key is converted, which calls it with the list as `this`",
    redirect: replaceArrayMethod("toString") + `({})[module.paths];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "measured.await-then-getter",
    finding: "RWF-136",
    mechanism:
      "a `then` getter on `Object.prototype`, then `await module.paths`: resolving the awaited value reads `then` on the list, synchronously, with the list as `this`",
    redirect:
      DROP +
      `Object.defineProperty(Object.prototype, "then", { configurable: true, get() { __drop(this); } });\n` +
      `(async () => { await module.paths; })();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "measured.instanceof-right-has-instance-getter",
    finding: "RWF-136",
    mechanism:
      "a `Symbol.hasInstance` getter on `Object.prototype`, then `x instanceof module.paths`: the operator reads `Symbol.hasInstance` on the list, with the list as `this`",
    redirect:
      DROP +
      `Object.defineProperty(Object.prototype, Symbol.hasInstance, { configurable: true, get() { __drop(this); } });\n` +
      `try { ({}) instanceof module.paths; } catch {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(5) },
  },
  // Builtin stores no assignment spells: option (a) must see each one to
  // keep its exemptions sound.
  {
    id: "measured.aliased-define-property",
    finding: "RWF-136",
    mechanism:
      '`const d = Object.defineProperty; d(Array.prototype, "includes", …)` installs a replacement through an alias of the storing builtin, then `p.includes(x)`',
    redirect:
      DROP +
      `const __o = Array.prototype.includes;\n` +
      `const d = Object.defineProperty;\n` +
      `d(Array.prototype, "includes", { configurable: true, writable: true, value: function (...a) { __drop(this); return __o.apply(this, a); } });\n` +
      ALIAS +
      `p.includes("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(5) },
  },
  {
    id: "measured.reflect-apply-define-property",
    finding: "RWF-136",
    mechanism:
      '`Reflect.apply(Object.defineProperty, null, [Array.prototype, "includes", …])` installs a replacement with no call of the storing builtin, then `p.includes(x)`',
    redirect:
      DROP +
      `const __o = Array.prototype.includes;\n` +
      `Reflect.apply(Object.defineProperty, null, [Array.prototype, "includes", { configurable: true, writable: true, value: function (...a) { __drop(this); return __o.apply(this, a); } }]);\n` +
      ALIAS +
      `p.includes("x");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(6) },
  },
  {
    id: "measured.instanceof-has-instance",
    finding: "RWF-154",
    mechanism:
      "`module.paths instanceof H` with a class `H` of this file declaring `static [Symbol.hasInstance](v)`: the list is handed to user code, with no builtin replaced",
    redirect:
      DROP +
      `class H { static [Symbol.hasInstance](v) { __drop(v); return false; } }\n` +
      `module.paths instanceof H;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-154", observed: familyB(2) },
  },
  // ---------------------------------------------------------------------
  // Found by BL-096's independent audit (round 1): uses the first (b1)
  // prototype, a list of fail-closed forms, let through.
  // ---------------------------------------------------------------------
  {
    id: "audit.spread-iterator-replaced",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype[Symbol.iterator]` replaced, then `[...module.paths]`: a spread runs the iterator with the list as `this`",
    redirect:
      DROP +
      `const __o = Array.prototype[Symbol.iterator];\n` +
      `Array.prototype[Symbol.iterator] = function () { __drop(this); return __o.call(this); };\n` +
      `[...module.paths];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "audit.spread-conditional-branch",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype[Symbol.iterator]` replaced, then `[...(c ? module.paths : [])]`: the list selected by a conditional, then spread",
    redirect:
      DROP +
      `const __o = Array.prototype[Symbol.iterator];\n` +
      `Array.prototype[Symbol.iterator] = function () { __drop(this); return __o.call(this); };\n` +
      `[...(Math.random() < 2 ? module.paths : [])];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "audit.increment-const-alias",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.toString` replaced, then `p++` on a `const` alias of the list: `ToNumeric` converts the list before the `const` assignment throws",
    redirect:
      replaceArrayMethod("toString") + ALIAS + `try { p++; } catch (e) {}\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "audit.array-literal-converted",
    finding: "RWF-136",
    mechanism:
      '`Array.prototype.join` replaced, then `[module.paths] + ""`: converting the outer array converts the list, which runs the replaced `join` with the list as `this`',
    redirect: replaceArrayMethod("join") + `[module.paths] + "";\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "audit.array-literal-key",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.join` replaced, then `({})[[module.paths]]`: the outer array as a property key converts the list",
    redirect: replaceArrayMethod("join") + `({})[[module.paths]];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "audit.array-element-shift",
    finding: "PRM-105",
    mechanism:
      "`[module.paths][0].shift()`, no tamper: the list held in an array literal and read back on the spot is mutated (PRM-105's `[x][0]`)",
    redirect: `[module.paths][0].shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "PRM-105", observed: familyB(1) },
  },
  {
    id: "audit.array-for-each-shift",
    finding: "PRM-105",
    mechanism:
      "`[module.paths].forEach((l) => l.shift())`, no tamper: the list held in an array literal is handed to a callback that mutates it",
    redirect: `[module.paths].forEach((l) => l.shift());\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "PRM-105", observed: familyB(1) },
  },
  {
    id: "audit.shorthand-property-shift",
    finding: "RWF-155",
    mechanism:
      "`const p = module.paths; ({ p }).p.shift()`, no tamper: a shorthand property holds the list, and is no consumed position",
    redirect: ALIAS + `({ p }).p.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-155", observed: familyB(1) },
  },
  {
    id: "audit.property-assignment-shift",
    finding: "RWF-155",
    mechanism:
      "`({ l: module.paths }).l.shift()`, no tamper: a property assignment's value is a consumed position, so the base already fails closed (the shorthand's control)",
    redirect: `({ l: module.paths }).l.shift();\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  },
  // ---------------------------------------------------------------------
  // Found by BL-096's independent audit (round 2).
  // ---------------------------------------------------------------------
  {
    id: "audit2.alias-conditional-other-capability",
    finding: "RWF-157",
    mechanism:
      "`const p = c ? require : module.paths; p.shift()`, no tamper: the alias may hold either value, and is resolved to the first capability only",
    redirect: `const p = Math.random() > 2 ? require : module.paths;\np.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-157", observed: familyB(1) },
  },
  {
    id: "audit2.alias-logical-other-capability",
    finding: "RWF-157",
    mechanism:
      "`const p = (c && require) || module.paths; p.shift()`, no tamper: the same, through `&&` and `||`",
    redirect: `const p = (Math.random() > 2 && require) || module.paths;\np.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-157", observed: familyB(1) },
  },
  {
    id: "audit2.alias-conditional-spread",
    finding: "RWF-157",
    mechanism:
      "`Array.prototype[Symbol.iterator]` replaced, then `[...p]` with `const p = c ? Function : module.paths`",
    redirect:
      DROP +
      `const __o = Array.prototype[Symbol.iterator];\n` +
      `Array.prototype[Symbol.iterator] = function () { __drop(this); return __o.call(this); };\n` +
      `const p = Math.random() > 2 ? Function : module.paths;\n` +
      `[...p];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-157", observed: familyB(4) },
  },
  {
    id: "audit2.alias-name-collision",
    finding: "PRM-22",
    mechanism:
      "`function f() { const p = []; } const p = module.paths; p.shift()`, no tamper: the alias lookup is by name and finds the other `p` first",
    redirect: `function f() { const p = []; return p; }\nconst p = module.paths;\np.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "PRM-22", observed: familyB(1) },
  },
  {
    id: "audit2.computed-key-in-array",
    finding: "PRM-105",
    mechanism:
      '`[module["pa" + "ths"]][0].shift()`, no tamper: a computed key into the `Module` instance, held in an array literal',
    redirect: `[module["pa" + "ths"]][0].shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "PRM-105", observed: familyB(1) },
  },
  // No use of the list at all: a tampered builtin receives the lookup
  // state from Node's own loader. No per-use rule sees these (RWF-156).
  {
    id: "audit2.index-setters-loader-unshift",
    finding: "RWF-156",
    mechanism:
      "setters for indices 0..39 on `Object.prototype`: `Module._resolveLookupPaths`'s `unshift` sets them on its combined lookup array, which the setter drops from",
    redirect:
      DROP +
      `for (let i = 0; i < 40; i++) Object.defineProperty(Object.prototype, String(i), { configurable: true, set(v) { __drop(this); Object.defineProperty(this, String(i), { value: v, writable: true, enumerable: true, configurable: true }); } });\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-156", observed: familyB(6) },
  },
  {
    id: "audit2.proxy-parent-set-trap",
    finding: "RWF-156",
    mechanism:
      "`Array.prototype`'s [[Prototype]] a Proxy with a `set` trap: the loader's own array writes reach it with the lookup array as receiver",
    redirect:
      DROP +
      `Object.setPrototypeOf(Array.prototype, new Proxy(Object.prototype, { set(t, k, v, r) { __drop(r); return Reflect.set(t, k, v, r); } }));\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-156", observed: familyB(9) },
  },
  {
    id: "audit2.paths-setter-in-entry",
    finding: "RWF-156",
    mechanism:
      "a `paths` setter on `Object.prototype`, installed by the entry before it loads `wrap`: `Module.prototype.load`'s `this.paths = …` hands `wrap`'s new list to it",
    redirect: ``,
    entry:
      DROP +
      `Object.defineProperty(Object.prototype, "paths", { configurable: true, set(v) { __drop(v); Object.defineProperty(this, "paths", { value: v, writable: true, enumerable: true, configurable: true }); } });\n` +
      `require("wrap");\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-156", observed: familyB(5) },
  },
  // ---------------------------------------------------------------------
  // Found by BL-096's independent audit (round 3): routes to the list that
  // `resolveLoaderCapability` answers `ambiguous` for.
  // ---------------------------------------------------------------------
  {
    id: "audit3.cache-entry-template",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.join` replaced, then `` `${require.cache[__filename].paths}` ``: the list through the module cache, a computed key",
    redirect:
      replaceArrayMethod("join") + "`${require.cache[__filename].paths}`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "audit3.cache-entry-spread",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype[Symbol.iterator]` replaced, then `[...require.cache[__filename].paths]`",
    redirect:
      DROP +
      `const __o = Array.prototype[Symbol.iterator];\n` +
      `Array.prototype[Symbol.iterator] = function () { __drop(this); return __o.call(this); };\n` +
      `[...require.cache[__filename].paths];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "audit3.cache-entry-alias-literal-key",
    finding: "RWF-136",
    mechanism:
      '`Array.prototype.join` replaced, then `const mm = require.cache[__filename]; mm["paths"] + ""`',
    redirect:
      replaceArrayMethod("join") +
      `const mm = require.cache[__filename];\n` +
      `mm["paths"] + "";\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "audit3.constructor-cache-template",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.join` replaced, then `` `${module.constructor._cache[__filename].paths}` ``",
    redirect:
      replaceArrayMethod("join") +
      "`${module.constructor._cache[__filename].paths}`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "audit3.deep-alias-chain-template",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype.join` replaced, then `` `${m45.paths}` `` with `m45` a `const` alias chain of `module` past the resolver's depth budget",
    redirect:
      replaceArrayMethod("join") + DEEP_MODULE_CHAIN + "`${m45.paths}`;\n",
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(3) },
  },
  {
    id: "audit3.deep-list-alias-spread",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype[Symbol.iterator]` replaced, then `[...q45]` with `q45` a `const` alias chain of `module.paths` past the depth budget: the chain breaks at a declaration whose name no longer resolves to the list",
    redirect:
      DROP +
      `const __o = Array.prototype[Symbol.iterator];\n` +
      `Array.prototype[Symbol.iterator] = function () { __drop(this); return __o.call(this); };\n` +
      `const q0 = module.paths;\n` +
      Array.from({ length: 45 }, (_, i) => `const q${i + 1} = q${i};\n`).join(
        "",
      ) +
      `[...q45];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-136", observed: familyB(4) },
  },
  {
    id: "audit3.cache-entry-array-shift",
    finding: "PRM-105",
    mechanism: "`[require.cache[__filename].paths][0].shift()`, no tamper",
    redirect: `[require.cache[__filename].paths][0].shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "PRM-105", observed: familyB(1) },
  },
  {
    id: "audit3.deep-alias-array-shift",
    finding: "PRM-105",
    mechanism:
      "`[m45.paths][0].shift()` with `m45` an alias chain of `module` past the depth budget, no tamper",
    redirect: DEEP_MODULE_CHAIN + `[m45.paths][0].shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "PRM-105", observed: familyB(1) },
  },
  {
    id: "audit3.cache-entry-shorthand-shift",
    finding: "RWF-155",
    mechanism:
      "`const paths = require.cache[__filename].paths; ({ paths }).paths.shift()`, no tamper",
    redirect:
      `const paths = require.cache[__filename].paths;\n` +
      `({ paths }).paths.shift();\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-155", observed: familyB(1) },
  },
  {
    id: "audit3.species-constructor-store",
    finding: "RWF-156",
    mechanism:
      "`Array.prototype.constructor = C` with a species returning a Proxy, no use of the list: the loader's `ArrayPrototypeSlice` of the lookup paths honours the species, and its `unshift` writes `wrap`'s directories into the Proxy",
    redirect:
      `class C { static get [Symbol.species]() { return function () { return new Proxy([], { set(t, k, v) { if (typeof v === "string" && v.endsWith("/wrap/node_modules")) v = "/nonexistent"; t[k] = v; return true; } }); }; } }\n` +
      `Array.prototype.constructor = C;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-156", observed: familyB(3) },
  },
  // Found by BL-096's independent audit (round 4, CERTIFIED): RWF-156's
  // class reaches the loader's registries, through Node's own plain stores.
  {
    id: "audit4.extensions-setter-registry",
    finding: "RWF-156",
    mechanism:
      "an `extensions` setter on `Object.prototype`: `makeRequireFunction`'s `require.extensions = Module._extensions` hands the registry to it, which replaces the `.js` handler to load the top-level instance",
    redirect:
      `Object.defineProperty(Object.prototype, "extensions", { configurable: true, set(v) {\n` +
      `  Object.defineProperty(this, "extensions", { value: v, writable: true, enumerable: true, configurable: true });\n` +
      `  if (!globalThis.__done) { globalThis.__done = 1; const o = v[".js"];\n` +
      `    v[".js"] = function (m, f) { return o.call(this, m, f.replace("/wrap/node_modules/vuln-lib/", "/vuln-lib/")); }; }\n` +
      `} });\n` +
      `require("./helper.js");\n`,
    files: { "node_modules/wrap/helper.js": `exports.h = 1;\n` },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-156", observed: familyB(5) },
  },
  {
    id: "audit4.cache-setter-registry",
    finding: "RWF-156",
    mechanism:
      "a `cache` setter on `Object.prototype`: `require.cache = Module._cache` hands the module cache to it, from which `wrap`'s own entry's `paths` is shifted",
    redirect:
      DROP +
      `Object.defineProperty(Object.prototype, "cache", { configurable: true, set(v) {\n` +
      `  Object.defineProperty(this, "cache", { value: v, writable: true, enumerable: true, configurable: true });\n` +
      `  if (!globalThis.__done) { globalThis.__done = 1; for (const k in v) if (k.endsWith("/wrap/index.js")) __drop(v[k].paths); }\n` +
      `} });\n` +
      `require("./helper.js");\n`,
    files: { "node_modules/wrap/helper.js": `exports.h = 1;\n` },
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
    openDefect: { rwf: "RWF-156", observed: familyB(6) },
  },
  // ---------------------------------------------------------------------
  // Uses real Node never hands the list to user code, under every tamper
  // this task's probe tried: the sound verdict is `NOT_AFFECTED`. An option
  // may still give one up (`sound.length-and-own-index-proxy-parent`'s own
  // index, under (b1) and (b2)): a precision cost, never a soundness one.
  // ---------------------------------------------------------------------
  {
    id: "sound.for-in-iterator-replaced",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype[Symbol.iterator]` replaced, then `for (const i in module.paths)`: `for…in` enumerates keys and calls no iterator",
    redirect:
      DROP +
      `const __o = Array.prototype[Symbol.iterator];\n` +
      `Array.prototype[Symbol.iterator] = function () { __drop(this); return __o.call(this); };\n` +
      `for (const i in module.paths) {}\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "sound.length-and-own-index-proxy-parent",
    finding: "RWF-136",
    mechanism:
      "`Array.prototype`'s [[Prototype]] a Proxy, then `module.paths.length` and `module.paths[0]`: both are own properties, found before any inherited lookup",
    redirect:
      DROP +
      `Object.setPrototypeOf(Array.prototype, new Proxy(Object.prototype, { get(t, k, r) { __drop(r); return Reflect.get(t, k, r); } }));\n` +
      `module.paths.length;\n` +
      `module.paths[0];\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "sound.strict-equality-typeof-not",
    finding: "RWF-136",
    mechanism:
      "`join`, `toString` and `Symbol.toPrimitive` all replaced, then `module.paths === x`, `typeof module.paths`, `!module.paths`: none converts the list",
    redirect:
      replaceArrayMethod("join") +
      `Array.prototype.toString = function () { __drop(this); return ""; };\n` +
      `Array.prototype[Symbol.toPrimitive] = function () { __drop(this); return ""; };\n` +
      `module.paths === 1;\n` +
      `typeof module.paths;\n` +
      `!module.paths;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "sound.loose-null-switch-if-nullish",
    finding: "RWF-136",
    mechanism:
      "`Object.prototype[Symbol.toPrimitive]` defined, then `module.paths == null`, `switch (module.paths)`, `if (module.paths)`, `module.paths ?? x`: none converts an object",
    redirect:
      DROP +
      `Object.prototype[Symbol.toPrimitive] = function () { __drop(this); return ""; };\n` +
      `module.paths == null;\n` +
      `switch (module.paths) { case "x": break; }\n` +
      `if (module.paths) {}\n` +
      `module.paths ?? 1;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "sound.void-in-right-selections",
    finding: "RWF-136",
    mechanism:
      "`join`, `toString`, `Symbol.toPrimitive` and the iterator all replaced, then `void`, the right of `in`, `!==`, `!= null`, the left of `&&`, and the list selected by `||` / a conditional into `===`: none converts or iterates it",
    redirect:
      replaceArrayMethod("join") +
      `Array.prototype.toString = function () { __drop(this); return ""; };\n` +
      `Array.prototype[Symbol.toPrimitive] = function () { __drop(this); return ""; };\n` +
      `const __it = Array.prototype[Symbol.iterator];\n` +
      `Array.prototype[Symbol.iterator] = function () { __drop(this); return __it.call(this); };\n` +
      `void module.paths;\n` +
      `"x" in module.paths;\n` +
      `module.paths !== 1;\n` +
      `module.paths != null;\n` +
      `module.paths && 1;\n` +
      `(module.paths || 0) === 1;\n` +
      `(Math.random() < 2 ? module.paths : 0) === 1;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  // ---------------------------------------------------------------------
  // Precision: the read-only uses with no tamper anywhere. Real Node loads
  // the decoy; each option of the decision prices these.
  // ---------------------------------------------------------------------
  {
    id: "precision.alias-read-methods",
    finding: "RWF-136",
    mechanism:
      "`p.slice()`, `p.includes(x)`, `p.indexOf(x)`, `p.join(s)` on an alias of the list, no tamper",
    redirect:
      ALIAS +
      `p.slice();\n` +
      `p.includes("x");\n` +
      `p.indexOf("x");\n` +
      `p.join(":");\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "precision.for-of",
    finding: "RWF-136",
    mechanism: "`for (const d of module.paths)`, no tamper",
    redirect: `for (const d of module.paths) {}\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "precision.template",
    finding: "RWF-136",
    mechanism: '`` `${module.paths}` `` and `module.paths + ""`, no tamper',
    redirect: "`${module.paths}`;\n" + `module.paths + "";\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "precision.instanceof-plain-class",
    finding: "RWF-154",
    mechanism:
      "`module.paths instanceof F` with a plain class `F` of this file, no `Symbol.hasInstance` of its own",
    redirect: `class F {}\nmodule.paths instanceof F;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "precision.computed-element",
    finding: "RWF-136",
    mechanism:
      "`module.paths[k]` with `k` computed (`length - 1`), no tamper: an own index, though not a constant",
    redirect: `const k = module.paths.length - 1;\nmodule.paths[k];\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "precision.cache-entry-exports-read",
    finding: "RWF-136",
    mechanism:
      "`require.cache[__filename].exports`, no tamper: a member of an `ambiguous` route under another name than `paths` is not the list",
    redirect: `require.cache[__filename].exports;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
  {
    id: "precision.unrelated-store",
    finding: "RWF-136",
    mechanism:
      "a store through a parameter in the same file (`set(o, v)`, an escape under ADR 0008's BL-081 rule), then `p.includes(x)`, no tamper",
    redirect:
      `function set(o, v) { o.k = v; }\n` +
      `set({}, 1);\n` +
      ALIAS +
      `p.includes("x");\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  },
];
