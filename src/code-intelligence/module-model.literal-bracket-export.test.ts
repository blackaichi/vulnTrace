import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildModuleModel, entrypointRootCandidates } from "./module-model.js";
import { indexSourceFileFromDisk } from "./source-index.js";

/**
 * P0-Z: literal-bracket CommonJS exports are modeled exactly like their dot
 * spelling.
 *
 * The focused re-audit found `module.exports["run"] = run` still producing
 * a false NOT_AFFECTED with a complete Family C proof. `describeCommonJsExportTarget`
 * recognised only `PropertyAccessExpression`, so an element access produced
 * NO export binding, NO root candidate, and -- because the first
 * remediation also excluded literal keys from `computedExportNameWrites` --
 * root derivation reported COMPLETE with zero roots.
 *
 * The rule now: a key this analyzer can name EXACTLY produces the ordinary
 * binding; a key it cannot name produces root incompleteness. Never
 * neither, which is the state that certified absence over a live sink.
 */

let dir: string | undefined;

afterEach(() => {
  if (dir) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function modelOf(source: string, ext = ".js") {
  dir = mkdtempSync(path.join(tmpdir(), "p0z-bracket-"));
  const file = path.join(dir, `m${ext}`);
  writeFileSync(file, source);
  const index = indexSourceFileFromDisk(file);
  const model = buildModuleModel(index);
  return { model, candidates: entrypointRootCandidates(index, model) };
}

/** The export surface as {exportedName, localName} pairs, for equivalence. */
function surface(source: string) {
  const { model } = modelOf(source);
  return model.exports.map((e) => ({
    kind: e.kind,
    exportedName: e.exportedName,
    localName: e.localName,
    reExportOf: e.commonJsReExport?.specifier,
  }));
}

describe("P0-Z: dot and literal-bracket CommonJS exports are equivalent", () => {
  const EQUIVALENT: ReadonlyArray<readonly [string, string, string]> = [
    [
      "module.exports",
      "function run(){}\nmodule.exports.run = run;\n",
      'function run(){}\nmodule.exports["run"] = run;\n',
    ],
    [
      "exports alias",
      "function run(){}\nexports.run = run;\n",
      'function run(){}\nexports["run"] = run;\n',
    ],
    [
      "re-export provenance",
      'module.exports.run = require("./x.js").run;\n',
      'module.exports["run"] = require("./x.js").run;\n',
    ],
  ];

  for (const [label, dot, bracket] of EQUIVALENT) {
    it(`${label}: identical export surface`, () => {
      expect(surface(bracket)).toEqual(surface(dot));
    });

    it(`${label}: identical root candidates and completeness`, () => {
      const d = modelOf(dot).candidates;
      const b = modelOf(bracket).candidates;
      expect([...b.names]).toEqual([...d.names]);
      expect(b.complete).toBe(d.complete);
      expect(b.incompleteness.map((i) => i.reason)).toEqual(
        d.incompleteness.map((i) => i.reason),
      );
    });
  }

  it("an ESCAPED literal key uses the PARSED value, not the raw spelling", () => {
    const { candidates, model } = modelOf(
      'function run(){}\nmodule.exports["r\\u0075n"] = run;\n',
    );
    expect(model.exports[0]?.exportedName).toBe("run");
    expect([...candidates.names]).toContain("run");
    expect(candidates.complete).toBe(true);
  });

  it("a no-substitution TEMPLATE key is exact and modeled", () => {
    // `ts.isStringLiteralLike` already covers this across the codebase, so
    // treating it as exact is consistency, not a new policy.
    const { candidates, model } = modelOf(
      "function run(){}\nmodule.exports[`run`] = run;\n",
    );
    expect(model.exports[0]?.exportedName).toBe("run");
    expect(candidates.complete).toBe(true);
  });

  it("a NUMERIC literal key becomes its stringified property name", () => {
    const { candidates, model } = modelOf(
      "function run(){}\nmodule.exports[0] = run;\n",
    );
    expect(model.exports[0]?.exportedName).toBe("0");
    expect([...candidates.names]).toContain("run");
    expect(candidates.complete).toBe(true);
  });

  it("numeric keys use TypeScript's own normalized text, never a new scheme", () => {
    // `1e3` denotes the property "1000" and `0x10` denotes "16". The
    // round-trip guard is what makes relying on `.text` safe here.
    expect(
      modelOf("function run(){}\nmodule.exports[1e3] = run;\n").model.exports[0]
        ?.exportedName,
    ).toBe("1000");
    expect(
      modelOf("function run(){}\nmodule.exports[0x10] = run;\n").model
        .exports[0]?.exportedName,
    ).toBe("16");
  });
});

describe("P0-Z: inexact keys still fail closed", () => {
  const INEXACT: ReadonlyArray<readonly [string, string]> = [
    ["identifier key", "function run(){}\nmodule.exports[k] = run;\n"],
    ["call key", "function run(){}\nmodule.exports[getKey()] = run;\n"],
    [
      "template WITH substitution",
      "function run(){}\nmodule.exports[`run${s}`] = run;\n",
    ],
    ["bigint key", "function run(){}\nmodule.exports[1n] = run;\n"],
    [
      "computed symbol key",
      "function run(){}\nmodule.exports[Symbol.iterator] = run;\n",
    ],
    [
      "concatenation key",
      'function run(){}\nmodule.exports["ru" + "n"] = run;\n',
    ],
  ];

  for (const [label, source] of INEXACT) {
    it(`${label} -> root derivation INCOMPLETE`, () => {
      const { candidates } = modelOf(source);
      expect(candidates.complete).toBe(false);
      expect(candidates.incompleteness.map((i) => i.reason)).toContain(
        "unresolved_computed_export_name",
      );
    });
  }

  it("never produces BOTH no binding and a complete derivation", () => {
    // The exact state that certified absence over a live sink: a write
    // exists, nothing models it, and the analyzer calls that complete.
    for (const [, source] of INEXACT) {
      const { model, candidates } = modelOf(source);
      const modeled = model.exports.length > 0;
      expect(modeled || !candidates.complete).toBe(true);
    }
  });
});

describe("P0-Z: the literal-bracket fix does not disturb other forms", () => {
  it("whole-module export unchanged", () => {
    const { candidates } = modelOf("function run(){}\nmodule.exports = run;\n");
    expect([...candidates.names]).toContain("run");
    expect(candidates.complete).toBe(true);
  });

  it("whole-module RE-export still incomplete", () => {
    const { candidates } = modelOf('module.exports = require("./x.js");\n');
    expect(candidates.complete).toBe(false);
    expect(candidates.incompleteness.map((i) => i.reason)).toContain(
      "unresolved_entrypoint_reexport",
    );
  });

  it("BRACKET re-export keeps its foreign-origin provenance", () => {
    // Modeling the key alone would have reopened the defect here.
    const { model, candidates } = modelOf(
      'module.exports["run"] = require("./x.js").run;\n',
    );
    expect(model.exports[0]?.commonJsReExport?.specifier).toBe("./x.js");
    expect(candidates.complete).toBe(false);
  });

  it("a legitimately export-free entrypoint stays COMPLETE with zero roots", () => {
    const { candidates } = modelOf("module.exports = 42;\n");
    expect([...candidates.names]).toEqual([]);
    expect(candidates.complete).toBe(true);
  });

  it("inherits the dot form's answer on REASSIGNED `exports`, never its own", () => {
    // Self-review F: bracket support must not make `exports` authoritative
    // where the dot form's existing rules do not. Asserted as equivalence
    // rather than as a fixed verdict, so this keeps holding if those rules
    // change.
    const dot = "function run(){}\nexports = {};\nexports.run = run;\n";
    const bracket = 'function run(){}\nexports = {};\nexports["run"] = run;\n';
    expect(surface(bracket)).toEqual(surface(dot));
    expect(modelOf(bracket).candidates.complete).toBe(
      modelOf(dot).candidates.complete,
    );
  });

  it("inherits the dot form's answer on a SHADOWED `module`", () => {
    const dot =
      "function run(){}\nconst module = { exports: {} };\nmodule.exports.run = run;\n";
    const bracket =
      'function run(){}\nconst module = { exports: {} };\nmodule.exports["run"] = run;\n';
    expect(surface(bracket)).toEqual(surface(dot));
  });

  it("inherits the dot form's answer on a NESTED export property", () => {
    // Neither spelling is modeled; the point is that they agree, so this
    // fix introduces no new asymmetry.
    const dot = "function run(){}\nmodule.exports.a.b = run;\n";
    const bracket = 'function run(){}\nmodule.exports.a["b"] = run;\n';
    expect(surface(bracket)).toEqual(surface(dot));
    expect(modelOf(bracket).candidates.complete).toBe(
      modelOf(dot).candidates.complete,
    );
  });

  it("RWF-025b: a reassigned alias behind a bracket key refuses exactly as the dot form does", () => {
    // Self-review K: bracket keys must not bypass the reassignment proof.
    const dot =
      "let fn = function(){};\nfn = other;\nmodule.exports.run = fn;\n";
    const bracket =
      'let fn = function(){};\nfn = other;\nmodule.exports["run"] = fn;\n';
    expect(surface(bracket)).toEqual(surface(dot));
    expect([...modelOf(bracket).candidates.names]).toEqual([
      ...modelOf(dot).candidates.names,
    ]);
  });

  it("produces no DUPLICATE root candidate for one bracket export", () => {
    const { candidates } = modelOf(
      'function run(){}\nmodule.exports["run"] = run;\n',
    );
    expect([...candidates.names]).toEqual(["run"]);
  });

  it("a bracket write on something that is NOT the export object is ignored", () => {
    const { candidates } = modelOf('function run(){}\nother["run"] = run;\n');
    expect(candidates.complete).toBe(true);
    expect([...candidates.names]).toEqual([]);
  });
});
