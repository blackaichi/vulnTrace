import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGateEligibleModuleLoadClosure,
  type ModuleLoadClosure,
} from "../analysis/module-load-closure.js";
import { canonicalizePackageInstancePath } from "../domain/resolved-target.js";
import type { VulnerabilityProvider } from "../domain/vulnerability.js";
import { runScanCommand } from "./scan.js";

/**
 * VT-307d Commit 1 -- REAL PRODUCTION-WIRING assertions for the scan's
 * single {@link ModuleLoadClosure}.
 *
 * Deliberately drives the whole `runScanCommand` pipeline rather than
 * calling `buildModuleLoadClosure`/`buildGateEligibleModuleLoadClosure`
 * directly (which `src/analysis/module-load-closure.test.ts` already covers
 * exhaustively). The facts under test here are properties of the
 * PRODUCTION CONSTRUCTION ORDER -- dependency graph -> `KnownPackageRoots`
 * -> entrypoint discovery -> strict gate-eligible closure -- and every one
 * of them can be broken without breaking a single direct-builder test:
 * passing the wrong `maxFiles`, forgetting `knownPackageRoots`, reaching
 * for the non-strict builder, building the closure before entrypoints are
 * discovered, or rebuilding it per finding. A hand-assembled builder call
 * would silently keep passing through all of those.
 *
 * The six cases are the real-world closure facts VT-307d's Site-B negative
 * proof depends on, taken from the same real, vendored, npm-installed
 * fixtures the validation suite scans (see tests/validation/cases/cases.json
 * and docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md):
 *
 * | case     | package                  | membership | complete |
 * | -------- | ------------------------ | ---------- | -------- |
 * | RWB-06   | node-forge               | OUT        | true     |
 * | RWB-06A  | node-forge               | OUT        | true     |
 * | RWB-07   | ini                      | IN         | true     |
 * | RWB-08   | ms                       | IN         | true     |
 * | RWB-09a  | semver-vulnerable        | IN         | true     |
 * | RWB-10   | handlebars               | IN         | false    |
 *
 * Note how little of this the call graph could have told us. RWB-08's `ms`
 * is IN despite never appearing as a call-bound package instance at all
 * (RWF-004 blocks the binding); RWB-07's `ini` is IN even though its
 * vulnerable export cannot be attributed to any function (RWF-012). That
 * divergence is the whole point: module-load reachability and call
 * reachability are different questions, and only the former can support an
 * absence proof.
 *
 * Uses a fake vulnerability provider -- the closure is built before, and
 * independently of, any advisory query, so no network boundary is involved
 * here (unlike the validation suite, which deliberately hits live OSV).
 *
 * Each fixture is copied to a fresh OS-temp directory before scanning, for
 * exactly the reason VT-302/RWF-010 documents in
 * tests/validation/validation.test.ts: a fixture scanned in place inherits
 * VulnTrace's own repository as an ancestor, and `ts.resolveModuleName`'s
 * upward `node_modules` walk is not bounded by the scanned project root, so
 * a bare specifier can silently resolve into THIS repo's `node_modules`
 * instead of the fixture's own vendored tree.
 */

const REPO_ROOT = path.resolve(
  fileURLToPath(new URL("../../", import.meta.url)),
);
const FIXTURES_ROOT = path.join(REPO_ROOT, "tests", "validation", "fixtures");

function fakeIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (t: string) => stdout.push(t),
      stderr: (t: string) => stderr.push(t),
    },
    stdout,
    stderr,
  };
}

