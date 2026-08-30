import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateEligibleModuleLoadClosure } from "../analysis/module-load-closure.js";
import { buildFinding } from "../analysis/verdict.js";
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { Coverage } from "../domain/coverage.js";
import type { DependencyNode } from "../domain/dependency.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type {
  ConfirmedAbsentFromModuleLoadClosure,
  ConfirmedAbsentInstance,
  ConfirmedUnreachableTarget,
} from "../domain/evidence.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
} from "../domain/resolved-target.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import type { PhaseTimings } from "../performance/timing.js";
import {
  SCHEMA_VERSION,
  findingToJson,
  validateScanOutput,
  type JsonFinding,
  type ScanOutput,
} from "./output.js";

/**
 * VT-CONTRACT-01 -- EXACTLY ONE negative-proof evidence object per
 * NOT_AFFECTED, enforced by the serialized result contract itself.
 *
 * WHY THIS LIVES IN THE SCHEMA, not only in code. `buildFinding`'s three
 * NOT_AFFECTED routes are mutually exclusive by construction (each is an
 * early return), so production has always emitted exactly one proof
 * object. But `schemas/result.schema.json` is the PUBLIC contract for a
 * serialized result -- what a downstream consumer, a future producer, or a
 * refactor of those early returns is checked against -- and it previously
 * accepted three states production never legitimately emits:
 *
 *  - NOT_AFFECTED with NO proof object at all: an unproven negative
 *    verdict, exactly the "absence of evidence as evidence of absence"
 *    that AGENTS.md forbids and that the whole VT-307 negative-proof
 *    contract exists to prevent;
 *  - NOT_AFFECTED carrying TWO or THREE proof objects: the families make
 *    materially different claims under different preconditions (A: the
 *    instance cannot be loaded; B: the graph never traversed it and a
 *    complete closure corroborates that; C: the resolved target is never
 *    called), so a finding asserting more than one is contradictory about
 *    what was actually established;
 *  - proof evidence on an AFFECTED or UNKNOWN: an AFFECTED would assert a
 *    reachable path and its own absence at once, and an UNKNOWN would
 *    present a completed proof for the one verdict that exists precisely
 *    because no proof completed.
 *
 * The point is that a future coding regression cannot SERIALIZE a
 * contradictory proof state: `runScanCommand` validates every result
 * against this schema before writing it and exits 3 on failure, so the
 * contract is enforced at the real output boundary, not merely documented.
 *
 * Two kinds of case appear below. The invalid ones must be hand-built --
 * production cannot produce them, which is the whole point. The valid ones
 * are taken from REAL findings: three real on-disk projects, run through
 * the same composition `cli/scan.ts` uses (dependency roots -> closure ->
 * call graph -> buildFinding) and serialized through the real
 * `findingToJson`, so what is asserted valid is what production actually
 * emits rather than a hand-written guess at its shape.
 */

const EMPTY_COVERAGE: Coverage = {
  files: 0,
  modulesResolved: 0,
  modulesUnresolved: 0,
  functions: 0,
  callsResolved: 0,
  callsDynamic: 0,
};

const ZERO_TIMINGS: PhaseTimings = {
  parsingMs: 0,
  resolutionMs: 0,
  graphConstructionMs: 0,
  reachabilityMs: 0,
  providerMs: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalMs: 0,
};

/** Wraps one finding in an otherwise-valid ScanOutput, so only the finding is under test. */
function outputWith(finding: JsonFinding): ScanOutput {
  return {
    schemaVersion: SCHEMA_VERSION,
    scan: { id: "scan-contract-01", project: "." },
    findings: [finding],
    coverage: EMPTY_COVERAGE,
    diagnostics: [],
    timings: ZERO_TIMINGS,
  };
}

const FAMILY_A: ConfirmedAbsentFromModuleLoadClosure = {
  packageInstance: "/project/node_modules/vuln-lib",
  entrypointRoots: ["/project/src/index.js"],
  closureComplete: true,
};

