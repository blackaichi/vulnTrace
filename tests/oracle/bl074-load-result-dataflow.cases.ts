import type { CaseVerdict, E1Case } from "./e1-export-write-set.cases.js";

/**
 * Task BL-074 (docs/tasks/BL-074-load-result-dataflow.md; ADR 0009 § 1,
 * § 4): a load's result that may be one of this file's export objects,
 * through any dataflow (RWF-103), and the forwarded object reached the
 * same way (RWF-106), against real Node.
 *
 * THE MECHANISM. E-1's census withdraws a name written through a load's
 * result only on syntactic routes (a member chain, a binding declared,
 * assigned or destructured from a load). A load whose module can hand
 * this file's export object back -- a cycle (`other.js`:
 * `module.exports = require("./index")`), the loader registry
 * (`module.parent.exports`), or, after `module.exports =
 * require("./safe")`, any load of `./safe` -- may flow anywhere else
 * (returned, held in an array or object, passed to a function, iterated)
 * and be written there. The module-graph-aware rule (the project owner's
 * decision for BL-074): such a load is an alias of the export object
 * wherever it flows; a load whose module cannot hand one back is not.
 *
 * LOUD FIXTURE. E-1's (`e1-export-write-set.cases.ts`), with E-2's
 * siblings (`safe.js`, `danger.js`, each exporting a `run` that calls
 * `safe` or `parse`) and the reach-back siblings below.
 *
 * THE CONTROLS. E-1's negative and positive controls, plus the precision
 * controls `control.*`: the same flows through a load that cannot reach
 * back keep `NOT_AFFECTED` (a per-file rule would make them `UNKNOWN`).
 *
 * `base` is the analyzer's verdict on BL-074's base `c22b090` (E-2's
 * merge), measured.
 */

const sibling = (target: string): string =>
  `const lib = require("vuln-lib");\n` +
  `function run(x) { return lib.${target}(x); }\n` +
  `exports.run = run;\n`;

