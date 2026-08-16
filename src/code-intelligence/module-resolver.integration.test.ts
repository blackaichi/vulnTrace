import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

  it("reports a genuinely uninstalled package as unresolved, not silently resolved or thrown", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "vulntrace-module-resolver-unresolved-"),
    );
    try {
      const resolver = createModuleResolver(loadTsProject(root));

      const result = await resolver.resolve(
        "does-not-exist-fixture-package",
        path.join(root, "index.cjs"),
      );

      expect(result.kind).toBe("unresolved");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
