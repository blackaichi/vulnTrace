import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCli } from "./run.js";

const repoRoot = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);

function fakeIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (t: string) => stdout.push(t),
      stderr: (t: string) => stderr.push(t),
    },
    stdout,
    stderr,
  };
}

describe("runCli: command dispatch", () => {
  it("dispatches 'version' to the version command", async () => {
    const { io, stdout } = fakeIo();

    const exitCode = await runCli(["version"], io);

    expect(exitCode).toBe(0);
    expect(stdout[0]).toMatch(/^vulntrace \d+\.\d+\.\d+\n$/);
  });

  it("dispatches 'rules validate <file>' to the rules-validate command", async () => {
    const { io, stdout } = fakeIo();

    const exitCode = await runCli(
      [
        "rules",
        "validate",
        path.join(repoRoot, "rules", "vulntrace-rules.yml"),
      ],
      io,
    );

    expect(exitCode).toBe(0);
    expect(stdout[0]).toContain("is valid");
  });

  it("prints usage and returns exit code 2 for an unknown command", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli(["frobnicate"], io);

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("usage");
  });

  it("prints usage and returns exit code 2 for no command at all", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli([], io);

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("usage");
  });

  it("returns exit code 2 for 'scan' with no path", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli(["scan"], io);

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("usage");
  });

  it("returns exit code 2 for 'rules validate' with no file", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli(["rules", "validate"], io);

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("usage");
  });

  it("returns exit code 2 for an unsupported --format value", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli(["scan", ".", "--format", "xml"], io);

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("--format");
  });

  it("returns exit code 2 when --cve is given as a boolean flag with no value", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli(["scan", ".", "--cve"], io);

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("--cve");
  });

  it("returns exit code 2 when --config is given as a boolean flag with no value", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli(["scan", ".", "--config"], io);

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("--config");
  });

  it("returns exit code 2 for a scan against a nonexistent project path", async () => {
    const { io, stderr } = fakeIo();

    const exitCode = await runCli(["scan", "/nonexistent/project/path"], io);

    expect(exitCode).toBe(2);
    expect(stderr[0]).toContain("does not exist");
  });
});
