import type { PackageQuery } from "../domain/vulnerability.js";

function describeQuery(query: PackageQuery): string {
  return query.version
    ? `${query.ecosystem}:${query.name}@${query.version}`
    : `${query.ecosystem}:${query.name}`;
}

/** Base class for all OSV provider errors. */
export abstract class OsvProviderError extends Error {}

/**
 * The request to OSV never got a response (DNS failure, connection
 * refused, timeout, aborted, etc). Thrown explicitly rather than treated
 * as "no vulnerabilities found" — see AGENTS.md: never infer NOT_AFFECTED
 * merely because the analyzer failed to resolve something.
 */
export class OsvNetworkError extends OsvProviderError {
  readonly query: PackageQuery;

  constructor(query: PackageQuery, cause: unknown) {
    super(`Network failure querying OSV for ${describeQuery(query)}`, {
      cause,
    });
    this.name = "OsvNetworkError";
    this.query = query;
  }
}

/**
 * OSV responded, but not with a usable result: a non-2xx status, or a body
 * that isn't a valid OSV query response envelope. Thrown explicitly rather
 * than treated as "no vulnerabilities found", for the same reason as
 * {@link OsvNetworkError}.
 */
export class OsvResponseError extends OsvProviderError {
  readonly query: PackageQuery;
  readonly status: number | undefined;

  constructor(
    query: PackageQuery,
    status: number | undefined,
    details: string,
  ) {
    super(
      `Invalid OSV response for ${describeQuery(query)}` +
        (status === undefined ? "" : ` (HTTP ${status})`) +
        `: ${details}`,
    );
    this.name = "OsvResponseError";
    this.query = query;
    this.status = status;
  }
}
