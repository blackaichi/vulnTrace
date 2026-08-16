import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import { discoverEntrypoints } from "./entrypoints.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-entrypoints-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function resolverFor(root: string) {
  return createModuleResolver(loadTsProject(root));
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("discoverEntrypoints: configured entrypoints", () => {
  it("resolves an existing configured entrypoint with evidence", async () => {
    const root = tempProject();
    const entryFile = write(root, "src/index.ts", "export {};\n");

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
      configuredEntrypoints: ["src/index.ts"],
    });

    expect(result.entrypoints).toEqual([
      {
        filePath: entryFile,
        source: "configured",
        reason: "analysis.entrypoints[0]: src/index.ts",
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports a diagnostic for a configured entrypoint that does not exist", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
      configuredEntrypoints: ["src/missing.ts"],
    });

    expect(result.entrypoints).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        source: "configured",
        message: "analysis.entrypoints[0] does not exist: src/missing.ts",
      },
    ]);
  });
});

describe("discoverEntrypoints: explicit files", () => {
  it("resolves an explicitly supplied file independently of configuration", async () => {
    const root = tempProject();
    const entryFile = write(root, "src/cli.ts", "export {};\n");

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
      explicitFiles: ["src/cli.ts"],
    });

    expect(result.entrypoints).toEqual([
      {
        filePath: entryFile,
        source: "explicit",
        reason: "explicit entrypoint[0]: src/cli.ts",
      },
    ]);
  });
});

describe("discoverEntrypoints: package.json main", () => {
  it("resolves a relative main field", async () => {
    const root = tempProject();
    const mainFile = write(root, "lib/index.js", "module.exports = {};\n");
    write(
      root,
      "package.json",
      JSON.stringify({ name: "fixture", main: "./lib/index.js" }),
    );

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
    });

    expect(result.entrypoints).toEqual([
      {
        filePath: mainFile,
        source: "package_main",
        reason: "package.json main field",
      },
    ]);
  });

  it("resolves a main field without a leading './'", async () => {
    const root = tempProject();
    const mainFile = write(root, "index.js", "module.exports = {};\n");
    write(
      root,
      "package.json",
      JSON.stringify({ name: "fixture", main: "index.js" }),
    );

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
    });

    expect(result.entrypoints[0]).toMatchObject({ filePath: mainFile });
  });

  it("reports a diagnostic when main cannot be resolved", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "fixture", main: "./does-not-exist.js" }),
    );

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
    });

    expect(result.entrypoints).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.source).toBe("package_main");
  });
});

describe("discoverEntrypoints: package.json bin", () => {
  it("resolves a string bin field using the package name", async () => {
    const root = tempProject();
    const binFile = write(root, "bin/cli.js", "#!/usr/bin/env node\n");
    write(
      root,
      "package.json",
      JSON.stringify({ name: "vulntrace", bin: "./bin/cli.js" }),
    );

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
    });

    expect(result.entrypoints).toEqual([
      {
        filePath: binFile,
        source: "package_bin",
        reason: "package.json bin.vulntrace",
        binName: "vulntrace",
      },
    ]);
  });

  it("resolves every entry of an object bin field", async () => {
    const root = tempProject();
    const fooBin = write(root, "bin/foo.js", "");
    const barBin = write(root, "bin/bar.js", "");
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "fixture",
        bin: { foo: "./bin/foo.js", bar: "./bin/bar.js" },
      }),
    );

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
    });

    expect(result.entrypoints).toHaveLength(2);
    expect(result.entrypoints).toContainEqual(
      expect.objectContaining({ filePath: fooBin, binName: "foo" }),
    );
    expect(result.entrypoints).toContainEqual(
      expect.objectContaining({ filePath: barBin, binName: "bar" }),
    );
  });
});

