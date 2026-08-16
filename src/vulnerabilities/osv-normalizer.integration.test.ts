import { describe, expect, it } from "vitest";
import { normalizeOsvVulnerability } from "./osv-normalizer.js";
import { OsvProvider } from "./osv-provider.js";

describe("normalizeOsvVulnerability against real OSV data", () => {
  it("normalizes every real vulnerability record OSV returns for lodash", async () => {
    const provider = new OsvProvider();
    const target = { ecosystem: "npm", name: "lodash" };

    const rawVulns = await provider.queryPackage(target);
    expect(rawVulns.length).toBeGreaterThan(0);

    const normalized = rawVulns.map((raw) =>
      normalizeOsvVulnerability(raw, target),
    );

    expect(normalized).toHaveLength(rawVulns.length);
    for (const vuln of normalized) {
      expect(vuln.package).toBe("lodash");
      expect(vuln.ecosystem).toBe("npm");
      expect(vuln.id.length).toBeGreaterThan(0);
      expect(vuln.affectedVersions.length).toBeGreaterThan(0);
    }
  }, 20_000);
});
