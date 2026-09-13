import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runScanCommand } from "./scan.js";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";

/**
 * P1-A5 -- MULTI-INSTANCE TARGET EXPANSION, end to end through the real
 * scan command (dependency graph -> workspace discovery -> instance
 * enumeration -> module resolution -> call graph -> reachability -> verdict
 * -> JSON), with only the OSV boundary stubbed.
 *
 * The one invariant: ONE FINDING REFERS TO ONE EXACT PackageInstance.
 * Every case below installs the same package name -- usually at the same
 * version -- at two or three physical roots and asserts that the verdicts
 * genuinely differ where the reachability differs. A suite that only ever
 * produced one verdict per advisory would pass against an analyzer that
 * collapsed every instance into one, which is the defect being closed.
 *
 * Two cases assert a positive (AFFECTED) result and are load-bearing for
 * the same reason: an all-UNKNOWN suite proves nothing.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface ScanFinding {
  readonly vulnerability: string;
  readonly package: string;
  readonly version?: string;
  readonly packageInstance?: string;
  readonly verdict: string;
  readonly evidence?: {
    readonly path?: readonly string[];
    readonly confirmedAbsentFromModuleLoadClosure?: {
      readonly packageInstance: string;
    };
    readonly confirmedAbsentInstance?: { readonly packageInstance: string };
    readonly confirmedUnreachableTarget?: unknown;
  };
}

/**
 * One stubbed OSV record, paired with the package name it is about.
 *
 * `RawVulnerability` is deliberately `Record<string, unknown>` (the raw
 * provider shape is untrusted and is validated downstream), so the name is
 * carried alongside rather than read back out of the record by the stub.
 */
interface StubAdvisory {
  readonly packageName: string;
  readonly raw: RawVulnerability;
}

function advisory(name: string, id: string, fixed = "9.0.0"): StubAdvisory {
  return {
    packageName: name,
    raw: {
      id,
      aliases: [],
      affected: [
        {
          package: { ecosystem: "npm", name },
          ranges: [
            { type: "SEMVER", events: [{ introduced: "0" }, { fixed }] },
          ],
        },
      ],
      references: [],
    },
  };
}

function providerFor(
  advisories: readonly StubAdvisory[],
): VulnerabilityProvider {
  return {
    queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
      return Promise.resolve(
        advisories
          .filter((entry) => entry.packageName === query.name)
          .map((entry) => entry.raw),
      );
    },
  };
}

function rule(id: string, name: string, exportName = "danger"): string {
  return (
    `  - id: ${id}\n` +
    `    package:\n` +
    `      name: ${name}\n` +
    `    targets:\n` +
    `      - module: ${name}\n` +
    `        export: ${exportName}\n` +
    `        kind: function\n` +
    `        confidence: 1.0\n`
  );
}

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

/** A package whose `danger` export is the advisory's target. */
function vulnerablePackage(name: string, version?: string) {
  return {
    [`package.json`]: JSON.stringify(
      version === undefined
        ? { name, main: "index.js" }
        : { name, version, main: "index.js" },
    ),
    [`index.js`]:
      "function danger(input) {\n  return input;\n}\n" +
      "function safe(input) {\n  return input;\n}\n" +
      "module.exports = { danger, safe };\n",
  };
}

function under(
  prefix: string,
  files: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [relativePath, content] of Object.entries(files)) {
    out[`${prefix}/${relativePath}`] = content;
  }
  return out;
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-multi-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

async function scan(
  root: string,
  provider: VulnerabilityProvider,
): Promise<readonly ScanFinding[]> {
  const stdout: string[] = [];
  await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    io: { stdout: (text) => stdout.push(text), stderr: () => {} },
  });
  return (JSON.parse(stdout.join("")) as { findings: ScanFinding[] }).findings;
}

/** `instance -> verdict`, the shape every case below actually asserts. */
function verdictsByInstance(
  findings: readonly ScanFinding[],
  vulnerability?: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const finding of findings) {
    if (
      vulnerability !== undefined &&
      finding.vulnerability !== vulnerability
    ) {
      continue;
    }
    out[finding.packageInstance ?? "<no instance>"] = finding.verdict;
  }
  return out;
}

/**
 * A project with a reached nested install of `vuln-lib` and an unreached
 * top-level install of the SAME name and SAME version.
 */
