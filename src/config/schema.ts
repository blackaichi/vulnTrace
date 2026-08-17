import { z } from "zod";

/**
 * Default include patterns covering the MVP JavaScript/TypeScript scope
 * (see docs/SDD.md § 15). Patterns are rooted anywhere under the project;
 * `DEFAULT_EXCLUDE` keeps build output and dependencies out.
 */
export const DEFAULT_INCLUDE: readonly string[] = [
  "**/*.ts",
  "**/*.tsx",
  "**/*.js",
  "**/*.jsx",
  "**/*.mjs",
  "**/*.cjs",
];

export const DEFAULT_EXCLUDE: readonly string[] = [
  "node_modules/**",
  "dist/**",
  "coverage/**",
];

/**
 * Only OSV is a supported provider for the MVP (see docs/SDD.md § 12 and
 * docs/MVP-IMPLEMENTATION-PLAN.md: "Do not add a second vulnerability
 * provider before the provider boundary is stable").
 */
export const DEFAULT_VULNERABILITY_PROVIDERS = ["osv"] as const;

const ProjectConfigSchema = z
  .object({
    root: z.string().min(1, "must not be empty").default("."),
  })
  .strict();

const AnalysisLimitsSchema = z
  .object({
    maxFiles: z.number().int().positive().default(10_000),
    maxGraphNodes: z.number().int().positive().default(100_000),
    maxAnalysisSeconds: z.number().int().positive().default(60),
  })
  .strict();

/**
 * One `analysis.entrypoints` entry (see SDD-v0.2.md § 6): either a bare
 * file path (the pre-VT-205 form, kept for backward compatibility -- the
 * whole file's own exports remain valid reachability sources, exactly as
 * before), or `{file, symbol}` naming exactly one export as the real
 * entry. When `symbol` is present, only that export -- not every export of
 * the file -- counts as an entrypoint source (see
 * src/analysis/verdict.ts's `entrypointSourceNodes`).
 */
const EntrypointConfigSchema = z.union([
  z.string().min(1, "must not be empty"),
  z
    .object({
      file: z.string().min(1, "must not be empty"),
      symbol: z.string().min(1, "must not be empty").optional(),
    })
    .strict(),
]);

export type EntrypointConfig = z.infer<typeof EntrypointConfigSchema>;

const AnalysisConfigSchema = z
  .object({
    entrypoints: z.array(EntrypointConfigSchema).default([]),
    include: z.array(z.string()).default([...DEFAULT_INCLUDE]),
    exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE]),
    limits: AnalysisLimitsSchema.default({}),
  })
  .strict();

const VulnerabilityProviderSchema = z.enum(DEFAULT_VULNERABILITY_PROVIDERS);

/**
 * Enabled by default (see docs/SDD.md § 28: "The analyzer must support
 * offline/reproducible operation where cached data is available") — a
 * fresh scan of an unchanged dependency set should not need live network
 * access every time. `--no-cache` (docs/SDD.md § 25) overrides this at
 * the CLI layer regardless of what's configured here.
 */
const CacheConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict();

const VulnerabilitiesConfigSchema = z
  .object({
    providers: z
      .array(VulnerabilityProviderSchema)
      .min(1, "must not be empty")
      .default([...DEFAULT_VULNERABILITY_PROVIDERS]),
    cache: CacheConfigSchema.default({}),
  })
  .strict();

const RulesConfigSchema = z
  .object({
    files: z.array(z.string()).default([]),
  })
  .strict();

/**
 * Only "json" output is part of the MVP (see docs/DEFINITION-OF-DONE.md:
 * "JSON output validates against schema"). Additional formats are future
 * work, not an MVP goal.
 */
const OutputConfigSchema = z
  .object({
    format: z.enum(["json"]).default("json"),
    pretty: z.boolean().default(false),
  })
  .strict();

export const ConfigSchema = z
  .object({
    project: ProjectConfigSchema.default({}),
    analysis: AnalysisConfigSchema.default({}),
    vulnerabilities: VulnerabilitiesConfigSchema.default({}),
    rules: RulesConfigSchema.default({}),
    output: OutputConfigSchema.default({}),
  })
  .strict();

/** Fully resolved VulnTrace configuration, after defaults are applied. */
export type Config = z.infer<typeof ConfigSchema>;

export type VulnerabilityProvider = z.infer<typeof VulnerabilityProviderSchema>;
