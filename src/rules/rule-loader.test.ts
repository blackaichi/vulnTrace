import { describe, expect, it } from "vitest";
import {
  DuplicateRuleIdError,
  RuleFileNotFoundError,
  RuleShapeError,
  RuleValidationError,
  RuleYamlSyntaxError,
} from "./rule-errors.js";
import {
  indexRulesByVulnerabilityId,
  loadRuleFile,
  parseRules,
  parseRulesFromYaml,
} from "./rule-loader.js";

const validRulesFile = {
  rules: [
    {
      id: "GHSA-fixture-0001",
      package: { name: "fixture-lib" },
      targets: [
        {
          module: "fixture-lib",
          export: "vulnerable",
          kind: "function",
          confidence: 1.0,
        },
      ],
    },
  ],
};

describe("parseRules: mapping vulnerability IDs to package symbols", () => {
  it("parses a valid rules file into VulnerableSymbolRule[]", () => {
    const rules = parseRules(validRulesFile);

    expect(rules).toEqual([
      {
        id: "GHSA-fixture-0001",
        package: { name: "fixture-lib" },
        targets: [
          {
            module: "fixture-lib",
            export: "vulnerable",
            kind: "function",
            confidence: 1.0,
          },
        ],
      },
    ]);
  });

  it("accepts every documented target kind", () => {
    for (const kind of ["function", "method", "constructor", "module"]) {
      const rules = parseRules({
        rules: [
          {
            id: "GHSA-fixture-0001",
            package: { name: "fixture-lib" },
            targets: [{ module: "fixture-lib", export: "vulnerable", kind }],
          },
        ],
      });
      expect(rules[0]?.targets[0]?.kind).toBe(kind);
    }
  });

  it("is deterministic across repeated parses of the same input", () => {
    const a = parseRules(validRulesFile);
    const b = parseRules(validRulesFile);
    expect(a).toEqual(b);
  });
});

describe("parseRules: validation", () => {
  it("throws RuleShapeError when there is no top-level rules array", () => {
    expect(() => parseRules({ notRules: [] })).toThrow(RuleShapeError);
  });

  it("throws RuleValidationError when a rule is missing a required field", () => {
    expect(() =>
      parseRules({
        rules: [{ package: { name: "fixture-lib" }, targets: [] }],
      }),
    ).toThrow(RuleValidationError);
  });

  it("throws RuleValidationError for an unsupported target kind", () => {
    expect(() =>
      parseRules({
        rules: [
          {
            id: "GHSA-fixture-0001",
            package: { name: "fixture-lib" },
            targets: [
              { module: "fixture-lib", export: "vulnerable", kind: "class" },
            ],
          },
        ],
      }),
    ).toThrow(RuleValidationError);
  });

  it("throws DuplicateRuleIdError when two rules share an id", () => {
    expect(() =>
      parseRules({
        rules: [
          {
            id: "GHSA-fixture-0001",
            package: { name: "fixture-lib" },
            targets: [{ module: "fixture-lib", export: "vulnerable" }],
          },
          {
            id: "GHSA-fixture-0001",
            package: { name: "other-lib" },
            targets: [{ module: "other-lib", export: "danger" }],
          },
        ],
      }),
    ).toThrow(DuplicateRuleIdError);
  });
});

describe("parseRulesFromYaml", () => {
  it("parses real rules YAML text matching rules/vulntrace-rules.yml", () => {
    const rules = parseRulesFromYaml(
      "rules:\n" +
        "  - id: GHSA-fixture-0001\n" +
        "    package:\n" +
        "      name: fixture-lib\n" +
        "    targets:\n" +
        "      - module: fixture-lib\n" +
        "        export: vulnerable\n" +
        "        kind: function\n" +
        "        confidence: 1.0\n",
    );

    expect(rules).toEqual(parseRules(validRulesFile));
  });

  it("throws RuleYamlSyntaxError for malformed YAML", () => {
    expect(() => parseRulesFromYaml("rules: [unterminated")).toThrow(
      RuleYamlSyntaxError,
    );
  });
});

describe("loadRuleFile", () => {
  it("throws RuleFileNotFoundError for a missing file", () => {
    expect(() => loadRuleFile("/does/not/exist/rules.yml")).toThrow(
      RuleFileNotFoundError,
    );
  });
});

describe("indexRulesByVulnerabilityId", () => {
  it("maps each vulnerability id to its rule", () => {
    const rules = parseRules(validRulesFile);
    const index = indexRulesByVulnerabilityId(rules);

    expect(index.get("GHSA-fixture-0001")).toEqual(rules[0]);
    expect(index.get("GHSA-does-not-exist")).toBeUndefined();
  });

  it("throws DuplicateRuleIdError when merging rules from multiple sources with the same id", () => {
    const fileA = parseRules(validRulesFile);
    const fileB = parseRules({
      rules: [
        {
          id: "GHSA-fixture-0001",
          package: { name: "other-lib" },
          targets: [{ module: "other-lib", export: "danger" }],
        },
      ],
    });

    expect(() => indexRulesByVulnerabilityId([...fileA, ...fileB])).toThrow(
      DuplicateRuleIdError,
    );
  });
});
