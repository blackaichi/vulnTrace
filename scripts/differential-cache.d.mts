/**
 * Types for `differential-cache.mjs` (BL-089).
 *
 * The module is plain ESM so `scripts/differential.mjs` can run it under
 * bare `node`. These declarations let its suite
 * (`src/testing/differential-cache.test.ts`) be type-checked.
 */

export const CACHE_FORMAT: "vulntrace-differential-base-cache/1";
export const CORPUS_PATHS: readonly string[];
export const NODE_MODULES_TOOL_CACHES: readonly string[];
export const CACHE_KEEP: number;

export class UncacheableError extends Error {}

export interface BaseKeyInput {
  /** The checkout whose instrument, corpus and dependencies the base side reads. */
  readonly repoRoot: string;
  /** The OS temp directory the validation corpus is copied under. */
  readonly tmpRoot: string;
  readonly baseSha: string;
  readonly snapshotFormat: string;
  readonly selection: {
    readonly corpora?: string;
    readonly cases?: string;
    readonly useHeadDependencies?: boolean;
  };
  readonly runtime: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
  };
  /** Relative to `repoRoot`. */
  readonly driverPaths: readonly string[];
  /** Relative to `repoRoot`. */
  readonly instrumentPaths: readonly string[];
  /** Relative to `repoRoot`; defaults to {@link CORPUS_PATHS}. */
  readonly corpusPaths?: readonly string[];
}

export interface KeyPart {
  readonly name:
    | "format"
    | "base"
    | "selection"
    | "runtime"
    | "driver"
    | "instrument"
    | "corpus"
    | "around";
  readonly digest: string;
}

export type BaseKey =
  | {
      readonly cacheable: true;
      readonly key: string;
      readonly parts: readonly KeyPart[];
    }
  | { readonly cacheable: false; readonly reason: string };

export interface CachedBaseEntry {
  readonly cacheFormat: string;
  readonly key: string;
  readonly baseSha: string;
  readonly collectedAt: string;
  readonly seconds: string;
  readonly snapshot: { readonly format: string; readonly label: string };
}

export function baseCacheKey(input: BaseKeyInput): BaseKey;

export function readCachedBase(
  cacheDir: string,
  key: string,
  snapshotFormat: string,
): CachedBaseEntry | undefined;

export function writeCachedBase(
  cacheDir: string,
  key: string,
  entry: Omit<CachedBaseEntry, "cacheFormat" | "key">,
): string;
