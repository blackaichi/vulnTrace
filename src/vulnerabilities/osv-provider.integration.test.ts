import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OsvProvider } from "./osv-provider.js";

/**
 * D-03: this suite no longer queries the live OSV API. It stubs
 * `OsvProvider`'s `fetchImpl` with response bodies recorded once from the
 * real API (`osv-provider.fixtures.json`, produced by
 * `scripts/record-osv-snapshot.mjs`), so it still exercises the REAL
 * request/response/zod-schema parsing pipeline against a real historical
 * OSV response shape -- it just no longer depends on OSV being reachable
 * or on the live database's current contents at test time. It was never
 * this suite's job to answer "is OSV up right now"; that question belongs
 * to a live/manual check, not `npm test`.
 */

const FIXTURES_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "osv-provider.fixtures.json",
);
const fixtures = JSON.parse(readFileSync(FIXTURES_PATH, "utf-8")) as {
  readonly lodashNoVersion: { readonly vulns: readonly unknown[] };
  readonly nonexistentPackage: {
    readonly name: string;
    readonly vulns: readonly unknown[];
  };
};

function stubbedFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("OsvProvider against a recorded real OSV response", () => {
  it("returns known historical vulnerabilities for a long-vulnerable npm package", async () => {
    const provider = new OsvProvider({
      fetchImpl: stubbedFetch(fixtures.lodashNoVersion),
    });

    const results = await provider.queryPackage({
      ecosystem: "npm",
      name: "lodash",
    });

    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
    expect(typeof results[0]?.id).toBe("string");
  });

  it("returns an empty array (not an error) for a package with no known vulnerabilities", async () => {
    const provider = new OsvProvider({
      fetchImpl: stubbedFetch({ vulns: fixtures.nonexistentPackage.vulns }),
    });

    const results = await provider.queryPackage({
      ecosystem: "npm",
      name: fixtures.nonexistentPackage.name,
    });

    expect(results).toEqual([]);
  });
});
