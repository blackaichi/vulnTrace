import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunScanOptions } from "./scan.js";

/**
 * Task B-5 -- the scan command's flags, at the CLI boundary.
 *
 *  - PRM-111: `--cve ""` was accepted and used as a filter that matches
 *    nothing: zero findings, exit 0, no diagnostic.
 *  - Decision 3: `--lenient-exit` restores the exit-0-whenever-nothing-
 *    AFFECTED behaviour, and reaches the scan as exactly that.
 *
 * The scan itself is replaced, so these tests see exactly the options
 * `runCli` hands it -- and that it is never called for a usage error.
 */

/** `lenientExit` is B-5's; typed here so this file compiles on the base. */
const calls: (RunScanOptions & { readonly lenientExit?: boolean })[] = [];

vi.mock("./scan.js", () => ({
  runScanCommand: (options: RunScanOptions) => {
    calls.push(options);
    return Promise.resolve(0);
  },
}));

const { runCli } = await import("./run.js");

function fakeIo() {
  const stderr: string[] = [];
  return {
    io: { stdout: () => undefined, stderr: (t: string) => stderr.push(t) },
    stderr,
  };
}

beforeEach(() => {
  calls.length = 0;
});

describe("B-5 (PRM-111): an empty --cve is a usage error, never a filter", () => {
  it.each([
    ["--cve ''", ["scan", ".", "--cve", ""]],
    ["--cve=", ["scan", ".", "--cve="]],
    ["a blank --cve", ["scan", ".", "--cve", "   "]],
    ["a --cve with surrounding whitespace", ["scan", ".", "--cve", " CVE-1"]],
  ])("%s exits 2 and never scans", async (_label, argv) => {
    const { io, stderr } = fakeIo();
    expect(await runCli(argv, io)).toBe(2);
    expect(stderr.join("")).toContain("--cve");
    expect(calls).toEqual([]);
  });

  it("a real --cve value still reaches the scan unchanged", async () => {
    const { io } = fakeIo();
    expect(await runCli(["scan", ".", "--cve", "CVE-2024-0001"], io)).toBe(0);
    expect(calls.map((c) => c.cveFilter)).toEqual(["CVE-2024-0001"]);
  });
});

describe("B-5 (decision 3): --lenient-exit", () => {
  it("reaches the scan as lenientExit: true", async () => {
    const { io } = fakeIo();
    await runCli(["scan", ".", "--lenient-exit"], io);
    expect(calls.map((c) => c.lenientExit)).toEqual([true]);
  });

  it("is off unless given", async () => {
    const { io } = fakeIo();
    await runCli(["scan", "."], io);
    expect(calls.map((c) => c.lenientExit)).toEqual([false]);
  });

  it.each([
    ["--lenient-exit=true", ["scan", ".", "--lenient-exit=true"]],
    ["--lenient-exit=false", ["scan", ".", "--lenient-exit=false"]],
    ["--lenient-exit <word>", ["scan", ".", "--lenient-exit", "yes"]],
  ])("%s takes no value: exits 2 and never scans", async (_label, argv) => {
    const { io, stderr } = fakeIo();
    expect(await runCli(argv, io)).toBe(2);
    expect(stderr.join("")).toContain("--lenient-exit");
    expect(calls).toEqual([]);
  });

  it("is in the usage text", async () => {
    const { io, stderr } = fakeIo();
    await runCli(["frobnicate"], io);
    expect(stderr.join("")).toContain("--lenient-exit");
  });
});