const FAMILY_B: ConfirmedAbsentInstance = {
  packageInstance: "/project/node_modules/consumer/node_modules/vuln-lib",
  entrypointRoots: ["/project/src/index.js"],
  graphTruncated: false,
  moduleLoadClosureComplete: true,
};

const FAMILY_C: ConfirmedUnreachableTarget = {
  target: { module: "vuln-lib", export: "vulnerable" },
  entrypointRoots: ["/project/src/index.js"],
  reachableSubgraphComplete: true,
};

/** A finding carrying whichever proof objects the case is about. */
function findingWith(
  verdict: JsonFinding["verdict"],
  proofs: Partial<{
    confirmedAbsentFromModuleLoadClosure: ConfirmedAbsentFromModuleLoadClosure;
    confirmedAbsentInstance: ConfirmedAbsentInstance;
    confirmedUnreachableTarget: ConfirmedUnreachableTarget;
  }>,
): JsonFinding {
  return {
    vulnerability: "GHSA-fixture-0001",
    package: "vuln-lib",
    version: "1.0.0",
    verdict,
    evidence: { path: [], reasons: ["a reason"], ...proofs },
  };
}

function isValid(finding: JsonFinding): boolean {
  return validateScanOutput(outputWith(finding)).length === 0;
}

describe("VT-CONTRACT-01: NOT_AFFECTED carries exactly one negative proof", () => {
  it("case 1: family A alone is valid", () => {
    expect(
      isValid(
        findingWith("NOT_AFFECTED", {
          confirmedAbsentFromModuleLoadClosure: FAMILY_A,
        }),
      ),
    ).toBe(true);
  });

  it("case 2: family B alone is valid", () => {
    expect(
      isValid(
        findingWith("NOT_AFFECTED", { confirmedAbsentInstance: FAMILY_B }),
      ),
    ).toBe(true);
  });

  it("case 3: family C alone is valid", () => {
    expect(
      isValid(
        findingWith("NOT_AFFECTED", { confirmedUnreachableTarget: FAMILY_C }),
      ),
    ).toBe(true);
  });

  // An unproven NOT_AFFECTED is the single most dangerous shape this
  // schema can accept: it is a negative verdict with nothing behind it.
  it("case 4: zero proof families is INVALID", () => {
    const issues = validateScanOutput(
      outputWith(findingWith("NOT_AFFECTED", {})),
    );

    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.path.endsWith("/evidence"))).toBe(true);
  });

  it("case 5: A + B is INVALID", () => {
    expect(
      isValid(
        findingWith("NOT_AFFECTED", {
          confirmedAbsentFromModuleLoadClosure: FAMILY_A,
          confirmedAbsentInstance: FAMILY_B,
        }),
      ),
    ).toBe(false);
  });

  it("case 6: A + C is INVALID", () => {
    expect(
      isValid(
        findingWith("NOT_AFFECTED", {
          confirmedAbsentFromModuleLoadClosure: FAMILY_A,
          confirmedUnreachableTarget: FAMILY_C,
        }),
      ),
    ).toBe(false);
  });

  it("case 7: B + C is INVALID", () => {
    expect(
      isValid(
        findingWith("NOT_AFFECTED", {
          confirmedAbsentInstance: FAMILY_B,
          confirmedUnreachableTarget: FAMILY_C,
        }),
      ),
    ).toBe(false);
  });

  it("case 8: A + B + C is INVALID", () => {
    expect(
      isValid(
        findingWith("NOT_AFFECTED", {
          confirmedAbsentFromModuleLoadClosure: FAMILY_A,
          confirmedAbsentInstance: FAMILY_B,
          confirmedUnreachableTarget: FAMILY_C,
        }),
      ),
    ).toBe(false);
  });

  it("rejects two proof objects even though each one validates on its own", () => {
    // The individual objects are not the problem -- each is a well-formed,
    // schema-valid proof. `oneOf` is what makes this EXACTLY one rather
    // than at least one.
    expect(
      isValid(
        findingWith("NOT_AFFECTED", { confirmedAbsentInstance: FAMILY_B }),
      ),
    ).toBe(true);
    expect(
      isValid(
        findingWith("NOT_AFFECTED", { confirmedUnreachableTarget: FAMILY_C }),
      ),
    ).toBe(true);
    expect(
      isValid(
        findingWith("NOT_AFFECTED", {
          confirmedAbsentInstance: FAMILY_B,
          confirmedUnreachableTarget: FAMILY_C,
        }),
      ),
    ).toBe(false);
  });
});

