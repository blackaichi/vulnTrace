import { describe, expect, it } from "vitest";
import { runCli } from "./cli.js";

describe("cli.ts entrypoint", () => {
  it("re-exports the real command dispatcher (see src/cli/run.ts)", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(["version"], {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    });

    expect(exitCode).toBe(0);
    expect(stdout.join("")).toMatch(/^vulntrace \d+\.\d+\.\d+\n$/);
    expect(stderr).toEqual([]);
  });
});
