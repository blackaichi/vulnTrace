import path from "node:path";
import { describe, expect, it } from "vitest";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { fixturePath } from "../testing/fixtures.js";
import { discoverEntrypoints } from "./entrypoints.js";

describe("discoverEntrypoints against a real fixture", () => {
  it("resolves fixtures/direct-esm's configured entrypoint (no main/bin field present)", async () => {
    const root = fixturePath("direct-esm");
    const resolver = createModuleResolver(loadTsProject(root));

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver,
      configuredEntrypoints: ["src/index.ts"],
    });

    expect(result.entrypoints).toEqual([
      {
        filePath: path.join(root, "src", "index.ts"),
        source: "configured",
        reason: "analysis.entrypoints[0]: src/index.ts",
      },
    ]);
    // fixtures/direct-esm/package.json has no main/bin field, so no other
    // entrypoints are discovered — and, correctly, no diagnostic either.
    expect(result.diagnostics).toEqual([]);
  });
});
