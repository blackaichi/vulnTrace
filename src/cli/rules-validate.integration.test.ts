import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runRulesValidateCommand } from "./rules-validate.js";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

describe("runRulesValidateCommand against the real repo rules file", () => {
  it("validates rules/vulntrace-rules.yml successfully", () => {
    const filePath = path.join(repoRoot, "rules", "vulntrace-rules.yml");
    const stdout: string[] = [];

    const exitCode = runRulesValidateCommand({
      filePathArg: filePath,
      io: { stdout: (text) => stdout.push(text), stderr: () => {} },
    });

    expect(exitCode).toBe(0);
    expect(stdout[0]).toContain("is valid");
  });
});