describe("VT-CONTRACT-01: no other verdict may carry a negative proof", () => {
  it("case 9: UNKNOWN with no negative proof is valid", () => {
    expect(isValid(findingWith("UNKNOWN", {}))).toBe(true);
  });

  it("case 10: UNKNOWN + family A is INVALID", () => {
    const issues = validateScanOutput(
      outputWith(
        findingWith("UNKNOWN", {
          confirmedAbsentFromModuleLoadClosure: FAMILY_A,
        }),
      ),
    );

    expect(issues.length).toBeGreaterThan(0);
    // The offending field is named, not just "the finding is wrong".
    expect(
      issues.some((issue) =>
        issue.path.endsWith("/evidence/confirmedAbsentFromModuleLoadClosure"),
      ),
    ).toBe(true);
  });

  it("case 11: UNKNOWN + family B is INVALID", () => {
    expect(
      isValid(findingWith("UNKNOWN", { confirmedAbsentInstance: FAMILY_B })),
    ).toBe(false);
  });

  it("case 12: UNKNOWN + family C is INVALID", () => {
    expect(
      isValid(findingWith("UNKNOWN", { confirmedUnreachableTarget: FAMILY_C })),
    ).toBe(false);
  });

  it("case 13: AFFECTED with no negative proof is valid", () => {
    expect(isValid(findingWith("AFFECTED", {}))).toBe(true);
  });

  it("case 14: AFFECTED + family A is INVALID", () => {
    expect(
      isValid(
        findingWith("AFFECTED", {
          confirmedAbsentFromModuleLoadClosure: FAMILY_A,
        }),
      ),
    ).toBe(false);
  });

  it("case 15: AFFECTED + family B is INVALID", () => {
    expect(
      isValid(findingWith("AFFECTED", { confirmedAbsentInstance: FAMILY_B })),
    ).toBe(false);
  });

  it("case 16: AFFECTED + family C is INVALID", () => {
    expect(
      isValid(
        findingWith("AFFECTED", { confirmedUnreachableTarget: FAMILY_C }),
      ),
    ).toBe(false);
  });
});

describe("VT-CONTRACT-01 constrains only the negative-proof invariant", () => {
  it("leaves every other evidence field usable on every verdict", () => {
    // `path` and `reasons` are shared vocabulary, not verdict-specific:
    // an AFFECTED carries a path, an UNKNOWN carries blocker reasons, and
    // a NOT_AFFECTED carries its proof's reason. None of that may be
    // caught by this change.
    const cases: readonly JsonFinding[] = [
      {
        vulnerability: "V",
        package: "p",
        version: "1.0.0",
        verdict: "AFFECTED",
        confidence: 1,
        target: { module: "p", symbol: "s", kind: "function", confidence: 0.9 },
        evidence: {
          path: ["src/a.ts:1", "src/b.ts:2"],
          reasons: ["vulnerable symbol resolved"],
        },
      },
      {
        vulnerability: "V",
        package: "p",
        version: "1.0.0",
        verdict: "UNKNOWN",
        evidence: { path: [], reasons: ["dynamic_require at src/a.ts#f"] },
      },
      // UNKNOWN with no evidence at all -- an indeterminate version match
      // or a vulnerability with no rule (see buildFinding's early returns).
      {
        vulnerability: "V",
        package: "p",
        version: "1.0.0",
        verdict: "UNKNOWN",
      },
      {
        vulnerability: "V",
        package: "p",
        version: "1.0.0",
        verdict: "NOT_AFFECTED",
        confidence: 1,
        target: { module: "p", symbol: "s" },
        evidence: {
          path: [],
          reasons: ["r1", "r2"],
          confirmedUnreachableTarget: FAMILY_C,
        },
      },
      // A proof object alongside a non-empty path is still one proof.
      {
        vulnerability: "V",
        package: "p",
        version: "1.0.0",
        verdict: "NOT_AFFECTED",
        evidence: {
          path: ["src/a.ts:1"],
          reasons: ["r"],
          confirmedAbsentFromModuleLoadClosure: FAMILY_A,
        },
      },
    ];

    for (const finding of cases) {
      expect(validateScanOutput(outputWith(finding))).toEqual([]);
    }
  });

  it("still rejects an AFFECTED or NOT_AFFECTED with no evidence at all (pre-existing rule, unchanged)", () => {
    for (const verdict of ["AFFECTED", "NOT_AFFECTED"] as const) {
      const issues = validateScanOutput(
        outputWith({
          vulnerability: "V",
          package: "p",
          version: "1.0.0",
          verdict,
        }),
      );
      expect(issues.length).toBeGreaterThan(0);
    }
  });
});

