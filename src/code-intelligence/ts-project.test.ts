import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TsProjectRootNotFoundError } from "./ts-project-errors.js";
import { loadTsProject } from "./ts-project.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-ts-project-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("loadTsProject: plain JavaScript projects", () => {
  it("returns a valid result with no configFilePath when no tsconfig.json exists", () => {
    const dir = tempProject();
    writeFileSync(path.join(dir, "index.js"), "module.exports = {};\n");

    const project = loadTsProject(dir);

    expect(project.configFilePath).toBeUndefined();
    expect(project.projectRoot).toBe(path.resolve(dir));
    expect(project.rootDir).toBe(path.resolve(dir));
    expect(project.fileNames).toEqual([]);
    expect(project.diagnostics).toEqual([]);
    expect(project.compilerOptions.allowJs).toBe(true);
  });
});

describe("loadTsProject: TypeScript projects", () => {
  it("discovers tsconfig.json and represents relevant compiler options", () => {
    const dir = tempProject();
    mkdirSync(path.join(dir, "src"));
    writeFileSync(path.join(dir, "src", "index.ts"), "export const x = 1;\n");
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@app/*": ["src/*"] },
          rootDir: "src",
          outDir: "dist",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          esModuleInterop: true,
          resolveJsonModule: true,
        },
        include: ["src/**/*.ts"],
      }),
    );

    const project = loadTsProject(dir);

    expect(project.configFilePath).toBe(
      path.join(path.resolve(dir), "tsconfig.json"),
    );
    expect(project.rootDir).toBe(path.join(path.resolve(dir), "src"));
    // TypeScript resolves baseUrl to an absolute path during parsing
    // (relative to the config file's directory), rather than preserving
    // the raw "." from the source JSON.
    expect(project.compilerOptions.baseUrl).toBe(path.resolve(dir));
    expect(project.compilerOptions.paths).toEqual({ "@app/*": ["src/*"] });
    expect(project.compilerOptions.module).toBe("NodeNext");
    expect(project.compilerOptions.moduleResolution).toBe("NodeNext");
    expect(project.compilerOptions.target).toBe("ES2022");
    expect(project.compilerOptions.esModuleInterop).toBe(true);
    expect(project.compilerOptions.resolveJsonModule).toBe(true);
    expect(project.diagnostics).toEqual([]);
    expect(
      project.fileNames.some((file) => file.endsWith("src/index.ts")),
    ).toBe(true);
  });

  it("falls back to the config file's directory as rootDir when unset", () => {
    const dir = tempProject();
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({}));

    const project = loadTsProject(dir);

    expect(project.rootDir).toBe(path.resolve(dir));
  });

  it("accepts an explicit configFilePath override", () => {
    const dir = tempProject();
    writeFileSync(
      path.join(dir, "tsconfig.custom.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );

    const project = loadTsProject(dir, {
      configFilePath: path.join(dir, "tsconfig.custom.json"),
    });

    expect(project.configFilePath).toBe(
      path.resolve(dir, "tsconfig.custom.json"),
    );
  });
});

describe("loadTsProject: malformed tsconfig.json degrades to diagnostics, never throws", () => {
  it("reports a diagnostic for invalid JSON rather than throwing", () => {
    const dir = tempProject();
    writeFileSync(path.join(dir, "tsconfig.json"), "{ not valid json");

    const project = loadTsProject(dir);

    expect(project.configFilePath).toBeDefined();
    expect(project.diagnostics.length).toBeGreaterThan(0);
  });

  it("reports a diagnostic for an invalid compiler option value", () => {
    const dir = tempProject();
    writeFileSync(
      path.join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "not-a-real-target" } }),
    );

    const project = loadTsProject(dir);

    expect(project.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("loadTsProject: project boundaries", () => {
  it("throws TsProjectRootNotFoundError for a nonexistent project root", () => {
    const dir = tempProject();
    const missing = path.join(dir, "does-not-exist");

    expect(() => loadTsProject(missing)).toThrow(TsProjectRootNotFoundError);
  });

  it("does not walk up to a parent directory's tsconfig.json", () => {
    const parent = tempProject();
    writeFileSync(
      path.join(parent, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    const child = path.join(parent, "nested-project");
    mkdirSync(child);
    writeFileSync(path.join(child, "index.js"), "module.exports = {};\n");

    const project = loadTsProject(child);

    expect(project.configFilePath).toBeUndefined();
  });
});
