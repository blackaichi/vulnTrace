import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fixturePath } from "../testing/fixtures.js";
import { loadPackageJsonFile } from "./package-json.js";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

describe("loadPackageJsonFile against real package.json files", () => {
  it("reads fixtures/direct-esm/package.json", () => {
    const pkg = loadPackageJsonFile(fixturePath("direct-esm", "package.json"));

    expect(pkg.name).toBe("fixture-direct-esm");
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies).toEqual({ "fixture-lib": "1.0.0" });
  });

  it("reads fixtures/transitive/package.json", () => {
    const pkg = loadPackageJsonFile(fixturePath("transitive", "package.json"));

    expect(pkg.name).toBe("fixture-transitive");
    expect(pkg.dependencies).toEqual({ "fixture-wrapper": "1.0.0" });
  });

  it("reads the repository's own package.json (real scripts/dependencies)", () => {
    const pkg = loadPackageJsonFile(path.join(repoRoot, "package.json"));

    expect(pkg.name).toBe("vulntrace");
    expect(pkg.scripts.build).toBe("tsc -p tsconfig.build.json");
    expect(pkg.dependencies.zod).toBeDefined();
    expect(pkg.devDependencies.vitest).toBeDefined();
  });
});
