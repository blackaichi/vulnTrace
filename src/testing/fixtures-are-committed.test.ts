import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every file under `fixtures/` and `tests/` must actually be COMMITTED.
 *
 * This exists because of a failure that passed locally on every run and
 * broke only in CI. `.gitignore`'s `dist/` rule (there for build output)
 * matches at ANY depth, so a hermetic fixture package laid out as
 * `packages/exportslib/dist/index.js` was silently excluded from the
 * commit. On the machine where it was written the files were present as
 * untracked files, so the fixture's own runtime oracle and three analyzer
 * tests all passed; a fresh checkout got a package whose `exports` map
 * pointed at files that did not exist, and `require("exportslib")` failed
 * with MODULE_NOT_FOUND.
 *
 * The existing fixtures avoid this by naming such directories `out/`
 * rather than `dist/` — a convention that was easy to miss precisely
 * because nothing enforced it. This enforces it, for any ignore rule, not
 * just that one.
 *
 * Deliberately checks only for IGNORED paths, never merely untracked ones:
 * a developer's scratch file under `fixtures/` is their business, while an
 * ignored one is a file that cannot be committed even deliberately, and is
 * therefore missing for everyone else.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Paths git would ignore under `directory`, as repo-relative strings. */
function ignoredPathsUnder(directory: string): string[] {
  const stdout = execFileSync(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "--",
      directory,
    ],
    { cwd: REPO_ROOT, encoding: "utf-8" },
  );
  return stdout.split("\n").filter((line) => line.length > 0);
}

describe("test data is committed, not silently ignored", () => {
  it.each(["fixtures", "tests"])(
    "has no git-ignored paths under %s/",
    (directory) => {
      // A non-empty list means some test input exists only on the machine
      // that wrote it. Rename the offending directory (the repo uses `out/`
      // where a package would naturally use `dist/`) rather than adding a
      // negation to .gitignore.
      expect(ignoredPathsUnder(directory)).toEqual([]);
    },
  );

  it("would catch the exact shape that broke CI", () => {
    // Guards the guard: `dist/` really is ignored at fixture depth, so the
    // assertion above is not vacuous.
    const probe = path.join(
      "fixtures",
      "workspaces",
      "packages",
      "exportslib",
      "dist",
      "index.js",
    );
    const output = execFileSync(
      "git",
      ["check-ignore", "-v", "--no-index", probe],
      {
        cwd: REPO_ROOT,
        encoding: "utf-8",
      },
    );
    expect(output).toContain("dist/");
  });
});
