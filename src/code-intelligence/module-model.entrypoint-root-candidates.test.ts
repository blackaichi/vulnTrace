import { describe, expect, it } from "vitest";
import { buildModuleModel, entrypointRootCandidates } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * RWF-021: root provenance is not export provenance.
 *
 * Export ATTRIBUTION asks "which function IS this module's exported
 * value?" and must refuse when it cannot tell — naming a function the
 * module might not export manufactures a target out of nothing, which is
 * what RWF-011/013/014 exist to prevent. Entrypoint ROOT selection asks
 * "which of this file's functions might an outside caller invoke?" and
 * must WIDEN when it cannot tell — an entrypoint's exports are callable
 * from outside by definition, so a root this file cannot pin down is a
 * root that might be any of its top-level callables, not none of them.
 *
 * Both questions used to be answered by one expression
 * (`exp.localName ?? exp.exportedName`), so every soundness cutoff that
 * correctly withdrew attribution silently deleted the root as well. The
 * exported function's body then went untraversed and the target came back
 * unreachable with a COMPLETE Family C proof — a false NOT_AFFECTED,
 * reproduced on `8d18130` for all four merged cutoff families.
 *
 * The central property this file asserts is MONOTONICITY: making export
 * provenance less precise may only ever ADD roots.
 */

function candidatesOf(text: string, file = "/pkg/index.cjs") {
  const index = indexSourceFile(file, text);
  const model = buildModuleModel(index);
  return {
    model,
    ...entrypointRootCandidates(index, model),
  };
}

function names(text: string, file = "/pkg/index.cjs"): string[] {
  return [...candidatesOf(text, file).names].sort();
}

const DEP = 'const dep = require("vuln-lib");\n';
const MAIN = "function main(u) {\n  return dep.dangerousOp(u);\n}\n";
const BAIL = 'function bail() {\n  throw new Error("boom");\n}\n';

/** The four merged cutoff shapes, each of which withdraws export authority. */
const CUTOFFS: ReadonlyArray<readonly [string, string]> = [
  ["RWF-016 bare call", "if (FLAG) {\n  bail();\n}\n"],
  ["RWF-017 variable initializer", "if (FLAG) {\n  const x = bail();\n}\n"],
  [
    "RWF-018 static field",
    "if (FLAG) {\n  class C {\n    static x = bail();\n  }\n}\n",
  ],
  [
    "RWF-019 computed key",
    "if (FLAG) {\n  class C {\n    [bail()] = 1;\n  }\n}\n",
  ],
];

describe("RWF-021: monotonicity -- losing export precision may only ADD roots", () => {
  for (const [label, cutoff] of CUTOFFS) {
    it(`${label}: the ambiguous root set is a strict SUPERSET of the precise one`, () => {
      const precise = `${DEP}${MAIN}${BAIL}module.exports = main;\n`;
      const ambiguous = `${DEP}${MAIN}${BAIL}${cutoff}module.exports = main;\n`;

      const preciseNames = new Set(names(precise));
      const ambiguousNames = new Set(names(ambiguous));

      // The precise answer survives intact...
      for (const name of preciseNames) {
        expect(ambiguousNames.has(name)).toBe(true);
      }
      // ...and the root that mattered is still there.
      expect(ambiguousNames.has("main")).toBe(true);
      // ...and uncertainty only ever added.
      expect(ambiguousNames.size).toBeGreaterThan(preciseNames.size);
    });

    it(`${label}: marks the binding as withdrawn rather than merely nameless`, () => {
      const { model } = candidatesOf(
        `${DEP}${MAIN}${BAIL}${cutoff}module.exports = main;\n`,
      );
      expect(
        model.exports.some((e) => e.exportAttributionWithdrawn === true),
      ).toBe(true);
    });
  }

  it("never empties a non-empty root set", () => {
    for (const [, cutoff] of CUTOFFS) {
      expect(
        names(`${DEP}${MAIN}${BAIL}${cutoff}module.exports = main;\n`).length,
      ).toBeGreaterThan(0);
    }
  });
});

describe("RWF-021: the precise case is untouched", () => {
  it("roots exactly the named export, widening nothing", () => {
    expect(names(`${DEP}${MAIN}${BAIL}module.exports = main;\n`)).toEqual([
      "main",
    ]);
  });

  it("does NOT widen for an attributed export that simply names no callable", () => {
    // `module.exports = 42` has no callable to root and no ambiguity to
    // resolve. Widening here would be pure precision loss, and telling it
    // apart from a WITHDRAWN export is exactly why the explicit marker
    // exists rather than a test for a missing `localName`.
    expect(names(`${DEP}function helper() {}\nmodule.exports = 42;\n`)).toEqual(
      [],
    );
  });

  it("roots a property export by its local name", () => {
    expect(names(`${DEP}${MAIN}exports.run = main;\n`)).toEqual(["main"]);
  });

  it("roots an ESM named export unchanged", () => {
    expect(names(`${DEP}${MAIN}export { main };\n`, "/pkg/index.mjs")).toEqual([
      "main",
    ]);
  });
});

