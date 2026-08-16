import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fixtureExists,
  fixturePath,
  listFixtures,
  readFixtureFile,
} from "./fixtures.js";

/**
 * Every fixture category docs/SDD.md § 31 requires the test suite to cover.
 * This list is the contract: if a fixture directory is renamed or removed
 * without updating this list (or vice versa), this test fails.
 */
const REQUIRED_FIXTURES = [
  "alias",
  "commonjs",
  "conditional-exports",
  "destructuring",
  "direct-esm",
  "dynamic",
  "exports",
  "multiple-versions",
  "not-reachable",
  "transitive",
  "typescript-paths",
];

describe("fixture helpers", () => {
  it("lists every fixture category required by docs/SDD.md § 31", () => {
    const fixtures = listFixtures();

    for (const required of REQUIRED_FIXTURES) {
      expect(fixtures).toContain(required);
    }
  });

  it("resolves a path within a fixture", () => {
    const resolved = fixturePath("direct-esm", "package.json");
    expect(
      resolved.endsWith(path.join("fixtures", "direct-esm", "package.json")),
    ).toBe(true);
  });

  it("reads and parses a real fixture file", () => {
    const content = readFixtureFile("direct-esm", "package.json");
    const parsed: unknown = JSON.parse(content);

    expect(parsed).toMatchObject({ name: "fixture-direct-esm" });
  });

  it("reports existence correctly", () => {
    expect(fixtureExists("direct-esm")).toBe(true);
    expect(fixtureExists("does-not-exist")).toBe(false);
  });
});
