/**
 * Types for `validate-commit-metadata.mjs`. See
 * `commit-metadata-policy.d.mts` for why these modules are plain ESM.
 */

/**
 * `main` as it stood when Foundation F6 began. Everything reachable from
 * this commit is the historical baseline; commits after it are held to the
 * current policy.
 */
export const F6_BASE_SHA: string;

/**
 * Commits known to violate the policy and deliberately exempted, mapped to
 * the reason each is exempt rather than fixed. Every entry predates
 * {@link F6_BASE_SHA}.
 */
export const GRANDFATHERED: ReadonlyMap<string, string>;
