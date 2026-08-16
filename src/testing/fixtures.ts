import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

/**
 * Absolute path to the repository's shared JS/TS test-project fixtures
 * (see docs/SDD.md § 31). Each subdirectory isolates one semantic behavior
 * (docs/MVP-IMPLEMENTATION-PLAN.md: "Every fixture should isolate one
 * semantic behavior").
 */
export const FIXTURES_ROOT = path.join(repoRoot, "fixtures");

/** Resolves an absolute path to a fixture, or a file/subdirectory within it. */
export function fixturePath(name: string, ...rest: string[]): string {
  return path.join(FIXTURES_ROOT, name, ...rest);
}

/** Reads a file within a fixture as UTF-8 text. */
export function readFixtureFile(name: string, ...rest: string[]): string {
  return readFileSync(fixturePath(name, ...rest), "utf-8");
}

/** True if a fixture directory with this name exists. */
export function fixtureExists(name: string): boolean {
  return existsSync(fixturePath(name));
}

/** Names of all fixture directories under fixtures/, sorted. */
export function listFixtures(): string[] {
  return readdirSync(FIXTURES_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}
