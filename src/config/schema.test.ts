import { describe, expect, it } from "vitest";
import { ConfigSchema, DEFAULT_EXCLUDE, DEFAULT_INCLUDE } from "./schema.js";

describe("ConfigSchema defaults", () => {
  it("fills in deterministic defaults for a fully empty config", () => {
    const result = ConfigSchema.parse({});

    expect(result).toEqual({
      project: { root: "." },
      analysis: {
        entrypoints: [],
        include: DEFAULT_INCLUDE,
        exclude: DEFAULT_EXCLUDE,
        limits: {
          maxFiles: 10_000,
          maxGraphNodes: 100_000,
          maxAnalysisSeconds: 60,
        },
      },
      vulnerabilities: { providers: ["osv"] },
      rules: { files: [] },
      output: { format: "json", pretty: false },
    });
  });

  it("produces identical output across repeated parses of the same input", () => {
    const a = ConfigSchema.parse({});
    const b = ConfigSchema.parse({});
    expect(a).toEqual(b);
  });

  it("accepts a fully specified configuration matching the example config", () => {
    const result = ConfigSchema.parse({
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

    expect(result.analysis.entrypoints).toEqual(["src/index.ts"]);
    expect(result.output.pretty).toBe(true);
  });
});

describe("ConfigSchema validation", () => {
  it("rejects unknown top-level keys", () => {
    expect(() => ConfigSchema.parse({ analysi: {} })).toThrow();
  });

  it("rejects unknown nested keys", () => {
    expect(() =>
      ConfigSchema.parse({ analysis: { includ: ["**/*.ts"] } }),
    ).toThrow();
  });

  it("rejects an unsupported vulnerability provider", () => {
    expect(() =>
      ConfigSchema.parse({ vulnerabilities: { providers: ["snyk"] } }),
    ).toThrow();
  });

  it("rejects an empty providers array", () => {
    expect(() =>
      ConfigSchema.parse({ vulnerabilities: { providers: [] } }),
    ).toThrow();
  });

  it("rejects the wrong type for analysis.include", () => {
    expect(() =>
      ConfigSchema.parse({ analysis: { include: "src/**/*.ts" } }),
    ).toThrow();
  });

  it("rejects an unsupported output format", () => {
    expect(() =>
      ConfigSchema.parse({ output: { format: "table" } }),
    ).toThrow();
  });

  it("rejects a non-positive limit", () => {
    expect(() =>
      ConfigSchema.parse({ analysis: { limits: { maxFiles: 0 } } }),
    ).toThrow();
  });
});
