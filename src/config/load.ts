import { readFileSync } from "node:fs";
import { parse as parseYamlText, YAMLParseError } from "yaml";
import { summarizeZodError } from "../shared/zod-issues.js";
import { type Config, ConfigSchema } from "./schema.js";
import {
  ConfigFileNotFoundError,
  ConfigValidationError,
  ConfigYamlSyntaxError,
} from "./errors.js";

/**
 * Validates an already-parsed configuration value against the VulnTrace
 * configuration schema, filling in deterministic defaults for any field
 * that was omitted. `null`/`undefined` are treated as an empty config.
 */
export function parseConfig(raw: unknown): Config {
  const result = ConfigSchema.safeParse(raw ?? {});

  if (!result.success) {
    throw new ConfigValidationError(summarizeZodError(result.error));
  }

  return result.data;
}

/**
 * Parses YAML configuration text and validates it against the VulnTrace
 * configuration schema.
 */
export function loadConfigFromYaml(
  yamlText: string,
  source = "<config>",
): Config {
  let raw: unknown;

  try {
    raw = parseYamlText(yamlText);
  } catch (error) {
    const message = error instanceof YAMLParseError ? error.message : String(error);
    throw new ConfigYamlSyntaxError(source, message, error);
  }

  return parseConfig(raw);
}

/**
 * Reads a YAML configuration file from disk and validates it.
 *
 * Reading a static configuration file is permitted under the project's
 * security constraints (see docs/SDD.md § 29): it is parsed as data and
 * never executed.
 */
export function loadConfigFile(filePath: string): Config {
  let text: string;

  try {
    text = readFileSync(filePath, "utf-8");
  } catch (error) {
    throw new ConfigFileNotFoundError(filePath, error);
  }

  return loadConfigFromYaml(text, filePath);
}
