import { describe, expect, it } from "vitest";
import { OsvResponseError } from "./osv-provider-errors.js";
import { OsvProvider, type OsvProviderOptions } from "./osv-provider.js";

/**
 * Task B-1, PRM-65 (decision 5): OSV's `/v1/query` is paginated, and every
 * page is part of the answer.
 *
 * OSV's documentation (`post-v1-query`): a response with more results
 * carries `next_page_token`; the next request repeats the query with a
 * top-level `page_token`; the client continues "until the
 * `next_page_token` is no longer included"; and "in rare cases, the
 * response might contain only the `next_page_token`". Before B-1 the
 * provider read the first page and returned it as the whole answer, so an
 * advisory on page 2 was never seen by anything -- a silent drop.
 *
 * The other half of decision 5 is the cap: a provider that follows tokens
 * forever is not an answer either. Past the cap, and on any token the
 * provider cannot follow faithfully, the query fails as a provider error
 * -- never as a shorter list that would read as complete.
 */

interface PagedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A fetch whose answer to each request is chosen by its `page_token`. */
function pagedFetch(
  pages: Readonly<Record<string, unknown>>,
  requests: PagedRequest[],
): typeof fetch {
  return (async (url, init) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    requests.push({ url: String(url), body });
    const token =
      typeof body.page_token === "string" ? body.page_token : "<first>";
    const page = pages[token];
    if (page === undefined) {
      return new Response(`no page for token ${token}`, { status: 400 });
    }
    return new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
}

const QUERY = { ecosystem: "npm", name: "vuln-lib", version: "1.0.0" };

describe("OsvProvider: pagination (PRM-65)", () => {
  it("follows next_page_token and returns every page's records, in order", async () => {
    const requests: PagedRequest[] = [];
    const provider = new OsvProvider({
      fetchImpl: pagedFetch(
        {
          "<first>": { vulns: [{ id: "GHSA-page-1" }], next_page_token: "T2" },
          T2: { vulns: [{ id: "GHSA-page-2" }], next_page_token: "T3" },
          T3: { vulns: [{ id: "GHSA-page-3" }] },
        },
        requests,
      ),
    });

    const result = await provider.queryPackage(QUERY);

    expect(result.map((record) => record.id)).toEqual([
      "GHSA-page-1",
      "GHSA-page-2",
      "GHSA-page-3",
    ]);
    expect(requests).toHaveLength(3);
  });

  it("repeats the same query with a top-level page_token", async () => {
    const requests: PagedRequest[] = [];
    const provider = new OsvProvider({
      fetchImpl: pagedFetch(
        {
          "<first>": { vulns: [], next_page_token: "T2" },
          T2: { vulns: [] },
        },
        requests,
      ),
    });

    await provider.queryPackage(QUERY);

    expect(requests[0]?.body).toEqual({
      package: { name: "vuln-lib", ecosystem: "npm" },
      version: "1.0.0",
    });
    expect(requests[1]?.body).toEqual({
      package: { name: "vuln-lib", ecosystem: "npm" },
      version: "1.0.0",
      page_token: "T2",
    });
    expect(requests[1]?.url).toBe(requests[0]?.url);
  });

  it("follows a page that carries only a token (no vulns key)", async () => {
    const requests: PagedRequest[] = [];
    const provider = new OsvProvider({
      fetchImpl: pagedFetch(
        {
          "<first>": { next_page_token: "T2" },
          T2: { vulns: [{ id: "GHSA-after-empty" }] },
        },
        requests,
      ),
    });

    const result = await provider.queryPackage(QUERY);

    expect(result.map((record) => record.id)).toEqual(["GHSA-after-empty"]);
  });

  it("fails as a provider error past the page cap, never as a short list", async () => {
    const requests: PagedRequest[] = [];
    // Every page names a fresh token: an answer that never ends.
    const endless = (async (url, init) => {
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      return new Response(
        JSON.stringify({
          vulns: [{ id: `GHSA-${requests.length}` }],
          next_page_token: `T${requests.length + 1}`,
        }),
        { status: 200 },
      );
    }) as typeof fetch;
    const options: OsvProviderOptions & { readonly maxPages: number } = {
      fetchImpl: endless,
      maxPages: 3,
    };
    const provider = new OsvProvider(options);

    await expect(provider.queryPackage(QUERY)).rejects.toBeInstanceOf(
      OsvResponseError,
    );
    expect(requests).toHaveLength(3);
  });

  it("has a finite default page cap", async () => {
    let calls = 0;
    const endless = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ vulns: [], next_page_token: `T${calls + 1}` }),
        { status: 200 },
      );
    }) as typeof fetch;
    const provider = new OsvProvider({ fetchImpl: endless });

    await expect(provider.queryPackage(QUERY)).rejects.toBeInstanceOf(
      OsvResponseError,
    );
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(1000);
  });

  // B-1's independent audit, finding 2(a): the pages already read are not
  // an answer when a later page fails.
  it("fails as a provider error when a later page fails, never returning the pages before it", async () => {
    const requests: PagedRequest[] = [];
    let calls = 0;
    const fetchImpl = (async (url, init) => {
      calls++;
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      requests.push({ url: String(url), body });
      return calls === 1
        ? new Response(
            JSON.stringify({
              vulns: [{ id: "GHSA-a" }],
              next_page_token: "T2",
            }),
            { status: 200 },
          )
        : new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const provider = new OsvProvider({ fetchImpl });

    await expect(provider.queryPackage(QUERY)).rejects.toBeInstanceOf(
      OsvResponseError,
    );
    expect(requests).toHaveLength(2);
  });

  it("fails as a provider error when a token repeats", async () => {
    const requests: PagedRequest[] = [];
    const provider = new OsvProvider({
      fetchImpl: pagedFetch(
        {
          "<first>": { vulns: [{ id: "GHSA-a" }], next_page_token: "T2" },
          T2: { vulns: [{ id: "GHSA-b" }], next_page_token: "T2" },
        },
        requests,
      ),
    });

    await expect(provider.queryPackage(QUERY)).rejects.toBeInstanceOf(
      OsvResponseError,
    );
    expect(requests).toHaveLength(2);
  });

  it.each([
    ["a number", 7],
    ["an empty string", ""],
    ["null", null],
  ])(
    "fails as a provider error when next_page_token is %s",
    async (_label, token) => {
      const requests: PagedRequest[] = [];
      const provider = new OsvProvider({
        fetchImpl: pagedFetch(
          {
            "<first>": { vulns: [{ id: "GHSA-a" }], next_page_token: token },
            // Were the token followed, this stub would END the answer: the
            // only thing that can make the query fail is the provider
            // refusing the token itself.
            [String(token)]: { vulns: [] },
          },
          requests,
        ),
      });

      await expect(provider.queryPackage(QUERY)).rejects.toBeInstanceOf(
        OsvResponseError,
      );
      expect(requests).toHaveLength(1);
    },
  );
});