describe("discoverEntrypoints: package.json presence", () => {
  it("produces no diagnostic when package.json is simply absent", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
    });

    expect(result.entrypoints).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports a diagnostic when package.json exists but is malformed", async () => {
    const root = tempProject();
    write(root, "package.json", "{ not valid json");

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
    });

    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.message).toContain("could not be read");
  });
});

describe("discoverEntrypoints: path traversal is rejected (TASK-028 security hardening)", () => {
  // Regression: analysis.entrypoints and package.json main/bin are read
  // from the scanned project's own files -- entirely attacker-controlled
  // (docs/SDD.md § 29: "must not trust target project configuration
  // blindly"). Before this fix, a value like "../../../../etc/passwd" or
  // an absolute path elsewhere on the host was silently accepted and fed
  // straight into the call graph builder for static parsing. Reproduced
  // directly against /etc/passwd before landing this fix.

  it("rejects a configured entrypoint that escapes the project root via '../' traversal", async () => {
    const root = tempProject();
    write(root, "src/index.ts", "export {};\n");
    const outsideFile = write(
      tempProject(),
      "secret.js",
      "module.exports = {};\n",
    );
    const relativeEscape = path.relative(root, outsideFile);

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
      configuredEntrypoints: [relativeEscape],
    });

    expect(result.entrypoints).toEqual([]);
    expect(result.diagnostics).toEqual([
      {
        source: "configured",
        message: `analysis.entrypoints[0] resolves outside the project root and was rejected: ${relativeEscape}`,
      },
    ]);
  });

  it("rejects an explicit entrypoint given as an absolute path outside the project root", async () => {
    const root = tempProject();
    const outsideFile = write(
      tempProject(),
      "secret.js",
      "module.exports = {};\n",
    );

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
      explicitFiles: [outsideFile],
    });

    expect(result.entrypoints).toEqual([]);
    expect(result.diagnostics[0]?.message).toContain(
      "resolves outside the project root",
    );
  });

  it("rejects a package.json main field that resolves outside the project root", async () => {
    const root = tempProject();
    const outsideFile = write(
      tempProject(),
      "secret.js",
      "module.exports = {};\n",
    );
    const relativeEscape = path.relative(root, outsideFile);
    write(
      root,
      "package.json",
      JSON.stringify({ name: "fixture", main: relativeEscape }),
    );

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
    });

    expect(result.entrypoints).toEqual([]);
    expect(result.diagnostics[0]?.source).toBe("package_main");
    expect(result.diagnostics[0]?.message).toContain(
      "resolves outside the project root",
    );
  });

  it("still accepts a legitimate entrypoint alongside a rejected traversal attempt", async () => {
    const root = tempProject();
    const legitFile = write(root, "src/index.ts", "export {};\n");
    const outsideFile = write(
      tempProject(),
      "secret.js",
      "module.exports = {};\n",
    );
    const relativeEscape = path.relative(root, outsideFile);

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
      configuredEntrypoints: [relativeEscape, "src/index.ts"],
    });

    expect(result.entrypoints).toEqual([
      {
        filePath: legitFile,
        source: "configured",
        reason: "analysis.entrypoints[1]: src/index.ts",
      },
    ]);
    expect(result.diagnostics).toHaveLength(1);
  });
});

describe("discoverEntrypoints: combined sources", () => {
  it("combines configured, main, and bin entrypoints in one result", async () => {
    const root = tempProject();
    const configuredFile = write(root, "src/index.ts", "export {};\n");
    const mainFile = write(root, "lib/index.js", "module.exports = {};\n");
    const binFile = write(root, "bin/cli.js", "");
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "fixture",
        main: "./lib/index.js",
        bin: "./bin/cli.js",
      }),
    );

    const result = await discoverEntrypoints({
      projectRoot: root,
      resolver: resolverFor(root),
      configuredEntrypoints: ["src/index.ts"],
    });

    const filePaths = result.entrypoints.map((e) => e.filePath).sort();
    expect(filePaths).toEqual([configuredFile, mainFile, binFile].sort());
  });
});
