import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildResolvedTarget, identifyModule } from "./resolved-target.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-resolved-target-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

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

describe("identifyModule: authoritative package.json identity (VT-306, RWF-009)", () => {
  it("uses the installed package's own package.json name for a normal (non-aliased) package", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const file = write(
      root,
      "node_modules/foo/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("foo");
    expect(identity.packageInstance).toBe(path.join(root, "node_modules/foo"));
  });

  it("prefers package.json's declared name over the install directory name for an npm alias", () => {
    const root = tempProject();
    // Real npm-alias shape: "foo-alias": "npm:foo@1.2.3" -- installed at
    // node_modules/foo-alias, but the package's own package.json declares
    // its real name.
    write(
      root,
      "node_modules/foo-alias/package.json",
      JSON.stringify({ name: "foo", version: "1.2.3" }),
    );
    const file = write(
      root,
      "node_modules/foo-alias/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("foo");
    // The install LOCATION is unaffected by the alias -- it's still the
    // real directory the package lives in, never redefined by identity.
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/foo-alias"),
    );
  });

  it("gives two different aliases of the same real package the same identity but distinct instances", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo-old/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    const oldFile = write(
      root,
      "node_modules/foo-old/index.js",
      "module.exports = {};\n",
    );
    write(
      root,
      "node_modules/foo-new/package.json",
      JSON.stringify({ name: "foo", version: "2.0.0" }),
    );
    const newFile = write(
      root,
      "node_modules/foo-new/index.js",
      "module.exports = {};\n",
    );

    const oldIdentity = identifyModule(oldFile);
    const newIdentity = identifyModule(newFile);

    expect(oldIdentity.packageName).toBe("foo");
    expect(newIdentity.packageName).toBe("foo");
    // Same package identity, but the two installs must never collapse
    // into one instance (VT-212's own invariant, preserved here).
    expect(oldIdentity.packageInstance).not.toBe(newIdentity.packageInstance);
    expect(oldIdentity.packageInstance).toBe(
      path.join(root, "node_modules/foo-old"),
    );
    expect(newIdentity.packageInstance).toBe(
      path.join(root, "node_modules/foo-new"),
    );
  });

  it("uses package.json's declared name for a scoped package", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/@scope/pkg/package.json",
      JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }),
    );
    const file = write(
      root,
      "node_modules/@scope/pkg/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("@scope/pkg");
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/@scope/pkg"),
    );
  });

  it("prefers package.json's declared name for a scoped alias (unscoped install dir, scoped real name)", () => {
    const root = tempProject();
    // "scoped-alias": "npm:@scope/pkg@1.0.0" -- installed at a plain,
    // unscoped directory name, but the real package is scoped.
    write(
      root,
      "node_modules/scoped-alias/package.json",
      JSON.stringify({ name: "@scope/pkg", version: "1.0.0" }),
    );
    const file = write(
      root,
      "node_modules/scoped-alias/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("@scope/pkg");
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/scoped-alias"),
    );
  });

  it("falls back to the path-derived name when package.json is missing entirely", () => {
    const root = tempProject();
    // No package.json written at all for this install.
    const file = write(
      root,
      "node_modules/bare-pkg/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("bare-pkg");
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/bare-pkg"),
    );
  });

  it("falls back to the path-derived name when package.json has no valid name field", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/no-name-pkg/package.json",
      JSON.stringify({ version: "1.0.0" }),
    );
    const file = write(
      root,
      "node_modules/no-name-pkg/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("no-name-pkg");
  });

  it("falls back to the path-derived name when package.json is malformed JSON", () => {
    const root = tempProject();
    write(root, "node_modules/broken-pkg/package.json", "{ not valid json");
    const file = write(
      root,
      "node_modules/broken-pkg/index.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(file);

    expect(identity.packageName).toBe("broken-pkg");
  });

  it("never lets a fallback-derived identity override a valid package.json name, even for a deeper file within the package", () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo-alias/package.json",
      JSON.stringify({ name: "foo", version: "1.2.3" }),
    );
    const deepFile = write(
      root,
      "node_modules/foo-alias/lib/deep/file.js",
      "module.exports = {};\n",
    );

    const identity = identifyModule(deepFile);

    expect(identity.packageName).toBe("foo");
    expect(identity.packageInstance).toBe(
      path.join(root, "node_modules/foo-alias"),
    );
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
