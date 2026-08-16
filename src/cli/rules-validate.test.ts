import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRulesValidateCommand } from "./rules-validate.js";

describe("runRulesValidateCommand", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("returns exit code 0 and reports the rule count for a valid rules file", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-rules-validate-"));
    const filePath = path.join(tmpDir, "rules.yml");
    writeFileSync(
      filePath,
      "rules:\n" +
        "  - id: GHSA-fixture-0001\n" +
        "    package:\n" +
        "      name: fixture-lib\n" +
        "    targets:\n" +
        "      - module: fixture-lib\n" +
        "        export: vulnerable\n",
    );

    const stdout: string[] = [];
    const exitCode = runRulesValidateCommand({
      filePathArg: filePath,
      io: { stdout: (text) => stdout.push(text), stderr: () => {} },
    });

    expect(exitCode).toBe(0);
    expect(stdout[0]).toContain("is valid (1 rule)");
  });

  it("returns exit code 2 and reports an error for a rules file that fails schema validation", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-rules-validate-"));
    const filePath = path.join(tmpDir, "rules.yml");
    writeFileSync(filePath, "rules:\n  - id: missing-package-and-targets\n");

    const stderr: string[] = [];
    const exitCode = runRulesValidateCommand({
      filePathArg: filePath,
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("Invalid rule");
  });

  it("returns exit code 2 and reports an error for a rules file that does not exist", () => {
    const stderr: string[] = [];
    const exitCode = runRulesValidateCommand({
      filePathArg: "/nonexistent/rules.yml",
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("not found");
  });

  it("returns exit code 2 for duplicate rule ids within one file", () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-rules-validate-"));
    const filePath = path.join(tmpDir, "rules.yml");
    writeFileSync(
      filePath,
      "rules:\n" +
        "  - id: GHSA-dup\n" +
        "    package:\n" +
        "      name: a\n" +
        "    targets:\n" +
        "      - module: a\n" +
        "        export: f\n" +
        "  - id: GHSA-dup\n" +
        "    package:\n" +
        "      name: b\n" +
        "    targets:\n" +
        "      - module: b\n" +
        "        export: g\n",
    );

    const stderr: string[] = [];
    const exitCode = runRulesValidateCommand({
      filePathArg: filePath,
      io: { stdout: () => {}, stderr: (text) => stderr.push(text) },
    });

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("Duplicate rule id");
  });
});
