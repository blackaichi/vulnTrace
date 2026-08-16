import { describe, expect, it } from "vitest";
import { OsvProvider } from "./osv-provider.js";

describe("OsvProvider against the real OSV API", () => {
  it("returns known historical vulnerabilities for a long-vulnerable npm package", async () => {
    const provider = new OsvProvider();

    const results = await provider.queryPackage({
      ecosystem: "npm",
      name: "lodash",
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0]?.id).toBe("string");
  }, 20_000);

  it("returns an empty array (not an error) for a package with no known vulnerabilities", async () => {
    const provider = new OsvProvider();

    const results = await provider.queryPackage({
      ecosystem: "npm",
      name: `vulntrace-integration-test-nonexistent-${Date.now()}`,
    });

    expect(results).toEqual([]);
  }, 20_000);
});