/**
 * VT-CONTRACT-02 -- family C's own evidence shape.
 *
 * The completeness field was renamed `callGraphComplete` ->
 * `reachableSubgraphComplete`: the old name asserted a property of the
 * WHOLE call graph, which this proof never established. These cases pin
 * the required shape so an incomplete or mislabelled family-C proof cannot
 * be serialized.
 */
describe("VT-CONTRACT-02: family C evidence shape", () => {
  /** Builds a family-C proof with one field removed or replaced. */
  function familyC(
    overrides: Record<string, unknown> = {},
    remove?: string,
  ): JsonFinding {
    const proof: Record<string, unknown> = { ...FAMILY_C, ...overrides };
    if (remove) {
      delete proof[remove];
    }
    return {
      vulnerability: "GHSA-fixture-0001",
      package: "vuln-lib",
      version: "1.0.0",
      verdict: "NOT_AFFECTED",
      evidence: {
        path: [],
        reasons: [
          "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
        ],
        confirmedUnreachableTarget:
          proof as unknown as ConfirmedUnreachableTarget,
      },
    };
  }

  it("a complete family C proof is valid", () => {
    expect(validateScanOutput(outputWith(familyC()))).toEqual([]);
  });

  it("rejects a family C proof with no target", () => {
    expect(isValid(familyC({}, "target"))).toBe(false);
  });

  it("rejects a family C target missing its module or export", () => {
    expect(isValid(familyC({ target: { module: "vuln-lib" } }))).toBe(false);
    expect(isValid(familyC({ target: { export: "vulnerable" } }))).toBe(false);
  });

  it("rejects a family C proof with no entrypoint roots", () => {
    expect(isValid(familyC({}, "entrypointRoots"))).toBe(false);
    // Present but empty is equally meaningless: "unreachable from nothing"
    // is not a proof (minItems: 1).
    expect(isValid(familyC({ entrypointRoots: [] }))).toBe(false);
  });

  it("rejects a family C proof with no completeness fact", () => {
    expect(isValid(familyC({}, "reachableSubgraphComplete"))).toBe(false);
  });

  it("rejects a family C proof whose completeness fact is false", () => {
    // The field is true-by-construction (`const: true`): the analyzer only
    // ever reaches this proof after an exhausted, unresolved-edge-free
    // search, so `false` is not a weaker proof -- it is a contradiction.
    expect(isValid(familyC({ reachableSubgraphComplete: false }))).toBe(false);
  });

  it("rejects the retired callGraphComplete name as a substitute", () => {
    // A producer still emitting the old field is missing the required new
    // one, so it fails rather than silently validating.
    expect(
      isValid(
        familyC({ callGraphComplete: true }, "reachableSubgraphComplete"),
      ),
    ).toBe(false);
  });

  it("keeps enforcing exactly-one and verdict placement for the renamed proof", () => {
    // VT-CONTRACT-01 must survive the rename untouched.
    expect(
      isValid(findingWith("UNKNOWN", { confirmedUnreachableTarget: FAMILY_C })),
    ).toBe(false);
    expect(
      isValid(
        findingWith("AFFECTED", { confirmedUnreachableTarget: FAMILY_C }),
      ),
    ).toBe(false);
    expect(
      isValid(
        findingWith("NOT_AFFECTED", {
          confirmedAbsentInstance: FAMILY_B,
          confirmedUnreachableTarget: FAMILY_C,
        }),
      ),
    ).toBe(false);
    expect(
      isValid(
        findingWith("NOT_AFFECTED", { confirmedUnreachableTarget: FAMILY_C }),
      ),
    ).toBe(true);
  });

  it("leaves families A and B untouched by the rename", () => {
    expect(
      isValid(
        findingWith("NOT_AFFECTED", {
          confirmedAbsentFromModuleLoadClosure: FAMILY_A,
        }),
      ),
    ).toBe(true);
    expect(
      isValid(
        findingWith("NOT_AFFECTED", { confirmedAbsentInstance: FAMILY_B }),
      ),
    ).toBe(true);
    // Neither carries family C's completeness field.
    expect(Object.keys(FAMILY_A)).not.toContain("reachableSubgraphComplete");
    expect(Object.keys(FAMILY_B)).not.toContain("reachableSubgraphComplete");
  });
});

