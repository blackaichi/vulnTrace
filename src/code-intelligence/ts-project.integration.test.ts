import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { loadTsProject } from "./ts-project.js";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

describe("loadTsProject against this repository's own real project", () => {
  it("discovers this repo's real tsconfig.json and reflects its real options", () => {
    const project = loadTsProject(repoRoot);

    expect(project.configFilePath).toBe(path.join(repoRoot, "tsconfig.json"));
    expect(project.compilerOptions.module).toBe("NodeNext");
    expect(project.compilerOptions.moduleResolution).toBe("NodeNext");
    expect(project.compilerOptions.target).toBe("ES2022");
    expect(project.diagnostics).toEqual([]);
    expect(project.fileNames.some((file) => file.endsWith("src/cli.ts"))).toBe(
      true,
    );
  });
});

describe("loadTsProject: real project-boundary containment", () => {
  it("does not leak this repo's root tsconfig.json into a nested fixture with none of its own", () => {
    // fixtures/direct-esm has no tsconfig.json of its own, but is nested
    // inside this very repository, which does. A naive upward search
    // (ts.findConfigFile's default behavior) would incorrectly discover
    // the repo's own tsconfig.json here.
    const project = loadTsProject(fixturePath("direct-esm"));

    expect(project.configFilePath).toBeUndefined();
  });
});
