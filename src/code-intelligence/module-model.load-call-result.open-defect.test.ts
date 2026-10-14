import { describe, expect, it } from "vitest";
import {
  loadDefectRegisters,
  openSoundnessDefectProblems,
  type OpenSoundnessDefect,
  type OutcomeDomain,
} from "../testing/open-soundness-defect.js";
import { buildModuleModel, mapExportsToFunctions } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-107 (found by task BL-074's independent audit), OPEN: the census
 * counts a load's value confined when it is called, constructed or the
 * receiver of a member call, and does not follow what the call returns --
 * which may be this file's exports object (`g.js`: `module.exports = () =>
 * require("./index")`). The fix (follow every call result) is a measured
 * precision trade-off for the project owner (backlog BL-078), so each shape
 * is an open-soundness-defect record: `observed` is the wrong attribution
 * today, `expected` the fail-closed one. Masked end to end by the call
 * graph (no false NOT_AFFECTED measured).
 *
 * Measured at the model, with no module-graph context (the per-file rule,
 * under which every load may reach back): even then the call result keeps
 * `run` attributed to `safe`.
 */

/** The function `run` is attributed to, or `null` when it is withdrawn. */
type Attribution = string | null;

const ATTRIBUTION_DOMAIN: OutcomeDomain<Attribution, Attribution> = {
  name: "export attribution",
  admits: (pattern, outcome) => pattern === outcome,
};

function attribution(source: string): Attribution {
  const index = indexSourceFile("/p/node_modules/wrap/index.js", source);
  return (
    mapExportsToFunctions(index, buildModuleModel(index)).get("run")?.name ??
    null
  );
}

const HEAD =
  `function safe() {}\nfunction dangerous() {}\n` +
  `function set(m) { m.run = dangerous; }\nexports.run = safe;\n`;

const SHAPES: readonly (readonly [string, string])[] = [
  ["a called load", `set(require("./g")());\n`],
  ["a called binding of a load", `const g = require("./g");\nset(g());\n`],
  ["a member call's result", `set(require("./gm").get());\n`],
  ["a constructed load", `set(new (require("./g"))());\n`],
  ["valueOf", `set(require("./other").valueOf());\n`],
];

const registers = loadDefectRegisters();

describe("RWF-107 (open): what a call through a load returns", () => {
  it.each(SHAPES)("%s", (label, use) => {
    const record: OpenSoundnessDefect<Attribution, Attribution> = {
      caseId: `rwf107.${label}`,
      rwf: "RWF-107",
      debt: "D-17",
      admissible: [null],
      expected: null,
      observed: "safe",
    };
    expect(
      openSoundnessDefectProblems(
        record,
        ATTRIBUTION_DOMAIN,
        attribution(`${HEAD}${use}`),
        registers,
      ),
      `${record.rwf} / ${record.debt}: ${record.caseId}`,
    ).toEqual([]);
  });

  it("control: the same value handed on uncalled withdraws the file", () => {
    expect(attribution(`${HEAD}set(require("./g"));\n`)).toBeNull();
  });
});
