import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ConfigFileNotFoundError,
  ConfigValidationError,
  ConfigYamlSyntaxError,
} from "./errors.js";
import { loadConfigFile, loadConfigFromYaml, parseConfig } from "./load.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const exampleConfigPath = path.join(repoRoot, "config", "vulntrace.example.yml");

describe("loadConfigFromYaml", () => {
  it("returns a fully defaulted config for empty YAML text", () => {
    const config = loadConfigFromYaml("");

    expect(config.project.root).toBe(".");
    expect(config.vulnerabilities.providers).toEqual(["osv"]);
    expect(config.output).toEqual({ format: "json", pretty: false });
  });

  it("parses the repository's example configuration file", () => {
    const config = loadConfigFile(exampleConfigPath);

    expect(config).toEqual({
      project: { root: "." },
      analysis: {
        entrypoints: ["src/index.ts"],
        include: ["src/**/*.ts", "src/**/*.js"],
        exclude: ["node_modules/**", "dist/**", "coverage/**"],
        limits: {
          maxFiles: 10000,
          maxGraphNodes: 100000,
          maxAnalysisSeconds: 60,
        },
      },
      vulnerabilities: { providers: ["osv"] },
      rules: { files: ["rules/vulntrace-rules.yml"] },
      output: { format: "json", pretty: true },
    });
  });

  it("throws ConfigYamlSyntaxError for malformed YAML", () => {
    expect(() => loadConfigFromYaml("analysis: [unterminated")).toThrow(
      ConfigYamlSyntaxError,
    );
  });

  it("throws ConfigValidationError with an actionable path for invalid fields", () => {
    expect.assertions(2);
    try {
      loadConfigFromYaml("analysis:\n  include: not-an-array\n");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigValidationError);
      expect((error as ConfigValidationError).issues[0]?.path).toBe(
        "analysis.include",
      );
    }
  });
});

describe("loadConfigFile", () => {
  it("throws ConfigFileNotFoundError for a missing file", () => {
    expect(() =>
      loadConfigFile(path.join(repoRoot, "does-not-exist.yml")),
    ).toThrow(ConfigFileNotFoundError);
  });
});

describe("parseConfig", () => {
  it("treats null and undefined as an empty config", () => {
    expect(parseConfig(undefined)).toEqual(parseConfig({}));
    expect(parseConfig(null)).toEqual(parseConfig({}));
  });
});
