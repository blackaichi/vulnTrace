import { z } from "zod";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { OsvNetworkError, OsvResponseError } from "./osv-provider-errors.js";

const DEFAULT_BASE_URL = "https://api.osv.dev";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The most pages one query may take (decision 5's cap, task B-1). OSV's
 * pages hold on the order of a thousand records, so this is far above any
 * real package's advisory count; it exists so an answer that never ends
 * fails as a provider error instead of looping forever.
 */
const DEFAULT_MAX_PAGES = 100;

/**
 * What this provider answers: a list of opaque records. Exported so the
 * OSV cache validates a stored answer with the same schema a live one
 * passes (task B-3, AUD-07).
 */
export const OsvVulnerabilityListSchema = z.array(
  z.record(z.string(), z.unknown()),
);

/**
 * Only the outer envelope is validated — `{ vulns?: object[] }` — not each
 * vulnerability's fields. Each entry stays an opaque {@link RawVulnerability}
 * (see docs/SDD.md § 12; AGENTS.md: "Do not couple OSV parsing directly to
 * the verdict engine"). Parsing individual OSV vulnerability fields is
 * TASK-010 (Vulnerability Normalizer)'s job, not this provider's.
 *
 * `next_page_token` (task B-1, PRM-65): present means more results exist,
 * absent means the answer is complete. Anything else -- a non-string, an
 * empty string, `null` -- is a token this provider cannot follow
 * faithfully, so the envelope is refused rather than read as "complete".
 */
const OsvQueryResponseSchema = z.object({
  vulns: OsvVulnerabilityListSchema.default([]),
  next_page_token: z.string().min(1).optional(),
});

type OsvQueryResponse = z.infer<typeof OsvQueryResponseSchema>;

export interface OsvProviderOptions {
  /** Defaults to the public OSV API. Overridable for testing/self-hosted mirrors. */
  readonly baseUrl?: string;
  /** Defaults to the global `fetch`. Overridable for testing without real network calls. */
  readonly fetchImpl?: typeof fetch;
  /** Defaults to 10 seconds, for each page's request. */
  readonly timeoutMs?: number;
  /** Defaults to {@link DEFAULT_MAX_PAGES}. Overridable for testing. */
  readonly maxPages?: number;
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "<unreadable response body>";
  }
}

/**
 * {@link VulnerabilityProvider} adapter for the OSV API
 * (see docs/SDD.md § 12). Network and response-shape failures are always
 * thrown explicitly, never silently coerced into an empty result — an
 * empty `vulns` array only ever means "OSV successfully reported zero
 * known vulnerabilities", never "the query failed".
 *
 * The answer is EVERY page (task B-1, PRM-65, decision 5). OSV paginates
 * `/v1/query`: a response with more results carries `next_page_token`,
 * and the next request repeats the query with a top-level `page_token`
 * until no token is returned; a page may carry a token and no records.
 * Before B-1 the first page was returned as the whole answer, so an
 * advisory on page 2 was never seen by anything. A page that fails, a
 * token that repeats, and an answer longer than the page cap all fail the
 * query: a shorter list would read as complete.
 */
export class OsvProvider implements VulnerabilityProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxPages: number;

  constructor(options: OsvProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  }

  async queryPackage(
    input: PackageQuery,
  ): Promise<readonly RawVulnerability[]> {
    const vulns: RawVulnerability[] = [];
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;

    for (let page = 1; ; page++) {
      const result = await this.queryPage(input, pageToken);
      vulns.push(...result.vulns);

      const next = result.next_page_token;
      if (next === undefined) {
        return vulns;
      }
      if (seenTokens.has(next)) {
        throw new OsvResponseError(
          input,
          undefined,
          `next_page_token ${JSON.stringify(next)} repeated on page ${page}, so the answer cannot be read completely`,
        );
      }
      if (page >= this.maxPages) {
        throw new OsvResponseError(
          input,
          undefined,
          `the answer did not end within ${this.maxPages} pages, so it cannot be read completely`,
        );
      }
      seenTokens.add(next);
      pageToken = next;
    }
  }

  private async queryPage(
    input: PackageQuery,
    pageToken: string | undefined,
  ): Promise<OsvQueryResponse> {
    const body = JSON.stringify({
      package: { name: input.name, ecosystem: input.ecosystem },
      ...(input.version ? { version: input.version } : {}),
      ...(pageToken === undefined ? {} : { page_token: pageToken }),
    });

    let response: Response;

    try {
      response = await this.fetchImpl(`${this.baseUrl}/v1/query`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new OsvNetworkError(input, error);
    }

    if (!response.ok) {
      throw new OsvResponseError(
        input,
        response.status,
        await readBodyText(response),
      );
    }

    let json: unknown;

    try {
      json = await response.json();
    } catch (error) {
      throw new OsvResponseError(
        input,
        response.status,
        `response body is not valid JSON: ${String(error)}`,
      );
    }

    const result = OsvQueryResponseSchema.safeParse(json);

    if (!result.success) {
      throw new OsvResponseError(
        input,
        response.status,
        `response does not match the expected OSV query envelope: ${result.error.message}`,
      );
    }

    return result.data;
  }
}