function twinProject(
  extraFiles: Readonly<Record<string, string>> = {},
): string {
  return project({
    "vulntrace.yml": CONFIG,
    "rules.yml": "rules:\n" + rule("GHSA-multi-0001", "vuln-lib"),
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { host: "1.0.0" },
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "app", version: "1.0.0", dependencies: { host: "1.0.0" } },
        "node_modules/host": { version: "1.0.0" },
        "node_modules/host/node_modules/vuln-lib": { version: "1.0.0" },
        "node_modules/vuln-lib": { version: "1.0.0" },
      },
    }),
    "src/index.js":
      'const host = require("host");\n' +
      "function main(input) {\n  return host.run(input);\n}\n" +
      "module.exports = { main };\n",
    "node_modules/host/package.json": JSON.stringify({
      name: "host",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/host/index.js":
      'const lib = require("vuln-lib");\n' +
      "function run(input) {\n  return lib.danger(input);\n}\n" +
      "module.exports = { run };\n",
    ...under(
      "node_modules/host/node_modules/vuln-lib",
      vulnerablePackage("vuln-lib", "1.0.0"),
    ),
    ...under("node_modules/vuln-lib", vulnerablePackage("vuln-lib", "1.0.0")),
    ...extraFiles,
  });
}

describe("P1-A5: one advisory, several instances, independent verdicts", () => {
  it("splits AFFECTED and NOT_AFFECTED across two same-version twins", async () => {
    const findings = await scan(
      twinProject(),
      providerFor([advisory("vuln-lib", "GHSA-multi-0001")]),
    );

    // Same advisory, same package, same version -- two rows, two verdicts.
    expect(verdictsByInstance(findings)).toEqual({
      "node_modules/host/node_modules/vuln-lib": "AFFECTED",
      "node_modules/vuln-lib": "NOT_AFFECTED",
    });

    const affected = findings.find((f) => f.verdict === "AFFECTED");
    const safe = findings.find((f) => f.verdict === "NOT_AFFECTED");

    // The AFFECTED evidence path stays inside its OWN instance: a path
    // through the nested copy can never make the top-level copy affected.
    for (const step of affected?.evidence?.path ?? []) {
      if (step.includes("vuln-lib")) {
        expect(step).toContain(path.join("host", "node_modules", "vuln-lib"));
      }
    }

    // And the negative proof names the safe instance, not the reached one.
    const proof =
      safe?.evidence?.confirmedAbsentFromModuleLoadClosure ??
      safe?.evidence?.confirmedAbsentInstance;
    expect(proof?.packageInstance).toBeDefined();
    expect(proof?.packageInstance).not.toContain(
      path.join("host", "node_modules", "vuln-lib"),
    );
  });

  it("does not let an UNKNOWN instance contaminate its AFFECTED sibling", async () => {
    // A third instance -- a private workspace package with no version --
    // cannot have the advisory's ranges evaluated against it at all.
    const root = twinProject({
      "packages/vuln-lib/package.json": JSON.stringify({ name: "vuln-lib" }),
      "packages/vuln-lib/index.js":
        "function danger(input) {\n  return input;\n}\nmodule.exports = { danger };\n",
    });
    // Declare the workspace so discovery is authoritative, not inferred.
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*"],
        dependencies: { host: "1.0.0" },
      }),
    );

    const findings = await scan(
      root,
      providerFor([advisory("vuln-lib", "GHSA-multi-0001")]),
    );

    expect(verdictsByInstance(findings)).toEqual({
      "node_modules/host/node_modules/vuln-lib": "AFFECTED",
      "node_modules/vuln-lib": "NOT_AFFECTED",
      // Present, and honest about why -- not silently absent, and not
      // handed its siblings' version.
      "packages/vuln-lib": "UNKNOWN",
    });

    const unknown = findings.find((f) => f.verdict === "UNKNOWN");
    expect(unknown?.version).toBeUndefined();
  });

  it("reports the versionless instance even when every sibling is safe", async () => {
    // The false-NOT_AFFECTED shape: an unknown instance hidden behind a
    // safe one. Without per-instance expansion the whole advisory reads as
    // NOT_AFFECTED and the workspace copy is never mentioned.
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules:\n" + rule("GHSA-multi-0002", "quiet-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*"],
        dependencies: { "quiet-lib": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "app",
            version: "1.0.0",
            dependencies: { "quiet-lib": "1.0.0" },
          },
          "node_modules/quiet-lib": { version: "1.0.0" },
          // The workspace copy: npm writes no version for it here, so it
          // forms no DependencyNode at all.
          "packages/quiet-lib": { name: "quiet-lib" },
        },
      }),
      "src/index.js":
        "function main(input) {\n  return input;\n}\nmodule.exports = { main };\n",
      ...under(
        "node_modules/quiet-lib",
        vulnerablePackage("quiet-lib", "1.0.0"),
      ),
      ...under("packages/quiet-lib", vulnerablePackage("quiet-lib")),
    });

    const verdicts = verdictsByInstance(
      await scan(root, providerFor([advisory("quiet-lib", "GHSA-multi-0002")])),
    );

    expect(verdicts["node_modules/quiet-lib"]).toBe("NOT_AFFECTED");
    expect(verdicts["packages/quiet-lib"]).toBe("UNKNOWN");
  });

  it("emits no finding for an out-of-range instance and keeps its in-range twin", async () => {
    // The unchanged TASK-011 contract, now stated per instance: a
    // confidently out-of-range instance produces no finding, and that says
    // nothing at all about the sibling that IS in range.
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules:\n" + rule("GHSA-multi-0003", "ver-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { host: "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": {
            name: "app",
            version: "1.0.0",
            dependencies: { host: "1.0.0" },
          },
          "node_modules/host": { version: "1.0.0" },
          // Patched, above the advisory's `fixed` boundary.
          "node_modules/ver-lib": { version: "5.0.0" },
          // Vulnerable.
          "node_modules/host/node_modules/ver-lib": { version: "1.0.0" },
        },
      }),
      "src/index.js":
        'const host = require("host");\n' +
        "function main(input) {\n  return host.run(input);\n}\n" +
        "module.exports = { main };\n",
      "node_modules/host/package.json": JSON.stringify({
        name: "host",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/host/index.js":
        'const lib = require("ver-lib");\n' +
        "function run(input) {\n  return lib.danger(input);\n}\n" +
        "module.exports = { run };\n",
      ...under("node_modules/ver-lib", vulnerablePackage("ver-lib", "5.0.0")),
      ...under(
        "node_modules/host/node_modules/ver-lib",
        vulnerablePackage("ver-lib", "1.0.0"),
      ),
    });

    const findings = await scan(
      root,
      providerFor([advisory("ver-lib", "GHSA-multi-0003", "2.0.0")]),
    );

    expect(verdictsByInstance(findings)).toEqual({
      "node_modules/host/node_modules/ver-lib": "AFFECTED",
    });
    // Each instance was matched against its OWN version: the patched copy
    // was excluded on its own 5.0.0, never on its sibling's 1.0.0.
    expect(findings.every((f) => f.version === "1.0.0")).toBe(true);
  });

  it("keeps two advisories about one instance as two independent findings", async () => {
    const findings = await scan(
      twinProject(),
      providerFor([
        advisory("vuln-lib", "GHSA-multi-0001"),
        advisory("vuln-lib", "GHSA-multi-0009"),
      ]),
    );

    // Four findings: two advisories x two instances, and no target state
    // shared across either axis.
    expect(findings).toHaveLength(4);
    expect(verdictsByInstance(findings, "GHSA-multi-0001")).toEqual({
      "node_modules/host/node_modules/vuln-lib": "AFFECTED",
      "node_modules/vuln-lib": "NOT_AFFECTED",
    });
    // The second advisory has no rule, so it is UNKNOWN for both -- and
    // crucially it does not inherit the first advisory's resolved target.
    expect(verdictsByInstance(findings, "GHSA-multi-0009")).toEqual({
      "node_modules/host/node_modules/vuln-lib": "UNKNOWN",
      "node_modules/vuln-lib": "UNKNOWN",
    });
  });

  it("never deduplicates two findings that share advisory, name and version", async () => {
    const findings = await scan(
      twinProject(),
      providerFor([advisory("vuln-lib", "GHSA-multi-0001")]),
    );

    const identityless = findings.map(
      (f) => `${f.vulnerability}|${f.package}|${f.version ?? ""}`,
    );
    // Both rows are identical on every field a naive dedupe key would use.
    expect(new Set(identityless).size).toBe(1);
    expect(findings).toHaveLength(2);
    // And are distinguishable on the one field that is identity.
    expect(new Set(findings.map((f) => f.packageInstance)).size).toBe(2);
  });
});

describe("P1-A5: results do not depend on enumeration order", () => {
  it("produces the identical finding set with the lockfile order reversed", async () => {
    const provider = providerFor([advisory("vuln-lib", "GHSA-multi-0001")]);

    const forward = await scan(twinProject(), provider);

    const reversedRoot = twinProject();
    const lockPath = path.join(reversedRoot, "package-lock.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf-8")) as {
      packages: Record<string, unknown>;
    };
    lock.packages = Object.fromEntries(Object.entries(lock.packages).reverse());
    writeFileSync(lockPath, JSON.stringify(lock));

    const reversed = await scan(reversedRoot, provider);

    // Same instances, same verdicts. Output order is deterministic, and
    // the SEMANTIC result does not depend on traversal order at all.
    expect(verdictsByInstance(reversed)).toEqual(verdictsByInstance(forward));
    expect(reversed.map((f) => f.packageInstance)).toEqual(
      forward.map((f) => f.packageInstance),
    );
  });
});
