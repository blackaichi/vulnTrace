import { describe, expect, it, vi } from "vitest";
import { OsvNetworkError, OsvResponseError } from "./osv-provider-errors.js";
import { OsvProvider } from "./osv-provider.js";

function fakeFetch(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("OsvProvider.queryPackage: success", () => {
  it("returns the raw vulns array untouched (opaque passthrough)", async () => {
    const vulns = [
      { id: "GHSA-fixture-0001", summary: "example", affected: [{ x: 1 }] },
    ];
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ vulns }), { status: 200 }),
    );

    const provider = new OsvProvider({ fetchImpl });
    const result = await provider.queryPackage({
      ecosystem: "npm",
      name: "fixture-lib",
      version: "1.0.0",
    });

    expect(result).toEqual(vulns);
  });

  it("returns an empty array when OSV reports no vulnerabilities", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({}), { status: 200 }),
    );
    const provider = new OsvProvider({ fetchImpl });

    const result = await provider.queryPackage({
      ecosystem: "npm",
      name: "totally-safe-package",
    });

    expect(result).toEqual([]);
  });

  it("sends the expected request, omitting version when not provided", async () => {
    let capturedUrl: string | undefined;
    let capturedBody: string | undefined;
    const fetchImpl = (async (url, init) => {
      capturedUrl = String(url);
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
    }) as typeof fetch;

    const provider = new OsvProvider({
      fetchImpl,
      baseUrl: "https://example.test",
    });
    await provider.queryPackage({ ecosystem: "npm", name: "foo" });

    expect(capturedUrl).toBe("https://example.test/v1/query");
    expect(JSON.parse(capturedBody ?? "{}")).toEqual({
      package: { name: "foo", ecosystem: "npm" },
    });
  });

  it("includes version in the request body when provided", async () => {
    let capturedBody: string | undefined;
    const fetchImpl = (async (_url, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
    }) as typeof fetch;

    const provider = new OsvProvider({ fetchImpl });
    await provider.queryPackage({
      ecosystem: "npm",
      name: "foo",
      version: "1.2.3",
    });

    expect(JSON.parse(capturedBody ?? "{}")).toEqual({
      package: { name: "foo", ecosystem: "npm" },
      version: "1.2.3",
    });
  });
});

describe("OsvProvider.queryPackage: explicit failures, never a silent empty result", () => {
  it("throws OsvNetworkError when the request itself fails", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND api.osv.dev");
    }) as typeof fetch;

    const provider = new OsvProvider({ fetchImpl });

    await expect(
      provider.queryPackage({ ecosystem: "npm", name: "foo" }),
    ).rejects.toThrow(OsvNetworkError);
  });

  it("throws OsvNetworkError when the request times out", async () => {
    const fetchImpl = (async (_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "AbortError"));
        });
      });
    }) as typeof fetch;

    const provider = new OsvProvider({ fetchImpl, timeoutMs: 10 });

    await expect(
      provider.queryPackage({ ecosystem: "npm", name: "foo" }),
    ).rejects.toThrow(OsvNetworkError);
  });

  it("throws OsvResponseError on a non-2xx response", async () => {
    const fetchImpl = fakeFetch(
      new Response("Internal Server Error", { status: 500 }),
    );
    const provider = new OsvProvider({ fetchImpl });

    await expect(
      provider.queryPackage({ ecosystem: "npm", name: "foo" }),
    ).rejects.toThrow(OsvResponseError);
  });

  it("throws OsvResponseError on a malformed JSON body", async () => {
    const fetchImpl = fakeFetch(new Response("not json", { status: 200 }));
    const provider = new OsvProvider({ fetchImpl });

    await expect(
      provider.queryPackage({ ecosystem: "npm", name: "foo" }),
    ).rejects.toThrow(OsvResponseError);
  });

  it("throws OsvResponseError when vulns is present but not an array", async () => {
    const fetchImpl = fakeFetch(
      new Response(JSON.stringify({ vulns: "not-an-array" }), {
        status: 200,
      }),
    );
    const provider = new OsvProvider({ fetchImpl });

    await expect(
      provider.queryPackage({ ecosystem: "npm", name: "foo" }),
    ).rejects.toThrow(OsvResponseError);
  });

  // TASK-028 security hardening: OSV is an untrusted external provider
  // (docs/SDD.md § 29) -- a response envelope that superficially looks
  // plausible but doesn't actually match the expected shape must be
  // rejected explicitly, never silently coerced into an empty/garbage
  // result.
  it.each([
    ["a top-level array instead of an object", '["not", "an", "object"]'],
    ["a bare string", '"not even an object"'],
    ["null", "null"],
    ["vulns entries that are not objects", '{"vulns":["x",123,null]}'],
    ["vulns itself null", '{"vulns":null}'],
  ])("throws OsvResponseError for %s", async (_label, body) => {
    const fetchImpl = fakeFetch(new Response(body, { status: 200 }));
    const provider = new OsvProvider({ fetchImpl });

    await expect(
      provider.queryPackage({ ecosystem: "npm", name: "foo" }),
    ).rejects.toThrow(OsvResponseError);
  });
});
