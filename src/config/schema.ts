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

const AnalysisConfigSchema = z
  .object({
    entrypoints: z.array(z.string()).default([]),
    include: z.array(z.string()).default([...DEFAULT_INCLUDE]),
    exclude: z.array(z.string()).default([...DEFAULT_EXCLUDE]),
    limits: AnalysisLimitsSchema.default({}),
  })
  .strict();

const VulnerabilityProviderSchema = z.enum(DEFAULT_VULNERABILITY_PROVIDERS);

const VulnerabilitiesConfigSchema = z
  .object({
    providers: z
      .array(VulnerabilityProviderSchema)
      .min(1, "must not be empty")
      .default([...DEFAULT_VULNERABILITY_PROVIDERS]),
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
