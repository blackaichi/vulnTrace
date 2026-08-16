import { readFileSync } from "node:fs";
import { z } from "zod";
import { summarizeZodError } from "../shared/zod-issues.js";
import {
  PackageJsonFileNotFoundError,
  PackageJsonSyntaxError,
  PackageJsonValidationError,
} from "./package-json-errors.js";

const DependencyMapSchema = z.record(z.string(), z.string()).default({});

/**
 * Only the fields VulnTrace's Dependency Intelligence domain needs are
 * validated/typed (see docs/SDD.md § 11, § 15). Unrecognized fields
 * (author, license, eslintConfig, ...) are silently dropped, not rejected:
 * unlike `vulntrace.yml` (TASK-002, which is strict to catch our own users'
 * config typos), package.json is an external, ecosystem-wide format
 * VulnTrace does not own, so being permissive here is correct rather than a
 * validation gap.
 */
const PackageJsonSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  type: z.enum(["module", "commonjs"]).optional(),
  main: z.string().optional(),
  bin: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  scripts: z.record(z.string(), z.string()).default({}),
  dependencies: DependencyMapSchema,
  devDependencies: DependencyMapSchema,
  peerDependencies: DependencyMapSchema,
  optionalDependencies: DependencyMapSchema,
  /**
   * `exports`/`imports` have a genuinely recursive shape (string | array |
   * null | nested condition object). Modeling and interpreting that shape
   * correctly is TASK-016 (Module Resolution)'s job — see docs/SDD.md § 16
   * ("follow Node.js/TypeScript semantics through supported
   * compiler/runtime APIs where practical rather than implementing a
   * simplistic string-based resolver"). Here we only guarantee the raw
   * value is preserved and readable, per this task's acceptance criterion.
   */
  exports: z.unknown().optional(),
  imports: z.unknown().optional(),
  workspaces: z.array(z.string()).optional(),
});

export type PackageJson = z.infer<typeof PackageJsonSchema>;

/**
 * Validates an already-parsed package.json value.
 *
 * `scripts` is only ever read as data here, never executed (see
 * docs/SDD.md § 29; AGENTS.md: "Do not run package lifecycle scripts from
 * target projects").
 */
export function parsePackageJson(raw: unknown): PackageJson {
  const result = PackageJsonSchema.safeParse(raw ?? {});

  if (!result.success) {
    throw new PackageJsonValidationError(summarizeZodError(result.error));
  }

  return result.data;
}

/** Parses package.json text and validates it. */
export function parsePackageJsonText(
  jsonText: string,
  source = "<package.json>",
): PackageJson {
  let raw: unknown;

  try {
    raw = JSON.parse(jsonText) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new PackageJsonSyntaxError(source, message, error);
  }

  return parsePackageJson(raw);
}

/**
 * Reads a package.json file from disk and validates it.
 *
 * Reading a static manifest file is permitted under the project's security
 * constraints (see docs/SDD.md § 29): it is parsed as data and never
 * executed.
 */
export function loadPackageJsonFile(filePath: string): PackageJson {
  let text: string;

  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new PackageJsonFileNotFoundError(filePath, error);
  }

  return parsePackageJsonText(text, filePath);
}
