import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { buildModuleModel } from "./module-model.js";
import { indexSourceFileFromDisk } from "./source-index.js";

describe("buildModuleModel against real fixture files", () => {
  it("models fixtures/direct-esm/src/index.ts (ESM)", () => {
    const model = buildModuleModel(
      indexSourceFileFromDisk(fixturePath("direct-esm", "src", "index.ts")),
    );

    expect(model.imports).toEqual([
      expect.objectContaining({
        specifier: "fixture-lib",
        kind: "named",
        syntax: "esm",
        localName: "vulnerable",
        importedName: "vulnerable",
      }),
    ]);
    expect(model.exports).toEqual([
      expect.objectContaining({
        kind: "named",
        syntax: "esm",
        exportedName: "main",
      }),
    ]);
  });

  it("models fixtures/commonjs/src/index.cjs (CommonJS)", () => {
    const model = buildModuleModel(
      indexSourceFileFromDisk(fixturePath("commonjs", "src", "index.cjs")),
    );

    expect(model.imports).toEqual([
      expect.objectContaining({
        specifier: "fixture-lib",
        kind: "default",
        syntax: "commonjs",
        localName: "fixture",
      }),
    ]);
    // `module.exports = function main() {...}` is a non-object-literal
    // assignment, so it stays a single whole-module default export.
    expect(model.exports).toEqual([
      expect.objectContaining({ kind: "default", syntax: "commonjs" }),
    ]);
  });

  it("models fixtures/direct-esm/node_modules/fixture-lib/index.js (two named ESM exports)", () => {
    const model = buildModuleModel(
      indexSourceFileFromDisk(
        fixturePath("direct-esm", "node_modules", "fixture-lib", "index.js"),
      ),
    );

    expect(model.exports.map((entry) => entry.exportedName)).toEqual([
      "vulnerable",
      "safe",
    ]);
    expect(model.exports.every((entry) => entry.syntax === "esm")).toBe(true);
  });
});
