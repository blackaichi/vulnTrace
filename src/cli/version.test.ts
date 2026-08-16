import { describe, expect, it } from "vitest";
import { runVersionCommand } from "./version.js";

describe("runVersionCommand", () => {
  it("prints 'vulntrace <version>' to stdout and returns exit code 0", () => {
    const stdout: string[] = [];

    const exitCode = runVersionCommand({
      stdout: (text) => stdout.push(text),
      stderr: () => {
        throw new Error("must not write to stderr");
      },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toHaveLength(1);
    expect(stdout[0]).toMatch(/^vulntrace \d+\.\d+\.\d+\n$/);
  });
});