/** Siblings of `wrap/index.js`. */
const SIBLINGS: Readonly<Record<string, string>> = {
  // Reach back through a cycle.
  "other.js": `module.exports = require("./index");\n`,
  // Reach back through two hops.
  "mid.js": `module.exports = require("./index");\n`,
  "far.js": `module.exports = require("./mid");\n`,
  // Reach back through a member of the far module.
  "holder.js": `exports.self = require("./index");\n`,
  // Reach back through the loader registry, no static path.
  "parent.js": `module.exports = module.parent.exports;\n`,
  // Reach back through `process.mainModule`, the global object reached as
  // a sloppy function's `this` (BL-074's audit, round 2).
  "sloppy-this.js":
    `function g() { return this; }\nvar root = g();\n` +
    `module.exports = root.process.mainModule.children[0].exports;\n`,
  // The same through keys computed at run time: no name is spelled.
  "computed-keys.js":
    `function g() { return this; }\nvar root = g();\n` +
    `var p = ["pro", "cess"].join(""), m = ["main", "Module"].join("");\n` +
    `module.exports = Reflect.get(Reflect.get(root, p), m).children[0].exports;\n`,
  // BL-074's audit, round 3: the same through a destructuring
  // assignment's key, and through keys built by concatenation or a
  // template.
  "destructured-key.js":
    `function g() { return this; }\nvar root = g();\n` +
    `var mm;\n({ mainModule: mm } = root.process);\nmodule.exports = mm.children[0].exports;\n`,
  "destructured-shorthand.js":
    `function g() { return this; }\nvar root = g();\n` +
    `var mainModule;\n({ mainModule } = root.process);\nmodule.exports = mainModule.children[0].exports;\n`,
  "concat-key.js":
    `function g() { return this; }\nvar root = g();\n` +
    `var k = "main" + "Module";\nvar mm = root.process[k];\nmodule.exports = mm.children[0].exports;\n`,
  "template-key.js":
    `function g() { return this; }\nvar root = g();\n` +
    'var a = "main";\nvar mm = root.process[`${a}Module`];\nmodule.exports = mm.children[0].exports;\n',
  // BL-074's round-4 review: a `this` is decided by the function that
  // binds it, never by a strict arrow or a class header in between.
  "strict-arrow.js":
    `function g() { var t; var f = () => { "use strict"; t = this; }; f(); return t; }\n` +
    `var root = g();\nvar k = "main" + "Module";\nmodule.exports = root.process[k].children[0].exports;\n`,
  "class-heritage.js":
    `function g() { var t; class C extends (t = this, Object) {} return t; }\n` +
    `var root = g();\nvar k = "main" + "Module";\nmodule.exports = root.process[k].children[0].exports;\n`,
  "class-key.js":
    `function g() { var t; class C { static [(t = this, "x")] = 1; } return t; }\n` +
    `var root = g();\nvar k = "main" + "Module";\nmodule.exports = root.process[k].children[0].exports;\n`,
  // A caller's frame through a run-time key: the getter's caller is the
  // module wrapper reading `obj`, whose first argument is its `exports`.
  "frame-key.js":
    `var k = "cal" + "ler";\n` +
    `Object.defineProperty(exports, "obj", { get: function g() { return g[k].arguments[0]; } });\n`,
  // Cannot reach back: a leaf, and a module loading only `vuln-lib`.
  "plain.js": `exports.v = 1;\n`,
  "leaf.js": `const lib = require("vuln-lib");\nexports.safe = lib.safe;\n`,
  // A module whose own loads are not statically resolved.
  "dyn.js": `const n = process.env.BL074_NOPE || "./plain";\nmodule.exports = require(n);\n`,
  // E-2's forwarded siblings, and a module re-exporting one of them.
  "safe.js": sibling("safe"),
  "danger.js": sibling("parse"),
  "alias.js": `module.exports = require("./safe");\n`,
};

interface Shape {
  readonly id: string;
  readonly finding: string;
  readonly mechanism: string;
  readonly wrap: string;
  readonly called: boolean;
  readonly base: CaseVerdict;
  readonly expected: CaseVerdict;
}

function bl074(kase: Shape): E1Case {
  return { ...kase, wrapFiles: SIBLINGS };
}

/** RWF-103's prelude: the file's own export, then a shape that overwrites it through a load. */
const own = (shape: string): string => `exports.run = safeOp;\n${shape}`;

/** RWF-106's prelude: the file forwards `./safe`'s exports object. */
const forwards = (shape: string): string =>
  `module.exports = require("./safe");\n${shape}`;

const DANGER = `require("./danger").run`;

