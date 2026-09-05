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
 * root that might be any of the values its export writes could publish.
 *
 * Both questions used to be answered by one expression
 * (`exp.localName ?? exp.exportedName`), so every soundness cutoff that
 * correctly withdrew attribution silently deleted the root as well. The
 * exported function's body then went untraversed and the target came back
 * unreachable with a COMPLETE Family C proof — a false NOT_AFFECTED,
 * reproduced on `8d18130` for all four merged cutoff families.
 *
 * There are TWO invariants here, and this file asserts both, because
 * RWF-021's own audit showed that satisfying only the first is not enough:
 *
 *  1. **Monotonicity (no false NOT_AFFECTED).** Making export provenance
 *     less precise may only ever ADD roots, never remove one.
 *  2. **Publishability (no false AFFECTED).** A widened root must be a
 *     value some real export write in this file could actually hand an
 *     importer. Widening to every top-level callable satisfies (1) and
 *     violates (2): it roots helpers that no export write mentions, which
 *     cannot be published on any run, and that manufactured false
 *     AFFECTED findings.
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
const CUTOFF = "if (FLAG) {\n  bail();\n}\n";

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

describe("RWF-021 invariant 1: losing export precision may only ADD roots", () => {
  for (const [label, cutoff] of CUTOFFS) {
    it(`${label}: the ambiguous root set is a SUPERSET of the precise one`, () => {
      const precise = `${DEP}${MAIN}${BAIL}module.exports = main;\n`;
      const ambiguous = `${DEP}${MAIN}${BAIL}${cutoff}module.exports = main;\n`;

      const preciseNames = new Set(names(precise));
      const ambiguousNames = new Set(names(ambiguous));

      for (const name of preciseNames) {
        expect(ambiguousNames.has(name)).toBe(true);
      }
      // The root that mattered survives the withdrawal -- this is the
      // whole of the false NOT_AFFECTED fix.
      expect(ambiguousNames.has("main")).toBe(true);
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
        names(`${DEP}${MAIN}${BAIL}${cutoff}module.exports = main;\n`),
      ).toContain("main");
    }
  });
});

describe("RWF-021 invariant 2: a widened root must be PUBLISHABLE by some export write", () => {
  // The three cases RWF-021's audit reproduced as branch-introduced false
  // AFFECTED findings. Each roots a callable that reaches a vulnerable
  // dependency but that no run of the module can publish.

  it("A. does NOT root a top-level helper that no export write mentions", () => {
    // `neverExported` is the right-hand side of nothing, anywhere. Rooting
    // it reported a call path that cannot execute.
    const src =
      `${DEP}function main(u) {\n  return "safe:" + u;\n}\n` +
      `function neverExported(u) {\n  return dep.dangerousOp(u);\n}\n` +
      `${BAIL}${CUTOFF}module.exports = main;\n`;
    expect(names(src)).toEqual(["main"]);
  });

  it("B. does NOT root a sibling callable when only the safe one is exported", () => {
    const src =
      `${DEP}function safe(u) {\n  return "safe:" + u;\n}\n` +
      `function dangerous(u) {\n  return dep.dangerousOp(u);\n}\n` +
      `${BAIL}${CUTOFF}module.exports = safe;\n`;
    expect(names(src)).toEqual(["safe"]);
  });

  it("C. does NOT root a STALE declaration that was reassigned before the export", () => {
    // RWF-013/013b's reassignment proof, honoured by root selection
    // exactly as attribution honours it: a name this file writes to is not
    // a stable alias for what it was declared as.
    const src =
      `${DEP}${MAIN}function safe(u) {\n  return "safe:" + u;\n}\n` +
      `${BAIL}main = safe;\n${CUTOFF}module.exports = main;\n`;
    expect(names(src)).toEqual([]);
  });

  it("roots ONLY the export-write value, not every top-level callable", () => {
    const src =
      `${DEP}function chosen(u) {\n  return dep.dangerousOp(u);\n}\n` +
      `function other() {}\nconst helper = () => {};\n` +
      `${BAIL}${CUTOFF}module.exports = chosen;\n`;
    expect(names(src)).toEqual(["chosen"]);
  });

  it("does NOT root a nested function -- nothing assigns it to an export", () => {
    const src =
      `${DEP}function outer() {\n  function hidden(u) {\n    return dep.dangerousOp(u);\n  }\n  return hidden;\n}\n` +
      `function main(u) {\n  return "safe:" + u;\n}\n` +
      `${BAIL}${CUTOFF}module.exports = main;\n`;
    expect(names(src)).toEqual(["main"]);
  });

  it("does NOT root a same-name decoy that is not the export write's value", () => {
    const src =
      `${DEP}function main(u) {\n  return "decoy";\n}\n` +
      `function other(u) {\n  return dep.dangerousOp(u);\n}\n` +
      `${BAIL}${CUTOFF}module.exports = other;\n`;
    expect(names(src)).toEqual(["other"]);
  });
});

