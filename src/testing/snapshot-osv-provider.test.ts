import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SnapshotOsvProvider } from "./snapshot-osv-provider.js";

describe("SnapshotOsvProvider", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeSnapshot(
    contents: Record<string, unknown>,
  ): SnapshotOsvProvider {
    const dir = mkdtempSync(path.join(tmpdir(), "vulntrace-snapshot-test-"));
    dirs.push(dir);
    const file = path.join(dir, "osv-snapshot.json");
    writeFileSync(file, JSON.stringify(contents));
    return new SnapshotOsvProvider(file);
  }

  it("returns the recorded answer for a versioned query, exactly as recorded", async () => {
    const provider = writeSnapshot({
      "npm:lodash@4.17.15": [{ id: "GHSA-fake-recorded-answer" }],
    });

    const results = await provider.queryPackage({
      ecosystem: "npm",
      name: "lodash",
      version: "4.17.15",
    });

    expect(results).toEqual([{ id: "GHSA-fake-recorded-answer" }]);
  });

  it("returns the recorded answer for a version-less query", async () => {
    const provider = writeSnapshot({
      "npm:lodash": [{ id: "GHSA-fake-no-version" }],
    });

    const results = await provider.queryPackage({
      ecosystem: "npm",
      name: "lodash",
    });

    expect(results).toEqual([{ id: "GHSA-fake-no-version" }]);
  });

  it("returns an empty array when OSV was recorded as reporting zero vulnerabilities (never confused with a missing key)", async () => {
    const provider = writeSnapshot({
      "npm:left-pad@1.3.0": [],
    });

    const results = await provider.queryPackage({
      ecosystem: "npm",
      name: "left-pad",
      version: "1.3.0",
    });

    expect(results).toEqual([]);
  });

  it("throws, rather than silently returning [], for a query not in the snapshot", async () => {
    const provider = writeSnapshot({
      "npm:lodash@4.17.15": [],
    });

    await expect(
      provider.queryPackage({
        ecosystem: "npm",
        name: "never-recorded",
        version: "1.0.0",
      }),
    ).rejects.toThrow(/no recorded OSV answer/);
  });

  it("distinguishes queries by version -- a recorded version does not silently answer for a different one", async () => {
    const provider = writeSnapshot({
      "npm:semver@7.5.1": [{ id: "GHSA-for-7-5-1" }],
    });

    await expect(
      provider.queryPackage({
        ecosystem: "npm",
        name: "semver",
        version: "7.5.2",
      }),
    ).rejects.toThrow(/no recorded OSV answer/);
  });

  it("uses the default snapshot path (tests/validation/osv-snapshot.json) when none is given, and it is a real recording", async () => {
    const provider = new SnapshotOsvProvider();

    const results = await provider.queryPackage({
      ecosystem: "npm",
      name: "lodash",
      version: "4.17.15",
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });
});
