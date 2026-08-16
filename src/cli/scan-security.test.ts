import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { VulnerabilityProvider } from "../domain/vulnerability.js";
import { runScanCommand } from "./scan.js";

/**
 * TASK-028 — proves security-hardening behavior through the real
 * `runScanCommand`, complementing the lower-layer unit tests
 * (src/analysis/entrypoints.test.ts's path-traversal tests,
 * src/code-intelligence/call-graph.test.ts's resource-limit tests,
 * src/vulnerabilities/osv-{normalizer,provider}.test.ts's adversarial-input
 * tests).
 */

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

function fakeProvider(): VulnerabilityProvider {
  return { queryPackage: () => Promise.resolve([]) };
}

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function tempProject(): string {
  tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-scan-security-"));
  return tmpDir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function writeManifests(root: string): void {
  write(
    root,
    "package.json",
    JSON.stringify({ name: "fixture", version: "1.0.0", type: "module" }),
  );
  write(
    root,
    "package-lock.json",
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "fixture", version: "1.0.0" } },
    }),
  );
}

/** A chain file0 -> file1 -> ... -> file{count-1}, each calling the next. */
function buildChain(root: string, count: number): void {
  for (let i = 0; i < count; i++) {
    const body =
      i + 1 < count
        ? `import { fn${i + 1} } from "./file${i + 1}.js";\n` +
          `export function fn${i}() { return fn${i + 1}(); }\n`
        : `export function fn${i}() { return ${i}; }\n`;
    write(root, `src/file${i}.js`, body);
  }
}

describe("runScanCommand: resource limits are enforced and diagnosed", () => {
  it("truncates the call graph and reports a diagnostic when analysis.limits.maxFiles is reached", async () => {
    const root = tempProject();
    writeManifests(root);
    buildChain(root, 20);
    const configPath = path.join(root, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n" +
        "  entrypoints:\n    - src/file0.js\n" +
        "  limits:\n    maxFiles: 5\n",
    );
    const { io, stdout } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: root,
      configPathOverride: configPath,
      provider: fakeProvider(),
      noCache: true,
      io,
    });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output.coverage.files).toBeLessThanOrEqual(5);
    expect(output.diagnostics).toContainEqual({
      source: "call-graph",
      message:
        "analysis stopped after reaching the configured file limit (5); results may be incomplete",
    });
  });

  it("discovers the full chain and reports no limit diagnostic when the default limit is far from reached", async () => {
    const root = tempProject();
    writeManifests(root);
    buildChain(root, 5);
    const configPath = path.join(root, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n  entrypoints:\n    - src/file0.js\n",
    );
    const { io, stdout } = fakeIo();

    await runScanCommand({
      projectPathArg: root,
      configPathOverride: configPath,
      provider: fakeProvider(),
      noCache: true,
      io,
    });

    const output = JSON.parse(stdout.join(""));
    expect(output.coverage.files).toBe(5);
    expect(output.diagnostics).toEqual([]);
  });
});

describe("runScanCommand: path traversal in analysis.entrypoints is rejected end to end", () => {
  it("surfaces a diagnostic and analyzes nothing when a configured entrypoint escapes the project root", async () => {
    const root = tempProject();
    writeManifests(root);
    write(root, "src/index.js", "export function main() {}\n");
    const configPath = path.join(root, "vulntrace.yml");
    writeFileSync(
      configPath,
      "analysis:\n  entrypoints:\n    - ../../../../../../etc/passwd\n",
    );
    const { io, stdout } = fakeIo();

    const exitCode = await runScanCommand({
      projectPathArg: root,
      configPathOverride: configPath,
      provider: fakeProvider(),
      noCache: true,
      io,
    });

    expect(exitCode).toBe(0);
    const output = JSON.parse(stdout.join(""));
    expect(output.diagnostics).toContainEqual({
      source: "entrypoints:configured",
      message:
        "analysis.entrypoints[0] resolves outside the project root and was rejected: ../../../../../../etc/passwd",
    });
    expect(output.coverage.files).toBe(0);
  });
});
