import { describe, expect, it } from "vitest";
import { normalizeOsvVulnerability } from "./osv-normalizer.js";
import { OsvProvider } from "./osv-provider.js";
import { matchVulnerabilities } from "./version-matching.js";

describe("full OSV pipeline (provider -> normalizer -> matcher) against real data", () => {
  it("matches a known-old, historically vulnerable lodash version to real advisories", async () => {
    const provider = new OsvProvider();
    const target = { ecosystem: "npm", name: "lodash" };

    const rawVulns = await provider.queryPackage(target);
    const normalized = rawVulns.map((raw) =>
      normalizeOsvVulnerability(raw, target),
    );

    // lodash@4.17.4 predates several well-known, long-fixed CVEs
    // (e.g. prototype pollution issues fixed across 4.17.5-4.17.21).
    const matches = matchVulnerabilities("4.17.4", normalized);

    expect(matches.length).toBeGreaterThan(0);
    expect(matches.some((match) => match.result === "affected")).toBe(true);
  }, 20_000);
});
