import { describe, expect, it } from "vitest";
import type { Entrypoint } from "./entrypoint.js";

describe("Entrypoint", () => {
  it("carries evidence for why a file was selected", () => {
    const entrypoint: Entrypoint = {
      filePath: "/project/src/index.ts",
      source: "configured",
      reason: "analysis.entrypoints[0]: src/index.ts",
    };

    expect(entrypoint.source).toBe("configured");
    expect(entrypoint.reason).toContain("analysis.entrypoints");
  });

  it("carries the bin command name for package_bin entrypoints", () => {
    const entrypoint: Entrypoint = {
      filePath: "/project/bin/cli.js",
      source: "package_bin",
      reason: "package.json bin.vulntrace",
      binName: "vulntrace",
    };

    expect(entrypoint.binName).toBe("vulntrace");
  });
});