export const BL074_CASES: readonly E1Case[] = [
  // RWF-103: a load that hands this file's own exports object back,
  // reaching a write through dataflow E-1's census did not follow.
  bl074({
    id: "rwf103.returned-from-function",
    finding: "RWF-103",
    mechanism:
      '`function get() { return require("./other"); } get().run = dangerousOp;`',
    wrap: own(
      `function get() { return require("./other"); }\nget().run = dangerousOp;\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.object-holder",
    finding: "RWF-103",
    mechanism: '`const o = { m: require("./other") }; o.m.run = dangerousOp;`',
    wrap: own(`const o = { m: require("./other") };\no.m.run = dangerousOp;\n`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.array-holder",
    finding: "RWF-103",
    mechanism: '`const a = [require("./other")]; a[0].run = dangerousOp;`',
    wrap: own(`const a = [require("./other")];\na[0].run = dangerousOp;\n`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.argument",
    finding: "RWF-103",
    mechanism:
      '`function set(m) { m.run = dangerousOp; } set(require("./other"));`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(require("./other"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.for-of",
    finding: "RWF-103",
    mechanism: '`for (const m of [require("./other")]) m.run = dangerousOp;`',
    wrap: own(`for (const m of [require("./other")]) m.run = dangerousOp;\n`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.destructuring-assignment",
    finding: "RWF-103",
    mechanism: '`let o; [o] = [require("./other")]; o.run = dangerousOp;`',
    wrap: own(`let o;\n[o] = [require("./other")];\no.run = dangerousOp;\n`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.getter",
    finding: "RWF-103",
    mechanism:
      '`const h = { get m() { return require("./other"); } }; h.m.run = dangerousOp;`',
    wrap: own(
      `const h = { get m() { return require("./other"); } };\nh.m.run = dangerousOp;\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.two-hop-cycle",
    finding: "RWF-103",
    mechanism:
      '`set(require("./far"))`, `far.js` → `mid.js` → `module.exports = require("./index")`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(require("./far"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.member-of-load",
    finding: "RWF-103",
    mechanism:
      '`set(require("./holder").self)`, `holder.js`: `exports.self = require("./index")`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(require("./holder").self);\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.loader-registry",
    finding: "RWF-103",
    mechanism:
      '`set(require("./parent"))`, `parent.js`: `module.exports = module.parent.exports`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(require("./parent"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.own-property-read-back",
    finding: "RWF-103",
    mechanism:
      '`exports.self = require("./other"); exports.self.run = dangerousOp;`',
    wrap: own(
      `exports.self = require("./other");\nexports.self.run = dangerousOp;\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.own-property-method-this",
    finding: "RWF-103",
    mechanism:
      '`exports.self = require("./other"); exports.f = function () { this.self.run = dangerousOp; }; exports.f();`',
    wrap: own(
      `exports.self = require("./other");\nexports.f = function () { this.self.run = dangerousOp; };\nexports.f();\n`,
    ),
    called: true,
    // Masked on the base: the method's `this` hand-off already withdraws.
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  // Found by BL-074's independent audit: an assignment's own value is the
  // load's, and flows on.
  bl074({
    id: "rwf103.assignment-value-argument",
    finding: "RWF-103",
    mechanism:
      '`function set(m) { m.run = dangerousOp; } let a; set(a = require("./other"));`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nlet a;\nset(a = require("./other"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.chained-assignment",
    finding: "RWF-103",
    mechanism:
      '`function set(m) { m.run = dangerousOp; } let a, b; a = b = require("./other"); set(a);`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nlet a, b;\na = b = require("./other");\nset(a);\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.assignment-value-array",
    finding: "RWF-103",
    mechanism:
      '`let a; const arr = [a = require("./other")]; arr[0].run = dangerousOp;`',
    wrap: own(
      `let a;\nconst arr = [a = require("./other")];\narr[0].run = dangerousOp;\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.own-property-assignment-value",
    finding: "RWF-103",
    mechanism:
      '`function set(m) { m.run = dangerousOp; } set(exports.b = require("./other"));`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(exports.b = require("./other"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.sloppy-this-main-module",
    finding: "RWF-103",
    mechanism:
      '`set(require("./sloppy-this"))`, `sloppy-this.js`: a sloppy `this` is the global object; `root.process.mainModule.children[0].exports`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(require("./sloppy-this"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  ...(
    [
      ["destructured-key", "`({ mainModule: mm } = root.process)`"],
      ["destructured-shorthand", "`({ mainModule } = root.process)`"],
      ["concat-key", '`root.process["main" + "Module"]`'],
      ["template-key", "`root.process[`${a}Module`]`"],
      ["strict-arrow", "a strict arrow capturing it"],
      ["class-heritage", "a class heritage clause capturing it"],
      ["class-key", "a class's computed key capturing it"],
    ] as const
  ).map(([file, spelling]) =>
    bl074({
      id: `rwf103.sloppy-this-${file}`,
      finding: "RWF-103",
      mechanism: `\`set(require("./${file}"))\`, the global object as a sloppy \`this\`, then ${spelling}`,
      wrap: own(
        `function set(m) { m.run = dangerousOp; }\nset(require("./${file}"));\n`,
      ),
      called: true,
      base: "NOT_AFFECTED",
      expected: "UNKNOWN",
    }),
  ),
  // RWF-109 (open): a caller's frame read through a key computed at run
  // time spells no name the graph can taint; `UNKNOWN` here only through
  // the call graph's masking (measured: the graph answers "cannot reach
  // back" for `frame-key.js`).
  bl074({
    id: "rwf109.frame-key-masked",
    finding: "RWF-109",
    mechanism:
      '`set(require("./frame-key").obj)`, `frame-key.js`: a getter returning `g[k].arguments[0]` with `k` = `"cal" + "ler"`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(require("./frame-key").obj);\n`,
    ),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.sloppy-this-reflect-get",
    finding: "RWF-103",
    mechanism:
      '`set(require("./computed-keys"))`, `computed-keys.js`: the global object as a sloppy `this`, then `Reflect.get(Reflect.get(root, p), m)` with `p`, `m` built at run time',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(require("./computed-keys"));\n`,
    ),
    called: true,
    // Masked on the base by the call graph (`escaped_value`).
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  // RWF-103's spellings wrong at the model and masked at the verdict on
  // the base.
  bl074({
    id: "rwf103.object-assign-masked",
    finding: "RWF-103",
    mechanism: '`Object.assign(require("./other"), { run: dangerousOp })`',
    wrap: own(`Object.assign(require("./other"), { run: dangerousOp });\n`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf103.iife-parameter-masked",
    finding: "RWF-103",
    mechanism: '`(function (m) { m.run = dangerousOp; })(require("./other"))`',
    wrap: own(`(function (m) { m.run = dangerousOp; })(require("./other"));\n`),
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),

  // RWF-106: after `module.exports = require("./safe")`, a load of the
  // forwarded module reaching a write through the same dataflow.
  bl074({
    id: "rwf106.argument",
    finding: "RWF-106",
    mechanism: `\`function patch(o) { o.run = ${DANGER}; } patch(require("./safe"));\``,
    wrap: forwards(
      `function patch(o) { o.run = ${DANGER}; }\npatch(require("./safe"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf106.array-holder",
    finding: "RWF-106",
    mechanism: `\`const arr = [require("./safe")]; arr[0].run = ${DANGER};\``,
    wrap: forwards(
      `const arr = [require("./safe")];\narr[0].run = ${DANGER};\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf106.array-literal-element",
    finding: "RWF-106",
    mechanism: `\`[require("./safe")][0].run = ${DANGER};\``,
    wrap: forwards(`[require("./safe")][0].run = ${DANGER};\n`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf106.for-of",
    finding: "RWF-106",
    mechanism: `\`for (const o of [require("./safe")]) o.run = ${DANGER};\``,
    wrap: forwards(`for (const o of [require("./safe")]) o.run = ${DANGER};\n`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf106.object-holder",
    finding: "RWF-106",
    mechanism: `\`const h = { s: require("./safe") }; h.s.run = ${DANGER};\``,
    wrap: forwards(
      `const h = { s: require("./safe") };\nh.s.run = ${DANGER};\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf106.destructured-holder",
    finding: "RWF-106",
    mechanism: `\`const { s } = { s: require("./safe") }; s.run = ${DANGER};\``,
    wrap: forwards(
      `const { s } = { s: require("./safe") };\ns.run = ${DANGER};\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf106.callback",
    finding: "RWF-106",
    mechanism: `\`[require("./safe")].map((m) => (m.run = ${DANGER}));\``,
    wrap: forwards(`[require("./safe")].map((m) => (m.run = ${DANGER}));\n`),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf106.rest-parameter",
    finding: "RWF-106",
    mechanism: `\`function patch(...a) { a[0].run = ${DANGER}; } patch(require("./safe"));\``,
    wrap: forwards(
      `function patch(...a) { a[0].run = ${DANGER}; }\npatch(require("./safe"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf106.through-another-module",
    finding: "RWF-106",
    mechanism: `\`patch(require("./alias"))\`, \`alias.js\`: \`module.exports = require("./safe")\``,
    wrap: forwards(
      `function patch(o) { o.run = ${DANGER}; }\npatch(require("./alias"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),

  bl074({
    id: "rwf106.chained-assignment",
    finding: "RWF-106",
    mechanism: `\`module.exports = require("./safe"); function patch(o) { o.run = ${DANGER}; } let a, b; a = b = require("./safe"); patch(a);\``,
    wrap: forwards(
      `function patch(o) { o.run = ${DANGER}; }\nlet a, b;\na = b = require("./safe");\npatch(a);\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  bl074({
    id: "rwf106.assignment-value-argument",
    finding: "RWF-106",
    mechanism: `\`module.exports = require("./safe"); function patch(o) { o.run = ${DANGER}; } let a; patch(a = require("./safe"));\``,
    wrap: forwards(
      `function patch(o) { o.run = ${DANGER}; }\nlet a;\npatch(a = require("./safe"));\n`,
    ),
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),

  // Precision controls: the same flows through a load whose module cannot
  // hand an export object of this file back. A per-file rule would make
  // each `UNKNOWN`; the module-graph-aware rule keeps the proof.
  bl074({
    id: "control.argument-leaf",
    finding: "control",
    mechanism:
      '`exports.run = safeOp; function set(m) { m.run = dangerousOp; } set(require("./plain"));`',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(require("./plain"));\n`,
    ),
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  }),
  bl074({
    id: "control.array-holder-leaf",
    finding: "control",
    mechanism:
      '`exports.run = safeOp; const a = [require("./leaf")]; a[0].run = dangerousOp;`',
    wrap: own(`const a = [require("./leaf")];\na[0].run = dangerousOp;\n`),
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  }),
  bl074({
    id: "control.argument-package",
    finding: "control",
    mechanism:
      '`exports.run = safeOp; function set(m) { m.k = 1; } set(require("vuln-lib"));`',
    wrap: own(`function set(m) { m.k = 1; }\nset(require("vuln-lib"));\n`),
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  }),
  bl074({
    id: "control.forward-other-sibling",
    finding: "control",
    mechanism: `\`module.exports = require("./safe"); function patch(o) { o.run = ${DANGER}; } patch(require("./plain"));\``,
    wrap: forwards(
      `function patch(o) { o.run = ${DANGER}; }\npatch(require("./plain"));\n`,
    ),
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  }),
  // A load that reaches back, published as an export property by a file
  // that never reads its export objects back: nothing of this file can
  // write through it.
  bl074({
    id: "control.own-property-write-only",
    finding: "control",
    mechanism: '`exports.run = safeOp; exports.self = require("./other");`',
    wrap: own(`exports.self = require("./other");\n`),
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  }),
  // A module whose own load is not statically resolved may load anything,
  // so it may reach back: already `UNKNOWN` on the base (the module-load
  // closure is incomplete), and kept so.
  bl074({
    id: "control.argument-dynamic-load",
    finding: "control",
    mechanism: '`set(require("./dyn"))`, `dyn.js` loads a computed specifier',
    wrap: own(
      `function set(m) { m.run = dangerousOp; }\nset(require("./dyn"));\n`,
    ),
    called: false,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  // The precision the rule gives up, measured: a load that can hand this
  // file's exports object back, flowing where the census cannot follow,
  // withdraws every name -- even when real Node writes another one.
  bl074({
    id: "cost.argument-reach-back-other-name",
    finding: "cost",
    mechanism:
      '`exports.run = safeOp; function set(m) { m.k = 1; } set(require("./other"));`',
    wrap: own(`function set(m) { m.k = 1; }\nset(require("./other"));\n`),
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
];
