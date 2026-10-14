import type { E1Case } from "./e1-export-write-set.cases.js";

/**
 * Task E-2 (docs/tasks/E-2-forwarding-write-set.md; ADR 0009 § 1, § 8):
 * the forwarding hop consults the export write set, against real Node.
 *
 * THE MECHANISM. `wrap/index.js` forwards its whole export to a sibling
 * (`module.exports = require("./safe")`), so `require("wrap").run` is the
 * sibling's `run` -- unless this file then writes `run` onto that same
 * object. A plain `=` write leaves a named binding the hop refuses on; a
 * write E-1's census can only WITHDRAW (a destructuring, `for-of`,
 * compound or `delete` write, an alias of the final object,
 * `Object.assign`, `defineProperty`, `Reflect.set`) leaves none, and the
 * hop used to forward the name anyway (RWF-105).
 *
 * LOUD FIXTURE. E-1's (`e1-export-write-set.cases.ts`): `vuln-lib`
 * exports `parse` (the rule's target) and `safe`. The siblings `safe.js`
 * and `danger.js` each export a `run` calling one of them, so a hop to
 * the wrong sibling lands loudly on a function whose search completes.
 *
 * THE CONTROLS. E-1's: the negative control writes `exports.run =
 * safeOp` once (`NOT_AFFECTED`); the positive control adds a direct call
 * of `parse` in the entry (`AFFECTED`).
 *
 * `base` is the analyzer's verdict on E-2's base `4bb6c86` (E-1's merge),
 * measured. PRM-61's shapes were already closed there by E-1's model; they
 * stay as regression cases.
 */

const sibling = (target: string): string =>
  `const lib = require("vuln-lib");\n` +
  `function run(x) { return lib.${target}(x); }\n` +
  `exports.run = run;\n`;

const SIBLINGS: Readonly<Record<string, string>> = {
  "safe.js": sibling("safe"),
  "danger.js": sibling("parse"),
};

function forwarding(kase: Omit<E1Case, "wrapFiles">): E1Case {
  return { ...kase, wrapFiles: SIBLINGS };
}

