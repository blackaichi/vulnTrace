import { describe, expect, it } from "vitest";
import {
  commonJsExportForwardingHop,
  esmExportForwardingHop,
  exportForwardingHops,
} from "./export-forwarding.js";
import { buildModuleModel } from "./module-model.js";
import { indexSourceFile } from "./source-index.js";

/**
 * P1-A1 unit coverage for the shared forwarding-hop rule
 * (export-forwarding.ts).
 *
 * This layer answers exactly one question — "if this module publishes
 * `<name>`, which specifier does that value come from, and under which name
 * over there?" — and deliberately answers it without resolving a specifier,
 * touching the filesystem, or knowing anything about packages. Resolution,
 * the package-boundary rule and graph binding belong to its two consumers
 * (call-graph.ts's consumer-side chase, verdict.ts's target-side chase),
 * which differ on those points on purpose and are covered in their own
 * suites.
 *
 * Every negative case here is the reason a rename, a stale binding or an
 * unsupported syntax degrades to UNKNOWN downstream instead of being
 * guessed at.
 */
function modelOf(source: string, file = "/virtual/index.js") {
  return buildModuleModel(indexSourceFile(file, source));
}

describe("CommonJS forwarding hops", () => {
  it("forwards a named re-export under the name it actually selected", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(`exports.vulnerable = require("./lib").vulnerable;`),
        "vulnerable",
      ),
    ).toEqual({
      specifier: "./lib",
      exportName: "vulnerable",
      syntax: "commonjs",
    });
  });

  it("carries a RENAME: the far side is asked for the implementation-facing name", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(`exports.vulnerable = require("./lib").internalName;`),
        "vulnerable",
      ),
    ).toEqual({
      specifier: "./lib",
      exportName: "internalName",
      syntax: "commonjs",
    });
  });

  it("maps a whole-module property re-export onto the far side's canonical `default`", () => {
    // The qs/RWB-05 shape: the property IS the other module's whole
    // exported value, which is what Node binds there.
    expect(
      commonJsExportForwardingHop(
        modelOf(
          `var impl = require("./impl");\nmodule.exports = { vulnerable: impl };`,
        ),
        "vulnerable",
      ),
    ).toEqual({
      specifier: "./impl",
      exportName: "default",
      syntax: "commonjs",
    });
  });

  it("forwards ANY requested name through a whole-module re-export, under the same name", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(`module.exports = require("./lib");`),
        "vulnerable",
      ),
    ).toEqual({
      specifier: "./lib",
      exportName: "vulnerable",
      syntax: "commonjs",
    });
  });

  it("forwards only `default` through `module.exports = require('./lib').foo`", () => {
    const model = modelOf(`module.exports = require("./lib").foo;`);

    expect(commonJsExportForwardingHop(model, "default")).toEqual({
      specifier: "./lib",
      exportName: "foo",
      syntax: "commonjs",
    });
    // That module's default value is one specific callable; it does not make
    // this module's namespace be the other's, so no other name forwards.
    expect(commonJsExportForwardingHop(model, "vulnerable")).toBeUndefined();
  });

  it("looks through a single-assignment local alias", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(
          `var impl = require("./impl");\nvar alias = impl.internalName;\nmodule.exports.vulnerable = alias;`,
        ),
        "vulnerable",
      ),
    ).toEqual({
      specifier: "./impl",
      exportName: "internalName",
      syntax: "commonjs",
    });
  });

  it("refuses a REASSIGNED alias rather than forwarding its stale initializer", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(
          `var impl = require("./impl");\nvar alias = impl.dangerous;\nalias = impl.harmless;\nmodule.exports.vulnerable = alias;`,
        ),
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("forwards the LAST of duplicate export writes, never the stale first", () => {
    // BL-064 (RWF-094): the last write's value is read before the write
    // completes, so it is a `const` read here -- `require("./impl").harmless`
    // inside the second write may throw (a load failure, a getter) and leave
    // `dangerous` published to `./impl`, which holds `module.parent`.
    expect(
      commonJsExportForwardingHop(
        modelOf(
          `const harmless = require("./impl").harmless;\nexports.vulnerable = require("./impl").dangerous;\nexports.vulnerable = harmless;`,
        ),
        "vulnerable",
      ),
    ).toEqual({
      specifier: "./impl",
      exportName: "harmless",
      syntax: "commonjs",
    });
  });

  it("forwards NEITHER duplicate write when the last one's value may throw after the first is observable (BL-064, RWF-094)", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(
          `exports.vulnerable = require("./impl").dangerous;\nexports.vulnerable = require("./impl").harmless;`,
        ),
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("refuses a DYNAMIC (computed) specifier", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(
          `var which = process.env.X;\nexports.vulnerable = require(which).internalName;`,
        ),
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("does NOT fall through to whole-module forwarding when the file has its own unattributable named export", () => {
    // The own binding shadows the forwarded namespace at runtime, so
    // forwarding anyway would resolve to a value the module never exports
    // under that name.
    expect(
      commonJsExportForwardingHop(
        modelOf(
          `module.exports = require("./lib");\nmodule.exports.vulnerable = computeSomething();`,
        ),
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("produces no hop for a file that forwards nothing at all", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(`function vulnerable() {}\nexports.vulnerable = vulnerable;`),
        "vulnerable",
      ),
    ).toBeUndefined();
  });
});

describe("ESM forwarding hops", () => {
  it("forwards a named re-export", () => {
    expect(
      esmExportForwardingHop(
        modelOf(`export { vulnerable } from "./impl.js";`, "/virtual/i.mjs"),
        "vulnerable",
      ),
    ).toEqual({
      specifier: "./impl.js",
      exportName: "vulnerable",
      syntax: "esm",
    });
  });

  it("carries a RENAME rather than searching the far side for the advisory's name", () => {
    expect(
      esmExportForwardingHop(
        modelOf(
          `export { internalName as vulnerable } from "./impl.js";`,
          "/virtual/i.mjs",
        ),
        "vulnerable",
      ),
    ).toEqual({
      specifier: "./impl.js",
      exportName: "internalName",
      syntax: "esm",
    });
  });

  it("carries a DEFAULT -> NAMED mapping when the binding explicitly proves it", () => {
    expect(
      esmExportForwardingHop(
        modelOf(
          `export { default as vulnerable } from "./impl.js";`,
          "/virtual/i.mjs",
        ),
        "vulnerable",
      ),
    ).toEqual({
      specifier: "./impl.js",
      exportName: "default",
      syntax: "esm",
    });
  });

  it("refuses `export * from` — a star export must never be resolved by guessing", () => {
    // Matching one requested name against an unenumerated set is a
    // different problem; refusing costs only precision and leaves the
    // caller's own unresolved/UNKNOWN path exactly as it was.
    expect(
      esmExportForwardingHop(
        modelOf(`export * from "./impl.js";`, "/virtual/i.mjs"),
        "vulnerable",
      ),
    ).toBeUndefined();
    expect(
      exportForwardingHops(
        modelOf(`export * from "./impl.js";`, "/virtual/i.mjs"),
        "vulnerable",
      ),
    ).toEqual([]);
  });
});

describe("hop ordering", () => {
  it("offers the ESM hop before the CommonJS one, and only the hops that exist", () => {
    expect(
      exportForwardingHops(
        modelOf(`exports.vulnerable = require("./lib").vulnerable;`),
        "vulnerable",
      ),
    ).toEqual([
      { specifier: "./lib", exportName: "vulnerable", syntax: "commonjs" },
    ]);

    expect(
      exportForwardingHops(
        modelOf(`export { vulnerable } from "./impl.js";`, "/virtual/i.mjs"),
        "vulnerable",
      ),
    ).toEqual([
      { specifier: "./impl.js", exportName: "vulnerable", syntax: "esm" },
    ]);
  });

  it("is empty for a name the module does not forward", () => {
    expect(
      exportForwardingHops(
        modelOf(`exports.other = require("./lib").other;`),
        "vulnerable",
      ),
    ).toEqual([]);
  });
});

describe("E-2: the CommonJS hop consults the export write set (RWF-105)", () => {
  const LIB = `module.exports = require("./lib");\n`;
  const FORWARD = {
    specifier: "./lib",
    exportName: "vulnerable",
    syntax: "commonjs",
  } as const;

  // Each write leaves no named binding of its own -- E-1's census can only
  // withdraw the name -- and writes `vulnerable` onto `./lib`'s own
  // exports object, which real Node then publishes (tests/oracle/
  // e2-forwarding-write-set.test.ts).
  it.each([
    ["an array destructuring write", `[module.exports.vulnerable] = [other];`],
    [
      "an object destructuring write",
      `({ vulnerable: module.exports.vulnerable } = other);`,
    ],
    ["a for-of write", `for (module.exports.vulnerable of [other]);`],
    [
      "a write through an alias of the final object",
      `const e = module.exports;\ne.vulnerable = other;`,
    ],
    ["a logical assignment", `module.exports.vulnerable ||= other;`],
    ["a delete", `delete module.exports.vulnerable;`],
    ["Object.assign", `Object.assign(module.exports, { vulnerable: other });`],
    [
      "Object.defineProperty",
      `Object.defineProperty(module.exports, "vulnerable", { value: other });`,
    ],
    ["Reflect.set", `Reflect.set(module.exports, "vulnerable", other);`],
  ])(
    "refuses to forward a name the file writes onto the forwarded object: %s",
    (_label, write) => {
      const model = modelOf(`const other = () => {};\n${LIB}${write}`);
      expect(
        model.exports.some((exp) => exp.exportedName === "vulnerable"),
        "no named binding of its own",
      ).toBe(false);
      expect(commonJsExportForwardingHop(model, "vulnerable")).toBeUndefined();
    },
  );

  it("still forwards a name the file does not write", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(`const other = 1;\n${LIB}[module.exports.other] = [other];`),
        "vulnerable",
      ),
    ).toEqual(FORWARD);
  });

  it("forwards past a write to the STALE `exports` or module-scope `this`: neither is the forwarded object", () => {
    for (const write of [
      `exports.vulnerable = other;`,
      `this.vulnerable = other;`,
    ]) {
      expect(
        commonJsExportForwardingHop(
          modelOf(`const other = () => {};\n${LIB}${write}`),
          "vulnerable",
        ),
        write,
      ).toEqual(FORWARD);
    }
  });

  it("records a plain write on the forwarded object, and not a stale one", () => {
    const shadowed = (write: string) =>
      modelOf(`const other = () => {};\n${LIB}${write}`).exports.find(
        (exp) => exp.kind === "default",
      )?.forwardingShadowedNames;
    expect(
      shadowed(`module.exports.vulnerable = other;`)?.has("vulnerable"),
    ).toBe(true);
    expect(shadowed(`exports.vulnerable = other;`)?.has("vulnerable")).toBe(
      false,
    );
    expect(shadowed(``)).toEqual(new Set());
  });

  it("refuses a destructuring write to the stale `exports` too (the census does not place its object: the accepted precision cost)", () => {
    expect(
      commonJsExportForwardingHop(
        modelOf(
          `const other = () => {};\n${LIB}[exports.vulnerable] = [other];`,
        ),
        "vulnerable",
      ),
    ).toBeUndefined();
  });

  it("forwards nothing from a whole-module re-export carrying no write-set record", () => {
    const model = modelOf(LIB);
    expect(commonJsExportForwardingHop(model, "vulnerable")).toEqual(FORWARD);
    const unconsulted = {
      ...model,
      exports: model.exports.map((exp) =>
        exp.kind === "default"
          ? { ...exp, forwardingShadowedNames: undefined }
          : exp,
      ),
    };
    expect(
      commonJsExportForwardingHop(unconsulted, "vulnerable"),
    ).toBeUndefined();
  });

  it("forwards nothing when the model carries more than one whole-module binding", () => {
    const model = modelOf(LIB);
    const twice = { ...model, exports: [...model.exports, ...model.exports] };
    expect(commonJsExportForwardingHop(twice, "vulnerable")).toBeUndefined();
  });

  it("forwards an own name only when every own binding of it carries the same origin", () => {
    const model = modelOf(`exports.vulnerable = require("./lib").vulnerable;`);
    const own = model.exports[0]!;
    expect(commonJsExportForwardingHop(model, "vulnerable")).toEqual(FORWARD);
    const withOwn = (...extra: (typeof own)[]) => ({
      ...model,
      exports: [own, ...extra],
    });
    expect(
      commonJsExportForwardingHop(withOwn(own), "vulnerable"),
      "the same origin twice",
    ).toEqual(FORWARD);
    expect(
      commonJsExportForwardingHop(
        withOwn({
          ...own,
          commonJsReExport: {
            specifier: "./other",
            importedName: "vulnerable",
          },
        }),
        "vulnerable",
      ),
      "two origins: the first is not the one Node keeps",
    ).toBeUndefined();
    expect(
      commonJsExportForwardingHop(
        withOwn({ ...own, exportAttributionWithdrawn: true }),
        "vulnerable",
      ),
      "a withdrawn binding of the name",
    ).toBeUndefined();
    expect(
      commonJsExportForwardingHop(
        { ...model, exports: [{ ...own, exportAttributionWithdrawn: true }] },
        "vulnerable",
      ),
      "a withdrawn binding that still carries an origin",
    ).toBeUndefined();
  });
});
