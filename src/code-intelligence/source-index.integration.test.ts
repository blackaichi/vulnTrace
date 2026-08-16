import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { indexSourceFileFromDisk } from "./source-index.js";

describe("indexSourceFileFromDisk against real fixture files", () => {
  it("indexes fixtures/direct-esm/src/index.ts", () => {
    const index = indexSourceFileFromDisk(
      fixturePath("direct-esm", "src", "index.ts"),
    );

    expect(index.imports).toEqual([
      {
        specifier: "fixture-lib",
        bindingKind: "named",
        localName: "vulnerable",
        importedName: "vulnerable",
        location: expect.objectContaining({ line: 1 }),
      },
    ]);

    expect(index.functions).toEqual([
      {
        kind: "function",
        name: "main",
        isAsync: false,
        location: expect.objectContaining({ line: 3 }),
      },
    ]);

    expect(index.exports).toEqual([
      {
        bindingKind: "named",
        exportedName: "main",
        localName: "main",
        location: expect.objectContaining({ line: 3 }),
      },
    ]);
  });

  it("indexes fixtures/commonjs/src/index.cjs", () => {
    const index = indexSourceFileFromDisk(
      fixturePath("commonjs", "src", "index.cjs"),
    );

    expect(index.imports).toEqual([
      {
        specifier: "fixture-lib",
        bindingKind: "commonjs",
        localName: "fixture",
        location: expect.objectContaining({ line: 1 }),
      },
    ]);

    // `module.exports = function main() {...}` is both the module's
    // CommonJS export AND a named function expression.
    expect(index.functions).toEqual([
      {
        kind: "function",
        name: "main",
        isAsync: false,
        location: expect.objectContaining({ line: 3 }),
      },
    ]);

    expect(index.exports).toEqual([
      {
        bindingKind: "commonjs-module-exports",
        location: expect.objectContaining({ line: 3 }),
      },
    ]);
  });

  it("indexes fixtures/direct-esm/node_modules/fixture-lib/index.js (two exported functions)", () => {
    const index = indexSourceFileFromDisk(
      fixturePath("direct-esm", "node_modules", "fixture-lib", "index.js"),
    );

    expect(index.functions.map((fn) => fn.name)).toEqual([
      "vulnerable",
      "safe",
    ]);
    expect(index.exports.map((entry) => entry.exportedName)).toEqual([
      "vulnerable",
      "safe",
    ]);
  });
});