describe("RWF-021: every real export write contributes -- no write is picked over another", () => {
  it("roots BOTH an earlier conditional write and the later one", () => {
    // Neither write is authoritative; both are values this module can
    // genuinely publish, so both are legitimate roots. This is what
    // distinguishes a real multi-candidate case from case B above.
    const src =
      `${DEP}function safe(u) {\n  return "safe:" + u;\n}\n` +
      `function dangerous(u) {\n  return dep.dangerousOp(u);\n}\n` +
      `${BAIL}if (FLAG) {\n  module.exports = dangerous;\n  bail();\n}\nmodule.exports = safe;\n`;
    expect(names(src)).toEqual(["dangerous", "safe"]);
  });

  it("roots multiple PROPERTY export values", () => {
    const src =
      `${DEP}function safe(u) {\n  return "safe:" + u;\n}\n` +
      `function dangerous(u) {\n  return dep.dangerousOp(u);\n}\n` +
      `${BAIL}exports.safe = safe;\n${CUTOFF}exports.run = dangerous;\n`;
    const got = names(src);
    expect(got).toContain("safe");
    expect(got).toContain("dangerous");
  });

  it("roots an object-literal export's property values", () => {
    const src = `${DEP}${MAIN}${BAIL}${CUTOFF}module.exports = { run: main };\n`;
    expect(names(src)).toContain("main");
  });
});

describe("RWF-021: the precise case is untouched", () => {
  it("roots exactly the named export, widening nothing", () => {
    expect(names(`${DEP}${MAIN}${BAIL}module.exports = main;\n`)).toEqual([
      "main",
    ]);
  });

  it("does NOT widen for an attributed export that simply names no callable", () => {
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

describe("RWF-021: nothing is manufactured when there is nothing to root", () => {
  it("contributes no names when the export publishes no callable", () => {
    const src = `${DEP}if (FLAG) {\n  throw new Error("x");\n}\nmodule.exports = { version: 1 };\n`;
    expect(names(src)).toEqual([]);
  });

  it("fabricates no local candidate from a require re-export's specifier", () => {
    const src = `${DEP}${BAIL}${CUTOFF}module.exports = require("vuln-lib");\n`;
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
      `${DEP}${BAIL}${CUTOFF}module.exports = function (u) {\n  return dep.dangerousOp(u);\n};\n`,
    );
    expect(c.locations).toHaveLength(1);
    expect(c.names.size).toBe(0);
  });

  it("adds no location for a non-function export", () => {
    expect(candidatesOf(`${DEP}module.exports = 42;\n`).locations).toEqual([]);
  });
});

describe("RWF-021: no attribution is resurrected by widening", () => {
  it("roots the export write's LOCAL value, never the public name as a symbol (RWF-011)", () => {
    const src = `${DEP}function realImpl(u) {\n  return dep.dangerousOp(u);\n}\n${BAIL}${CUTOFF}exports.run = realImpl;\n`;
    expect(names(src)).toContain("realImpl");
  });

  it("does not change what mapExportsToFunctions attributes", () => {
    // Root widening is invisible to target attribution: the withdrawn
    // export stays exactly as unattributable as it was.
    const index = indexSourceFile(
      "/pkg/index.cjs",
      `${DEP}${MAIN}${BAIL}${CUTOFF}module.exports = main;\n`,
    );
    const model = buildModuleModel(index);
    expect(entrypointRootCandidates(index, model).names.has("main")).toBe(true);
    expect(model.exports.some((e) => e.localName !== undefined)).toBe(false);
  });
});