/**
 * REAL production output, not hand-built objects.
 *
 * Each case writes a real project to disk and runs it through the exact
 * composition `cli/scan.ts` uses -- `buildKnownPackageRoots` ->
 * `buildGateEligibleModuleLoadClosure` -> `buildCallGraph` ->
 * `buildFinding` -> `findingToJson` -- then validates the serialized
 * finding against the checked-in schema. This is what proves the hardened
 * contract describes what production actually emits, rather than a shape
 * this test file invented.
 */
describe("VT-CONTRACT-01: real production findings satisfy the hardened contract", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  const LIB_SRC =
    "function vulnerable(x){ return x; }\n" +
    "function safe(x){ return x; }\n" +
    "module.exports = { vulnerable, safe };\n";

  const rule: VulnerableSymbolRule = {
    id: "GHSA-fixture-0001",
    package: { name: "vuln-lib" },
    targets: [
      {
        module: "vuln-lib",
        export: "vulnerable",
        kind: "function",
        confidence: 1,
      },
    ],
  };

  const vulnerability: Vulnerability = {
    id: "GHSA-fixture-0001",
    aliases: [],
    package: "vuln-lib",
    ecosystem: "npm",
    affectedVersions: [],
    fixedVersions: [],
    references: [],
  };

  /**
   * Writes a project, then runs the real production composition against
   * `instanceRelPath` -- the exact installed instance the finding is about.
   */
  async function realFinding(options: {
    readonly entrySrc: string;
    readonly files?: Readonly<Record<string, string>>;
    readonly instanceRelPath: string;
    readonly installRelPaths: readonly string[];
  }) {
    const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-contract-"));
    tempDirs.push(root);
    const write = (rel: string, content: string): string => {
      const p = path.join(root, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    };

    write("package.json", JSON.stringify({ name: "app" }));
    for (const [rel, content] of Object.entries(options.files ?? {})) {
      write(rel, content);
    }
    const entry = write("src/index.js", options.entrySrc);

    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    const dependencyNodes: DependencyNode[] = options.installRelPaths.map(
      (rel, index) => ({
        id: `vuln-lib@${index}`,
        name: "vuln-lib",
        version: "1.0.0",
        ecosystem: "npm",
        direct: index === 0,
        locations: [path.join(root, rel)],
        dependencyPaths: [],
      }),
    );
    const knownPackageRoots = buildKnownPackageRoots(dependencyNodes, root);
    const entrypoints: Entrypoint[] = [
      { filePath: entry, source: "configured", reason: "test" },
    ];

    const moduleLoadClosure = await buildGateEligibleModuleLoadClosure({
      entrypoints,
      resolver,
      maxFiles: 5000,
      knownPackageRoots,
    });
    const graph = await buildCallGraph({
      entryFiles: [entry],
      resolver,
      project,
    });

    return buildFinding({
      vulnerability,
      packageName: "vuln-lib",
      packageVersion: "1.0.0",
      packageInstance: canonicalizePackageInstancePath(
        path.join(root, options.instanceRelPath),
      ),
      matchResult: "affected",
      rule,
      graph,
      entrypoints,
      resolver,
      projectRoot: root,
      knownPackageRoots,
      moduleLoadClosure,
      graphTruncated: false,
    });
  }

  const INSTALLED_LIB = {
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version: "1.0.0",
    }),
    "node_modules/vuln-lib/index.js": LIB_SRC,
  };

  it("family A: a real unloaded instance serializes to a schema-valid finding", async () => {
    // The entrypoint never loads vuln-lib, so the exact instance is out of
    // a complete module-load closure.
    const finding = await realFinding({
      entrySrc: "function main(){ return 1; }\nmodule.exports = { main };\n",
      files: INSTALLED_LIB,
      instanceRelPath: "node_modules/vuln-lib",
      installRelPaths: ["node_modules/vuln-lib"],
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeDefined();
    expect(finding?.evidence?.confirmedAbsentInstance).toBeUndefined();
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();

    expect(validateScanOutput(outputWith(findingToJson(finding!)))).toEqual([]);
  });

  it("family B: a real never-traversed duplicate instance serializes to a schema-valid finding", async () => {
    // Two installs of one package name. The entrypoint imports and calls
    // the TOP-LEVEL install, so the call graph discovers that instance
    // (Site A) but never the nested one -- and nothing loads the nested
    // one, so a complete closure corroborates its absence.
    const finding = await realFinding({
      entrySrc:
        'const { vulnerable } = require("vuln-lib");\n' +
        "function main(){ return vulnerable(1); }\nmodule.exports = { main };\n",
      files: {
        ...INSTALLED_LIB,
        "node_modules/consumer/package.json": JSON.stringify({
          name: "consumer",
          version: "1.0.0",
        }),
        "node_modules/consumer/index.js":
          'module.exports = require("vuln-lib");\n',
        "node_modules/consumer/node_modules/vuln-lib/package.json":
          JSON.stringify({ name: "vuln-lib", version: "1.0.0" }),
        "node_modules/consumer/node_modules/vuln-lib/index.js": LIB_SRC,
      },
      instanceRelPath: "node_modules/consumer/node_modules/vuln-lib",
      installRelPaths: [
        "node_modules/vuln-lib",
        "node_modules/consumer/node_modules/vuln-lib",
      ],
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedAbsentInstance).toBeDefined();
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();

    expect(validateScanOutput(outputWith(findingToJson(finding!)))).toEqual([]);
  });

  it("family C: a real loaded-but-uncalled target serializes to a schema-valid finding", async () => {
    // vuln-lib IS loaded and used -- but only safe(), never vulnerable().
    const finding = await realFinding({
      entrySrc:
        'const { safe } = require("vuln-lib");\n' +
        "function main(){ return safe(1); }\nmodule.exports = { main };\n",
      files: INSTALLED_LIB,
      instanceRelPath: "node_modules/vuln-lib",
      installRelPaths: ["node_modules/vuln-lib"],
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeDefined();
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
    expect(finding?.evidence?.confirmedAbsentInstance).toBeUndefined();

    expect(validateScanOutput(outputWith(findingToJson(finding!)))).toEqual([]);
  });

  it("a real AFFECTED finding carries no negative proof and stays schema-valid", async () => {
    const finding = await realFinding({
      entrySrc:
        'const { vulnerable } = require("vuln-lib");\n' +
        "function main(){ return vulnerable(1); }\nmodule.exports = { main };\n",
      files: INSTALLED_LIB,
      instanceRelPath: "node_modules/vuln-lib",
      installRelPaths: ["node_modules/vuln-lib"],
    });

    expect(finding?.verdict).toBe("AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
    expect(finding?.evidence?.confirmedAbsentInstance).toBeUndefined();
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();

    expect(validateScanOutput(outputWith(findingToJson(finding!)))).toEqual([]);
  });
});
