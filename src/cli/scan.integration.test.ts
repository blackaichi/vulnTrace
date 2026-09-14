import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runScanCommand } from "./scan.js";

/**
 * Exercises `runScanCommand` against the real OSV network (see
 * src/vulnerabilities/osv-provider.integration.test.ts,
 * src/vulnerabilities/version-matching.integration.test.ts, which establish
 * lodash@4.17.4 as a known-old, historically vulnerable real package
 * version). No vulnerable-symbol rule targets lodash, so every match
 * degrades to UNKNOWN ("vulnerable target known? NO") rather than AFFECTED
 * — this test proves the real dependency-graph -> real OSV network ->
 * real normalizer -> real version match -> JSON-output wiring end to end
 * through the CLI, not reachability itself (already covered against real
 * data by src/cli/scan.test.ts with an injected provider, since no real
 * OSV-tracked CVE has a reachable/unreachable target inside a throwaway
 * fixture project).
 */
describe("runScanCommand against the real OSV network", () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it("reports real historical lodash vulnerabilities as UNKNOWN (no rule configured) with schema-valid JSON output", async () => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "vulntrace-scan-real-osv-"));
    writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({
        name: "tmp-real-osv-project",
        version: "1.0.0",
        dependencies: { lodash: "4.17.4" },
      }),
    );
    writeFileSync(
      path.join(tmpDir, "package-lock.json"),
      JSON.stringify({
        name: "tmp-real-osv-project",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "tmp-real-osv-project",
            version: "1.0.0",
            dependencies: { lodash: "4.17.4" },
          },
          "node_modules/lodash": { version: "4.17.4" },
        },
      }),
    );

    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runScanCommand({
      projectPathArg: tmpDir,
      io: {
        stdout: (t) => stdout.push(t),
        stderr: (t) => stderr.push(t),
      },
    });

    // FOUNDATION F3 § 22: every one of these findings is UNKNOWN, so the
    // scan now says why on the human-facing stream. This project has no
    // configured vulnerable-symbol rule for any real lodash advisory,
    // which is a missing PRECONDITION of the analysis rather than a
    // construct the analyzer declined to model -- the distinction F3 keeps
    // out of `unmodeled_construct` so the P1-B ranking stays honest.
    expect(stderr.join("")).toContain("UNKNOWN finding");
    expect(stderr.join("")).toContain("no_vulnerable_symbol_rule");
    expect(exitCode).toBe(0);

    const output = JSON.parse(stdout.join(""));
    expect(output.schemaVersion).toBeDefined();
    expect(output.findings.length).toBeGreaterThan(0);
    expect(
      output.findings.every(
        (finding: { package: string; verdict: string }) =>
          finding.package === "lodash" && finding.verdict === "UNKNOWN",
      ),
    ).toBe(true);
    // Against the REAL OSV API: every UNKNOWN carries a structured reason,
    // and it is the same one, because they all stop at the same place.
    expect(
      output.findings.every(
        (finding: { unknownReasons?: { reason: string }[] }) =>
          finding.unknownReasons?.length === 1 &&
          finding.unknownReasons[0]?.reason === "no_vulnerable_symbol_rule",
      ),
    ).toBe(true);
  }, 20_000);
});
