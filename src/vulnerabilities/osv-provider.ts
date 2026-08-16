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
 * Only the outer envelope is validated — `{ vulns?: object[] }` — not each
 * vulnerability's fields. Each entry stays an opaque {@link RawVulnerability}
 * (see docs/SDD.md § 12; AGENTS.md: "Do not couple OSV parsing directly to
 * the verdict engine"). Parsing individual OSV vulnerability fields is
 * TASK-010 (Vulnerability Normalizer)'s job, not this provider's.
 */
const OsvQueryResponseSchema = z.object({
  vulns: z.array(z.record(z.string(), z.unknown())).default([]),
});

export interface OsvProviderOptions {
  /** Defaults to the public OSV API. Overridable for testing/self-hosted mirrors. */
  readonly baseUrl?: string;
  /** Defaults to the global `fetch`. Overridable for testing without real network calls. */
  readonly fetchImpl?: typeof fetch;
  /** Defaults to 10 seconds. */
  readonly timeoutMs?: number;
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
 */
export class OsvProvider implements VulnerabilityProvider {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OsvProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async queryPackage(
    input: PackageQuery,
  ): Promise<readonly RawVulnerability[]> {
    const body = JSON.stringify({
      package: { name: input.name, ecosystem: input.ecosystem },
      ...(input.version ? { version: input.version } : {}),
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

    return result.data.vulns;
  }
}