describe("RWF-021: what widening includes, and what it deliberately does not", () => {
  const withCutoff = (body: string) =>
    `${DEP}${body}${BAIL}if (FLAG) {\n  bail();\n}\nmodule.exports = chosen;\n`;

  it("includes every TOP-LEVEL function declaration", () => {
    expect(
      names(withCutoff("function chosen() {}\nfunction other() {}\n")),
    ).toEqual(["bail", "chosen", "other"]);
  });

  it("includes const-bound function expressions and arrows", () => {
    expect(
      names(
        withCutoff("const chosen = () => {};\nconst fn = function () {};\n"),
      ),
    ).toEqual(["bail", "chosen", "fn"]);
  });

  it("EXCLUDES a function nested inside another function's body", () => {
    // Export ambiguity is no evidence at all that a nested helper is the
    // module's exported value. Widening stops at the module's own
    // top-level callable surface.
    expect(
      names(
        withCutoff(
          "function chosen() {\n  function hidden() {}\n  return hidden;\n}\n",
        ),
      ),
    ).toEqual(["bail", "chosen"]);
  });

  it("EXCLUDES a `let`-bound function expression (not a stable module binding)", () => {
    expect(
      names(withCutoff("function chosen() {}\nlet later = function () {};\n")),
    ).toEqual(["bail", "chosen"]);
  });

  it("includes a same-name decoy AND the real callable -- over-approximation is the safe direction", () => {
    const src = `${DEP}function main() {\n  return "decoy";\n}\nfunction other(u) {\n  return dep.dangerousOp(u);\n}\n${BAIL}if (FLAG) {\n  bail();\n}\nmodule.exports = other;\n`;
    expect(names(src)).toEqual(["bail", "main", "other"]);
  });

  it("includes a reassigned declaration rather than asserting its original identity", () => {
    const src = `${DEP}${MAIN}${BAIL}main = function () {};\nif (FLAG) {\n  bail();\n}\nmodule.exports = main;\n`;
    expect(names(src)).toContain("main");
  });

  it("manufactures nothing when there are no top-level callables at all", () => {
    const src = `${DEP}if (FLAG) {\n  throw new Error("x");\n}\nmodule.exports = { version: 1 };\n`;
    expect(names(src)).toEqual([]);
  });
});

describe("RWF-021: anonymous callables are rooted by POSITION, never by a fabricated name", () => {
  it("carries the anonymous export's location when attribution is precise (RWF-003's evidence)", () => {
    const c = candidatesOf(
      `${DEP}module.exports = function (u) {\n  return dep.dangerousOp(u);\n};\n`,
    );
    expect(c.names.size).toBe(0);
    expect(c.locations).toHaveLength(1);
  });

  it("recovers the anonymous export's location when attribution is WITHDRAWN", () => {
    const c = candidatesOf(
      `${DEP}${BAIL}if (FLAG) {\n  bail();\n}\nmodule.exports = function (u) {\n  return dep.dangerousOp(u);\n};\n`,
    );
    expect(c.locations).toHaveLength(1);
  });

  it("adds no location for a non-function export", () => {
    expect(candidatesOf(`${DEP}module.exports = 42;\n`).locations).toEqual([]);
  });
});

describe("RWF-021: no attribution is resurrected by widening", () => {
  it("does not invent a local name from a property export's PUBLIC name (RWF-011)", () => {
    // `run` is the exported name; the local is `realImpl`. Widening must
    // root real top-level callables, never treat the public name as if it
    // were a local symbol.
    const src = `${DEP}function realImpl(u) {\n  return dep.dangerousOp(u);\n}\n${BAIL}if (FLAG) {\n  bail();\n}\nexports.run = realImpl;\n`;
    const got = names(src);
    expect(got).toContain("realImpl");
    expect(got).not.toContain("nonexistentHelper");
  });

  it("leaves a require re-export's specifier alone -- no local candidate is fabricated from it", () => {
    const src = `${DEP}${BAIL}if (FLAG) {\n  bail();\n}\nmodule.exports = require("vuln-lib");\n`;
    // Only the file's own top-level callable is offered as a root; nothing
    // about the re-exported package becomes a local root.
    expect(names(src)).toEqual(["bail"]);
  });

  it("does not change what mapExportsToFunctions attributes", () => {
    // Root widening is invisible to target attribution: the withdrawn
    // export stays exactly as unattributable as it was.
    const index = indexSourceFile(
      "/pkg/index.cjs",
      `${DEP}${MAIN}${BAIL}if (FLAG) {\n  bail();\n}\nmodule.exports = main;\n`,
    );
    const model = buildModuleModel(index);
    expect(entrypointRootCandidates(index, model).names.has("main")).toBe(true);
    expect(model.exports.some((e) => e.localName !== undefined)).toBe(false);
  });
});
