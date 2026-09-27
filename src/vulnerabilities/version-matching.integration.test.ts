import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeOsvVulnerability } from "./osv-normalizer.js";
import { OsvProvider } from "./osv-provider.js";
import { matchVulnerabilities } from "./version-matching.js";

/**
 * D-03: stubs `fetchImpl` with a real, recorded OSV response
 * (`osv-provider.fixtures.json`, produced by
 * `scripts/record-osv-snapshot.mjs`) instead of querying OSV live. This
 * file was not named by OPEN-DEBTS D-03's original "What" (which named
 * only `osv-provider.integration.test.ts`) but measurably does the same
 * thing -- `new OsvProvider()` with no `fetchImpl` override, inside the
 * default `npm test` sweep -- so it is fixed here too; see the D-03 task
 * file's premise-verification note.
 */

const FIXTURES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "osv-provider.fixtures.json",
);
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf-8")) as {
  readonly lodashNoVersion: { readonly vulns: readonly unknown[] };
};

const fetchImpl = (async () =>
  new Response(JSON.stringify(fixtures.lodashNoVersion), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as unknown as typeof fetch;

describe("full OSV pipeline (provider -> normalizer -> matcher) against a recorded real OSV response", () => {
  it("matches a known-old, historically vulnerable lodash version to real advisories", async () => {
    const provider = new OsvProvider({ fetchImpl });
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
  });
});
