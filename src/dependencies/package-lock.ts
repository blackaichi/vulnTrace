import { readFileSync } from "node:fs";
import { z } from "zod";
import { summarizeZodError } from "../shared/zod-issues.js";
import {
  PackageLockFileNotFoundError,
  PackageLockSyntaxError,
  PackageLockUnsupportedVersionError,
  PackageLockValidationError,
} from "./package-lock-errors.js";

const DependencyMapSchema = z.record(z.string(), z.string()).default({});

/**
 * A single entry in the lockfile's "packages" map, keyed by install path
 * (e.g. `""` for the project root, `"node_modules/foo"`, or
 * `"node_modules/foo/node_modules/bar"` for a nested, independently
 * versioned copy — see docs/SDD.md § 11: "The graph must support multiple
 * installed versions of the same package"). `name` is frequently absent:
 * npm omits it whenever it is inferable from the path itself (see
 * {@link derivePackageName}).
 */
const PackageLockEntrySchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  resolved: z.string().optional(),
  integrity: z.string().optional(),
  dev: z.boolean().optional(),
  optional: z.boolean().optional(),
  devOptional: z.boolean().optional(),
  peer: z.boolean().optional(),
  link: z.boolean().optional(),
  dependencies: DependencyMapSchema,
  devDependencies: DependencyMapSchema,
  peerDependencies: DependencyMapSchema,
  optionalDependencies: DependencyMapSchema,
});

export type PackageLockEntry = z.infer<typeof PackageLockEntrySchema>;

const PackageLockSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  lockfileVersion: z.number().int(),
  packages: z.record(z.string(), PackageLockEntrySchema),
});

export type PackageLock = z.infer<typeof PackageLockSchema>;

/**
 * Derives a package name from its install path, for the common case where
 * the lockfile entry itself omits `name` (see
 * fixtures/direct-esm/package-lock.json's `node_modules/fixture-lib`
 * entry, which has no `name` field). Handles nesting and scoped packages
 * (`node_modules/foo/node_modules/@scope/bar` -> `@scope/bar`).
 *
 * Only meaningful for `node_modules`-rooted paths. Returns `undefined` for
 * the root entry (path `""`) and for non-`node_modules` paths (e.g. a
 * workspace member at `packages/foo`) — npm always writes an explicit
 * `name` for those, so callers should prefer `entry.name` and only fall
 * back to this for `node_modules` paths.
 */
export function derivePackageName(entryPath: string): string | undefined {
  if (entryPath === "" || !entryPath.includes("node_modules/")) {
    return undefined;
  }

  const segments = entryPath.split("node_modules/").filter(Boolean);
  return segments[segments.length - 1];
}

/** Validates an already-parsed package-lock.json value. */
export function parsePackageLock(raw: unknown): PackageLock {
  const candidate = (raw ?? {}) as Record<string, unknown>;
  const { lockfileVersion } = candidate;

  if (typeof lockfileVersion === "number" && lockfileVersion < 2) {
    throw new PackageLockUnsupportedVersionError(lockfileVersion);
  }

  const result = PackageLockSchema.safeParse(candidate);

  if (!result.success) {
    throw new PackageLockValidationError(summarizeZodError(result.error));
  }

  return result.data;
}

/** Parses package-lock.json text and validates it. */
export function parsePackageLockText(
  jsonText: string,
  source = "<package-lock.json>",
): PackageLock {
  let raw: unknown;

  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PackageLockSyntaxError(source, message, error);
  }

  return parsePackageLock(raw);
}

/**
 * Reads a package-lock.json file from disk and validates it.
 *
 * Reading a static lockfile is permitted under the project's security
 * constraints (see docs/SDD.md § 29): it is parsed as data and never
 * executed, and this never runs `npm install` or any package manager.
 */
export function loadPackageLockFile(filePath: string): PackageLock {
  let text: string;

  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new PackageLockFileNotFoundError(filePath, error);
  }

  return parsePackageLockText(text, filePath);
}