export const E2_CASES: readonly E1Case[] = [
  // RWF-105: a name the write set withdraws, with no binding of its own,
  // was forwarded to the object this file overwrote it on.
  forwarding({
    id: "rwf105.array-destructuring-write",
    finding: "RWF-105",
    mechanism:
      '`module.exports = require("./safe"); [module.exports.run] = [require("./danger").run]`',
    wrap: `module.exports = require("./safe");\n[module.exports.run] = [require("./danger").run];\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  forwarding({
    id: "rwf105.object-destructuring-write",
    finding: "RWF-105",
    mechanism:
      '`module.exports = require("./safe"); ({ run: module.exports.run } = require("./danger"))`',
    wrap: `module.exports = require("./safe");\n({ run: module.exports.run } = require("./danger"));\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  forwarding({
    id: "rwf105.for-of-write",
    finding: "RWF-105",
    mechanism:
      '`module.exports = require("./safe"); for (module.exports.run of [require("./danger").run]);`',
    wrap: `module.exports = require("./safe");\nfor (module.exports.run of [require("./danger").run]);\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  forwarding({
    id: "rwf105.final-object-alias-write",
    finding: "RWF-105",
    mechanism:
      '`module.exports = require("./safe"); const e = module.exports; e.run = require("./danger").run`',
    wrap: `module.exports = require("./safe");\nconst e = module.exports;\ne.run = require("./danger").run;\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  forwarding({
    id: "rwf105.logical-assignment-write",
    finding: "RWF-105",
    mechanism:
      '`module.exports = require("./safe"); delete module.exports.run; module.exports.run ||= function (x) {…parse…}`',
    wrap: `module.exports = require("./safe");\ndelete module.exports.run;\nmodule.exports.run ||= function (x) { return lib.parse(x); };\n`,
    called: true,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
  forwarding({
    id: "rwf105.object-assign-false-affected",
    finding: "RWF-105",
    mechanism:
      '`module.exports = require("./danger"); Object.assign(module.exports, { run: require("./safe").run })` -- a fabricated edge into `danger.js`',
    wrap: `module.exports = require("./danger");\nObject.assign(module.exports, { run: require("./safe").run });\n`,
    called: false,
    base: "AFFECTED",
    expected: "UNKNOWN",
  }),
  // RWF-105's spellings the call graph's `escaped_value` backstop masked
  // on the base: wrong at the hop, right at the verdict.
  forwarding({
    id: "rwf105.object-assign-masked",
    finding: "RWF-105",
    mechanism:
      '`module.exports = require("./safe"); Object.assign(module.exports, { run: require("./danger").run })`',
    wrap: `module.exports = require("./safe");\nObject.assign(module.exports, { run: require("./danger").run });\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  forwarding({
    id: "rwf105.define-property-masked",
    finding: "RWF-105",
    mechanism:
      '`module.exports = require("./safe"); Object.defineProperty(module.exports, "run", { value: require("./danger").run })`',
    wrap: `module.exports = require("./safe");\nObject.defineProperty(module.exports, "run", { value: require("./danger").run });\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  forwarding({
    id: "rwf105.reflect-set-masked",
    finding: "RWF-105",
    mechanism:
      '`module.exports = require("./safe"); Reflect.set(module.exports, "run", require("./danger").run)`',
    wrap: `module.exports = require("./safe");\nReflect.set(module.exports, "run", require("./danger").run);\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  // PRM-61: the reproduced shapes, closed on the base by E-1's model.
  forwarding({
    id: "prm61.property-then-replace",
    finding: "PRM-61",
    mechanism:
      '`exports.run = require("./safe").run; module.exports = require("./danger")`',
    wrap: `exports.run = require("./safe").run;\nmodule.exports = require("./danger");\n`,
    called: true,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  forwarding({
    id: "prm61.property-then-replace-false-affected",
    finding: "PRM-61",
    mechanism:
      '`exports.run = require("./danger").run; module.exports = require("./safe")` (the shape that gave a false AFFECTED)',
    wrap: `exports.run = require("./danger").run;\nmodule.exports = require("./safe");\n`,
    called: false,
    base: "UNKNOWN",
    expected: "UNKNOWN",
  }),
  forwarding({
    id: "prm61.replace-then-stale-exports",
    finding: "PRM-61",
    mechanism:
      '`module.exports = require("./danger"); exports.run = require("./safe").run` -- the stale write is no write',
    wrap: `module.exports = require("./danger");\nexports.run = require("./safe").run;\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  }),
  // Controls: precision the fix keeps.
  forwarding({
    id: "control.replace-then-stale-exports",
    finding: "control",
    mechanism:
      '`module.exports = require("./safe"); exports.run = require("./danger").run` -- a stale write, no write of the forwarded object',
    wrap: `module.exports = require("./safe");\nexports.run = require("./danger").run;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  }),
  forwarding({
    id: "control.replace-then-module-this",
    finding: "control",
    mechanism:
      '`module.exports = require("./safe"); this.run = require("./danger").run` -- module-scope `this` is the original, stale object',
    wrap: `module.exports = require("./safe");\nthis.run = require("./danger").run;\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  }),
  forwarding({
    id: "control.other-name-withdrawn",
    finding: "control",
    mechanism:
      '`module.exports = require("./safe"); [module.exports.other] = [require("./danger").run]` -- a withdrawn name that is not `run`',
    wrap: `module.exports = require("./safe");\n[module.exports.other] = [require("./danger").run];\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "NOT_AFFECTED",
  }),
  forwarding({
    id: "control.other-name-withdrawn-affected",
    finding: "control",
    mechanism:
      '`module.exports = require("./danger"); [module.exports.other] = [1]` -- the forward of `run` stands',
    wrap: `module.exports = require("./danger");\n[module.exports.other] = [1];\n`,
    called: true,
    base: "AFFECTED",
    expected: "AFFECTED",
  }),
  // The accepted precision cost: the census withdraws a destructuring
  // write's name without placing its object, so a write to the STALE
  // `exports` withdraws the forward too. Sound (`UNKNOWN`), not precise.
  forwarding({
    id: "cost.stale-destructuring-write",
    finding: "control",
    mechanism:
      '`module.exports = require("./safe"); [exports.run] = [require("./danger").run]` -- real Node calls `safe`; withdrawn',
    wrap: `module.exports = require("./safe");\n[exports.run] = [require("./danger").run];\n`,
    called: false,
    base: "NOT_AFFECTED",
    expected: "UNKNOWN",
  }),
];
