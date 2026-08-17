import { describe, expect, it } from "vitest";
import { buildResolvedTarget, identifyModule } from "./resolved-target.js";

describe("identifyModule", () => {
  it("identifies a top-level installed package", () => {
    const identity = identifyModule("/project/node_modules/foo/index.js");

    expect(identity).toEqual({
      packageName: "foo",
      packageInstance: "/project/node_modules/foo",
      resolvedFile: "/project/node_modules/foo/index.js",
    });
  });

  it(
    "distinguishes a nested, non-hoisted install from a top-level install of the " +
      "same package name (SDD-v0.2.md § 4.2)",
    () => {
      const topLevel = identifyModule("/project/node_modules/foo/index.js");
      const nested = identifyModule(
        "/project/node_modules/bar/node_modules/foo/index.js",
      );

      expect(topLevel.packageName).toBe("foo");
      expect(nested.packageName).toBe("foo");
      // Same package name, but the two installs must never collapse into
      // one identity.
      expect(nested.packageInstance).not.toBe(topLevel.packageInstance);
      expect(nested.packageInstance).toBe(
        "/project/node_modules/bar/node_modules/foo",
      );
    },
  );

  it("treats a scoped package name as a single segment", () => {
    const identity = identifyModule(
      "/project/node_modules/@scope/pkg/index.js",
    );

    expect(identity).toEqual({
      packageName: "@scope/pkg",
      packageInstance: "/project/node_modules/@scope/pkg",
      resolvedFile: "/project/node_modules/@scope/pkg/index.js",
    });
  });

  it("distinguishes a nested scoped package install from a top-level one", () => {
    const topLevel = identifyModule(
      "/project/node_modules/@scope/pkg/index.js",
    );
    const nested = identifyModule(
      "/project/node_modules/bar/node_modules/@scope/pkg/index.js",
    );

    expect(nested.packageName).toBe(topLevel.packageName);
    expect(nested.packageInstance).not.toBe(topLevel.packageInstance);
    expect(nested.packageInstance).toBe(
      "/project/node_modules/bar/node_modules/@scope/pkg",
    );
  });

  it("resolves a deeper file within the package to the same instance", () => {
    const shallow = identifyModule("/project/node_modules/foo/index.js");
    const deep = identifyModule("/project/node_modules/foo/lib/deep/file.js");

    expect(deep.packageInstance).toBe(shallow.packageInstance);
    expect(deep.packageName).toBe(shallow.packageName);
  });

  it("has no package identity for a file with no node_modules segment", () => {
    const identity = identifyModule("/project/src/index.ts");

    expect(identity).toEqual({ resolvedFile: "/project/src/index.ts" });
  });
});

describe("buildResolvedTarget", () => {
  it("derives moduleId and top-level package identity consistently from the same resolved file", () => {
    const target = buildResolvedTarget(
      "/project/node_modules/bar/node_modules/foo/index.js",
      { exportedSymbol: "vulnerable", packageVersion: "1.0.0" },
    );

    expect(target.moduleId).toEqual(
      identifyModule("/project/node_modules/bar/node_modules/foo/index.js"),
    );
    expect(target.packageName).toBe("foo");
    expect(target.packageInstance).toBe(
      "/project/node_modules/bar/node_modules/foo",
    );
    expect(target.packageVersion).toBe("1.0.0");
    expect(target.exportedSymbol).toBe("vulnerable");
    expect(target.resolvedFile).toBe(
      "/project/node_modules/bar/node_modules/foo/index.js",
    );
  });

  it("defaults resolutionEvidence to an empty array when not provided", () => {
    const target = buildResolvedTarget("/project/src/index.ts");

    expect(target.resolutionEvidence).toEqual([]);
    expect(target.packageName).toBeUndefined();
    expect(target.packageInstance).toBeUndefined();
  });

  it("preserves supplied resolutionEvidence and symbolId", () => {
    const target = buildResolvedTarget("/project/node_modules/foo/index.js", {
      exportedSymbol: "vulnerable",
      symbolId: "/project/node_modules/foo/index.js#vulnerable@1:1",
      resolutionEvidence: ["resolved via named ESM import"],
    });

    expect(target.symbolId).toBe(
      "/project/node_modules/foo/index.js#vulnerable@1:1",
    );
    expect(target.resolutionEvidence).toEqual([
      "resolved via named ESM import",
    ]);
  });
});