/** No advisories: this suite asserts closure facts, not verdicts. */
function fakeProvider(): VulnerabilityProvider {
  return { queryPackage: () => Promise.resolve([]) };
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface ScanClosureResult {
  readonly fixtureDir: string;
  readonly closure: ModuleLoadClosure | undefined;
  /** How many times the scan handed back a closure -- must always be exactly 1. */
  readonly observations: number;
  readonly exitCode: number;
  readonly stderr: string;
}

/**
 * Runs the real scan against a temp copy of `fixtureName` and captures the
 * one closure it built, through `runScanCommand`'s own read-only
 * observation seam.
 */
async function scanFixture(fixtureName: string): Promise<ScanClosureResult> {
  const fixtureDir = mkdtempSync(
    path.join(tmpdir(), `vulntrace-vt307d-${fixtureName}-`),
  );
  tempDirs.push(fixtureDir);
  cpSync(path.join(FIXTURES_ROOT, fixtureName), fixtureDir, {
    recursive: true,
    dereference: false,
  });

  const { io, stderr } = fakeIo();
  const observed: (ModuleLoadClosure | undefined)[] = [];

  const exitCode = await runScanCommand({
    projectPathArg: fixtureDir,
    configPathOverride: path.join(fixtureDir, "vulntrace.yml"),
    noCache: true,
    provider: fakeProvider(),
    io,
    onModuleLoadClosure: (closure) => observed.push(closure),
  });

  return {
    fixtureDir,
    closure: observed[0],
    observations: observed.length,
    exitCode,
    stderr: stderr.join(""),
  };
}

/** The canonical {@link PackageInstanceId} for an install inside `fixtureDir`. */
function instanceId(fixtureDir: string, installPath: string): string {
  return canonicalizePackageInstancePath(path.join(fixtureDir, installPath));
}

interface ClosureFactCase {
  readonly id: string;
  readonly fixture: string;
  /** Install path relative to the fixture root -- the exact canonical instance under test. */
  readonly installPath: string;
  readonly expectedMembership: "IN" | "OUT";
  readonly expectedComplete: boolean;
  readonly why: string;
}

const CASES: readonly ClosureFactCase[] = [
  {
    id: "RWB-06",
    fixture: "rwb-06-node-forge-unreached",
    installPath: "node_modules/node-forge",
    expectedMembership: "OUT",
    expectedComplete: true,
    why: "node-forge is a real installed direct dependency that src/index.js never require()s. The entrypoint's unrelated String.prototype.trim() call (RWF-002) contaminates CALL-graph reachability, but says nothing about what MODULES load -- so the closure is complete and node-forge is genuinely absent from it.",
  },
  {
    id: "RWB-06A",
    fixture: "rwb-06a-node-forge-unreached-clean",
    installPath: "node_modules/node-forge",
    expectedMembership: "OUT",
    expectedComplete: true,
    why: "The RWF-002-free control sibling of RWB-06: same package, same absence, and no unresolved construct anywhere in the entrypoint at all.",
  },
  {
    id: "RWB-07",
    fixture: "rwb-07-ini-entrypoint-unreached",
    installPath: "node_modules/ini",
    expectedMembership: "IN",
    expectedComplete: true,
    why: "src/config.js require()s ini at module scope, so loading the entrypoint FILE loads ini -- regardless of the configured {file, symbol} entrypoint narrowing the CALL-side source to loadModernConfig. Module-load membership must not inherit that symbol narrowing.",
  },
  {
    id: "RWB-08",
    fixture: "rwb-08-debug-ms-nested",
    installPath: "node_modules/ms",
    expectedMembership: "IN",
    expectedComplete: true,
    why: "ms is reached transitively: the entrypoint requires debug, and debug's own debug.js does `exports.humanize = require('ms')` at top level. ms never appears as a call-bound package instance (RWF-004), which is exactly why closure membership must be derived from module loading and never from the call graph.",
  },
  {
    id: "RWB-09a",
    fixture: "rwb-09-semver-multi-instance",
    installPath: "node_modules/semver-vulnerable",
    expectedMembership: "IN",
    expectedComplete: true,
    why: "The npm-ALIASED install directory node_modules/semver-vulnerable holds the real semver@7.5.1. src/version-check.js require()s it at module scope. Identity is the install LOCATION, never the declared package name -- the separate node_modules/semver install is a different instance entirely.",
  },
  {
    id: "RWB-10",
    fixture: "rwb-10-handlebars-dynamic-dispatch",
    installPath: "node_modules/handlebars",
    expectedMembership: "IN",
    expectedComplete: false,
    why: "handlebars is genuinely loaded, AND the closure is incomplete: handlebars' own implementation contains closure-widening loader constructs. Incompleteness here is load-bearing -- it is what must stop the Site-B absence gate from firing for any OTHER package in this project.",
  },
];

describe("VT-307d: production module-load closure wiring (real RWB fixtures)", () => {
  for (const testCase of CASES) {
    it(`${testCase.id}: ${testCase.installPath} is ${testCase.expectedMembership}, complete=${String(testCase.expectedComplete)}`, async () => {
      const { fixtureDir, closure, observations, stderr } = await scanFixture(
        testCase.fixture,
      );

      expect(
        observations,
        `${testCase.id}: the closure must be built EXACTLY ONCE per scan, never per advisory/package/vulnerability/finding. stderr: ${stderr}`,
      ).toBe(1);

      expect(
        closure,
        `${testCase.id}: a gate-eligible closure must be available for a project with configured entrypoints. stderr: ${stderr}`,
      ).toBeDefined();
      if (!closure) {
        return;
      }

      // Guaranteed by construction (`buildGateEligibleModuleLoadClosure`
      // returns undefined otherwise), asserted here because a vacuous,
      // root-less closure is the single most dangerous shape a negative
      // proof could ever be handed.
      expect(closure.rootFiles.length).toBeGreaterThan(0);

      const expectedInstance = instanceId(fixtureDir, testCase.installPath);
      const isMember =
        closure.loadedPackageInstances.includes(expectedInstance);

      expect(
        isMember ? "IN" : "OUT",
        `${testCase.id}: expected ${expectedInstance} to be ${testCase.expectedMembership} of the module-load closure.\n` +
          `Rationale: ${testCase.why}\n` +
          `Closure held ${String(closure.loadedFiles.length)} files / ` +
          `${String(closure.loadedPackageInstances.length)} package instances: ` +
          `${closure.loadedPackageInstances.join(", ")}\n` +
          `stderr: ${stderr}`,
      ).toBe(testCase.expectedMembership);

      expect(
        closure.complete,
        `${testCase.id}: expected closure.complete=${String(testCase.expectedComplete)}.\n` +
          `Rationale: ${testCase.why}\n` +
          `Incompleteness recorded: ${JSON.stringify(closure.incompleteness)}\n` +
          `stderr: ${stderr}`,
      ).toBe(testCase.expectedComplete);
    });
  }

  it("keeps same-name package instances at distinct install locations distinct (RWB-09 multi-instance identity)", async () => {
    // Both fixture installs declare the package NAME "semver"; only their
    // install LOCATIONS differ. A closure that collapsed identity by name,
    // by version, or by name+version would report one membership answer for
    // both -- the exact identity collapse VT-307d's gate must never make.
    const { fixtureDir, closure } = await scanFixture(
      "rwb-09-semver-multi-instance",
    );
    expect(closure).toBeDefined();
    if (!closure) {
      return;
    }

    const vulnerable = instanceId(fixtureDir, "node_modules/semver-vulnerable");
    const patched = instanceId(fixtureDir, "node_modules/semver");

    expect(vulnerable).not.toBe(patched);
    expect(closure.loadedPackageInstances).toContain(vulnerable);
    // Each instance's membership is answered independently, on its own
    // canonical id -- never borrowed from a same-named sibling.
    expect(
      new Set(closure.loadedPackageInstances).size,
      "package instances must not be de-duplicated across distinct install locations",
    ).toBe(closure.loadedPackageInstances.length);
  });
});

describe("VT-307d: production wiring cannot manufacture absence evidence", () => {
  /**
   * Requirement 2 of VT-307d Commit 1, asserted through the REAL scan
   * rather than through `buildGateEligibleModuleLoadClosure` directly
   * (which module-load-closure.test.ts already covers): a project where
   * entrypoint discovery finds nothing must yield NO closure at all.
   *
   * The failure shape this rules out is specific and severe. A closure
   * built from zero roots traverses nothing, so it reports
   * `loadedFiles: []`, `loadedPackageInstances: []`, `incompleteness: []`
   * and -- fatally -- `complete: true`. Every installed package instance
   * in the project is "absent" from it. A gate unable to tell that apart
   * from a genuine, exhaustive traversal would return a false
   * NOT_AFFECTED for EVERY finding, on precisely the projects where
   * nothing could be analyzed at all.
   */
  it("produces no closure at all when the project has zero discoverable entrypoints", async () => {
    const fixtureDir = mkdtempSync(
      path.join(tmpdir(), "vulntrace-vt307d-no-entrypoints-"),
    );
    tempDirs.push(fixtureDir);

    // No `main`/`bin`, and no configured analysis.entrypoints -- the real
    // production state cli/scan.ts already diagnoses.
    writeFileSync(
      path.join(fixtureDir, "package.json"),
      JSON.stringify({ name: "no-entrypoints-fixture", version: "1.0.0" }),
    );
    writeFileSync(
      path.join(fixtureDir, "package-lock.json"),
      JSON.stringify({
        name: "no-entrypoints-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "no-entrypoints-fixture", version: "1.0.0" } },
      }),
    );
    writeFileSync(path.join(fixtureDir, "vulntrace.yml"), "analysis: {}\n");

    const { io, stdout } = fakeIo();
    const observed: (ModuleLoadClosure | undefined)[] = [];

    await runScanCommand({
      projectPathArg: fixtureDir,
      configPathOverride: path.join(fixtureDir, "vulntrace.yml"),
      noCache: true,
      provider: fakeProvider(),
      io,
      onModuleLoadClosure: (closure) => observed.push(closure),
    });

    expect(observed).toHaveLength(1);
    expect(
      observed[0],
      "a zero-entrypoint scan must yield NO gate-eligible closure -- never an empty one with complete=true",
    ).toBeUndefined();

    // The pre-existing conservative behavior is preserved, not replaced.
    const output = JSON.parse(stdout.join("")) as {
      diagnostics: ReadonlyArray<{ source: string; message: string }>;
    };
    expect(
      output.diagnostics.some(
        (d) =>
          d.source === "entrypoints" && d.message.includes("no entrypoints"),
      ),
      "the existing no-entrypoints diagnostic must still be emitted",
    ).toBe(true);
  });

  /**
   * Requirement 1/16: gate eligibility is STRUCTURAL. The production path
   * calls `buildGateEligibleModuleLoadClosure`, whose options type makes
   * `knownPackageRoots` mandatory -- there is no caller-supplied
   * "proofEligible: true" boolean anywhere, and no way to obtain an
   * eligible closure without authoritative package-root identity context.
   *
   * Asserted at COMPILE time: the `@ts-expect-error` below fails the build
   * if omitting `knownPackageRoots` ever becomes legal again. That matters
   * because a closure built without it silently loses the
   * PackageInstanceId of every workspace/`file:`-linked install, which
   * would let a genuinely-loaded package look absent.
   */
  it("makes a gate-eligible closure impossible to build without KnownPackageRoots (compile-time)", () => {
    const call = () =>
      buildGateEligibleModuleLoadClosure({
        entrypoints: [],
        resolver: {
          resolve: () => Promise.resolve({ kind: "unresolved", reason: "x" }),
        } as unknown as Parameters<
          typeof buildGateEligibleModuleLoadClosure
        >[0]["resolver"],
        // @ts-expect-error knownPackageRoots is REQUIRED by the strict
        // gate-eligible builder; removing it must not compile.
        knownPackageRoots: undefined,
      });
    expect(call).toBeTypeOf("function");
  });
});
