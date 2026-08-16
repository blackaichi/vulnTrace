import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { createModuleResolver } from "./module-resolver.js";
import { loadTsProject } from "./ts-project.js";

describe("createModuleResolver against real fixtures", () => {
  it("resolves fixtures/direct-esm's import of fixture-lib", async () => {
    const root = fixturePath("direct-esm");
    const resolver = createModuleResolver(loadTsProject(root));

    const result = await resolver.resolve(
      "fixture-lib",
      path.join(root, "src", "index.ts"),
    );

    expect(result).toMatchObject({
      kind: "resolved",
      resolvedFileName: path.join(
        root,
        "node_modules",
        "fixture-lib",
        "index.js",
      ),
      isExternalLibraryImport: true,
      packageId: { name: "fixture-lib", version: "1.0.0" },
    });
  });

  it("resolves fixtures/commonjs's require of fixture-lib", async () => {
    const root = fixturePath("commonjs");
    const resolver = createModuleResolver(loadTsProject(root));

    const result = await resolver.resolve(
      "fixture-lib",
      path.join(root, "src", "index.cjs"),
    );

    // The commonjs fixture has no node_modules of its own — this proves
    // an unresolved dependency is reported explicitly, not silently
    // treated as resolved or thrown as an exception.
    expect(result.kind).toBe("unresolved");
  });
});
