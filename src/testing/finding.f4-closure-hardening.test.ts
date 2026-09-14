import { describe, expect, it } from "vitest";
import type { ModuleResolver } from "../code-intelligence/module-resolver.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import type { CallGraph } from "../domain/graph.js";
import type { VulnerableSymbolRule } from "../domain/target.js";
import type { Vulnerability } from "../domain/vulnerability.js";
import type { ModuleLoadClosure } from "../analysis/module-load-closure.js";
import {
  buildFindingForTest,
  VACUOUS_SYNTHETIC_CLOSURE_REFUSAL,
} from "./finding.js";

/**
 * FOUNDATION F4 / § 24 -- THE TEST HARNESS MAY NOT FABRICATE PROOF
 * COMPLETENESS.
 *
 * THE OBSERVATION F2 CARRIED FORWARD. `buildFindingForTest`'s
 * `syntheticGraphHasNoRealFiles` escape hatch synthesizes a closure with
 * `complete: true` and `loadedPackageInstances: []`. Proof family A's gate
 * asks exactly three things of a closure -- is it complete, does it have
 * roots, and is THIS finding's exact instance absent from its loaded set
 * -- and an empty loaded set answers the third YES for every instance that
 * could ever be asked about. Such a closure proves every installed package
 * unloadable.
 *
 * F2's audit found this SAFE, and was right: the suites that pass the flag
 * do not pass a `packageInstance`, and family A's gate is unreachable
 * without one. But that is a fact about the current call sites, not an
 * invariant. One new synthetic test that happened to add a
 * `packageInstance` would have produced a false NOT_AFFECTED with every
 * production guard working correctly and the TEST HARNESS supplying the
 * forged evidence -- the worst possible place for it to come from, because
 * the suite that should catch the regression would be its source.
 *
 * F4 makes the accident structural: the two may not coexist. This file is
 * the regression, in both directions -- the refusal fires, and the
 * legitimate uses are untouched.
 *
 * NOT a production change. `buildFindingForTest` is test-only, and
 * `buildFinding` itself is byte-identical.
 */

const vulnerability: Vulnerability = {
  id: "GHSA-f4-harness",
  aliases: [],
  package: "fixture-lib",
  ecosystem: "npm",
  affectedVersions: [],
  fixedVersions: [],
  references: [],
};

const rule: VulnerableSymbolRule = {
  id: "GHSA-f4-harness",
  package: { name: "fixture-lib" },
  targets: [
    {
      module: "fixture-lib",
      export: "vulnerable",
      kind: "function",
      confidence: 1,
    },
  ],
};

const ENTRY_FILE = "/project/src/index.js";
const LIB_FILE = "/node_modules/fixture-lib/index.js";
const LIB_INSTANCE = "/node_modules/fixture-lib";

const entrypoint: Entrypoint = {
  filePath: ENTRY_FILE,
  source: "configured",
  reason: "f4-harness",
};

/** A synthetic graph whose "files" have never existed on disk. */
const graph: CallGraph = {
  nodes: [{ id: `${ENTRY_FILE}#<module>`, kind: "module", module: ENTRY_FILE }],
  edges: [],
};

/** Resolves the advisory's module to a path that is equally imaginary. */
const resolver: ModuleResolver = {
  resolve: async (specifier: string, importerFilePath: string) =>
    specifier === "fixture-lib"
      ? {
          kind: "resolved" as const,
          resolvedFileName: LIB_FILE,
          isExternalLibraryImport: true,
        }
      : {
          kind: "unresolved" as const,
          reason: `no such module ${specifier}`,
          specifier,
          importer: importerFilePath,
        },
};

/** A truthful closure for this synthetic project: the instance is NOT loaded. */
const explicitClosure: ModuleLoadClosure = {
  rootFiles: [ENTRY_FILE],
  loadedFiles: [ENTRY_FILE],
  loadedPackageInstances: [],
  complete: true,
  incompleteness: [],
};

function call(options: {
  readonly packageInstance?: string;
  readonly moduleLoadClosure?: ModuleLoadClosure;
  readonly moduleLoadClosureUnavailable?: boolean;
}) {
  return buildFindingForTest({
    vulnerability,
    packageName: "fixture-lib",
    packageVersion: "1.0.0",
    packageInstance: options.packageInstance,
    matchResult: "affected",
    rule,
    graph,
    entrypoints: [entrypoint],
    resolver,
    projectRoot: "/project",
    syntheticGraphHasNoRealFiles: true,
    moduleLoadClosure: options.moduleLoadClosure,
    moduleLoadClosureUnavailable: options.moduleLoadClosureUnavailable,
  });
}

describe("F4 § 24: a synthetic default closure cannot answer a package-instance question", () => {
  it("REFUSES to synthesize a default closure beside a packageInstance", async () => {
    await expect(call({ packageInstance: LIB_INSTANCE })).rejects.toThrow(
      VACUOUS_SYNTHETIC_CLOSURE_REFUSAL,
    );
  });

  it("names the hazard in the refusal, so a reader does not have to infer it", async () => {
    // The message is the whole remediation for whoever trips it: a test
    // author who is told only "not allowed" will reach for the shortest
    // way around, which is the flag they already have.
    expect(VACUOUS_SYNTHETIC_CLOSURE_REFUSAL).toContain(
      "loadedPackageInstances",
    );
    expect(VACUOUS_SYNTHETIC_CLOSURE_REFUSAL).toContain("complete: true");
    expect(VACUOUS_SYNTHETIC_CLOSURE_REFUSAL).toContain("moduleLoadClosure");
    expect(VACUOUS_SYNTHETIC_CLOSURE_REFUSAL).toContain(
      "moduleLoadClosureUnavailable",
    );
  });

  it("THE HAZARD, reproduced: the refused shape would have minted family A", async () => {
    // Exactly the state the refusal now prevents, reached by supplying the
    // identical closure explicitly. The verdict below is what an accidental
    // synthetic call site would have produced -- and it is CORRECT here,
    // because supplying the closure explicitly is an assertion by the test
    // author that this instance genuinely is not loaded. The difference is
    // entirely who made the claim: a person, or a default.
    const finding = await call({
      packageInstance: LIB_INSTANCE,
      moduleLoadClosure: explicitClosure,
    });

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure?.packageInstance,
    ).toBe(LIB_INSTANCE);
  });

  it("accepts an explicit closure that CONTRADICTS the vacuous default", async () => {
    // The other half of the point: once the caller must state the closure,
    // it can state a truthful one. Here the instance IS loaded, and the
    // module-load absence proof is correctly withheld -- an answer the
    // synthesized default could never have produced, because it has no way
    // to know.
    //
    // What remains is a family C proof, which claims something else
    // entirely (this symbol is never called) and is unaffected by the
    // instance being loaded. That is the same audited takeover the F4
    // mutation matrix records for this mutation; the assertion here is
    // about family A's evidence being GONE, not about the verdict.
    const finding = await call({
      packageInstance: LIB_INSTANCE,
      moduleLoadClosure: {
        ...explicitClosure,
        loadedPackageInstances: [LIB_INSTANCE],
      },
    });

    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
    expect(
      finding?.evidence?.confirmedUnreachableTarget?.reachableSubgraphComplete,
    ).toBe(true);
  });

  it("accepts a declared-absent closure beside a packageInstance", async () => {
    const finding = await call({
      packageInstance: LIB_INSTANCE,
      moduleLoadClosureUnavailable: true,
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });

  it("leaves the instance-BLIND synthetic tests exactly as they were", async () => {
    // F4 § 25: the hardening must not change semantics for the suites that
    // legitimately use the flag. Those pass no `packageInstance` -- the
    // very property that made the old default safe -- and still get the
    // synthesized closure.
    const finding = await call({});

    expect(finding?.verdict).toBe("NOT_AFFECTED");
    // Family C, not family A: with no instance there is no instance-absence
    // question to answer, so the proof is about the target.
    expect(
      finding?.evidence?.confirmedUnreachableTarget?.reachableSubgraphComplete,
    ).toBe(true);
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
  });

  it("does not restrict REAL-file tests, which build a truthful closure anyway", async () => {
    // The default path for a project with real files calls
    // `buildGateEligibleModuleLoadClosure`, which derives the loaded set by
    // traversing. There is nothing vacuous to guard against, so a
    // `packageInstance` is fine there -- asserted by the fact that the F4
    // mutation suite and the F2 proof-guard suite both do exactly that,
    // and by this call not throwing.
    await expect(
      buildFindingForTest({
        vulnerability,
        packageName: "fixture-lib",
        packageVersion: "1.0.0",
        packageInstance: LIB_INSTANCE,
        matchResult: "affected",
        rule,
        graph,
        entrypoints: [entrypoint],
        resolver,
        projectRoot: "/project",
        // No `syntheticGraphHasNoRealFiles`: the real builder runs, finds
        // nothing readable at these imaginary paths, and produces an
        // honestly INCOMPLETE closure rather than a fabricated one.
      }),
    ).resolves.toBeDefined();
  });

  it("the real builder's answer for imaginary paths is incomplete, not vacuously complete", async () => {
    // Pins WHY the real path needs no guard: it cannot fabricate
    // completeness. A closure over unreadable roots records
    // `parse_failure` and withdraws every proof.
    const finding = await buildFindingForTest({
      vulnerability,
      packageName: "fixture-lib",
      packageVersion: "1.0.0",
      packageInstance: LIB_INSTANCE,
      matchResult: "affected",
      rule,
      graph,
      entrypoints: [entrypoint],
      resolver,
      projectRoot: "/project",
    });

    expect(finding?.verdict).toBe("UNKNOWN");
    expect(
      finding?.evidence?.confirmedAbsentFromModuleLoadClosure,
    ).toBeUndefined();
    expect(finding?.evidence?.confirmedUnreachableTarget).toBeUndefined();
  });
});
