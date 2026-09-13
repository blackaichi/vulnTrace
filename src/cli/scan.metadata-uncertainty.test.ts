import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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
 * FOUNDATION F1-B -- LOCKFILE VS INSTALLED MANIFEST VERSION AUTHORITY,
 * end to end through the real scan command, with only the OSV boundary
 * stubbed.
 *
 * The defect this suite pins: a project's dependency metadata claims one
 * version for a package root and the package ACTUALLY INSTALLED at that
 * root claims another. Before F1-B the declared version won unopposed, so
 * every advisory range was evaluated against a version that describes no
 * code on disk. Both directions are real and both are reproduced below:
 *
 * - Case A -- the declared version is in range and the installed one is
 *   not: a confident AFFECTED about code that is not installed.
 * - Case B -- the installed version is in range and the declared one is
 *   not: no finding at all, about genuinely vulnerable installed code.
 *
 * Neither direction is fixed by preferring one source. Preferring the
 * manifest fixes A and B and breaks the ordinary case where the manifest
 * is absent; preferring the lockfile is today's behavior. The fix is to
 * treat both as CLAIMS and to fail closed when they contradict: no
 * version, no provider query, no verdict derived from a version nothing
 * established -- and a diagnostic, so the resulting silence is legible.
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
}

interface ScanOutputShape {
  readonly findings: ScanFinding[];
  readonly diagnostics: { readonly source: string; readonly message: string }[];
}

/** An advisory over an explicit half-open SemVer range. */
function advisory(
  name: string,
  id: string,
  introduced: string,
  fixed: string,
): RawVulnerability {
  return {
    id,
    aliases: [],
    affected: [
      {
        package: { ecosystem: "npm", name },
        ranges: [{ type: "SEMVER", events: [{ introduced }, { fixed }] }],
      },
    ],
    references: [],
  };
}

/**
 * A provider that records every query it is asked, so a test can assert on
 * the query SET itself (F1 § 22): a conflicted instance must contribute no
 * query at all, rather than one made with an arbitrary version.
 */
function recordingProvider(advisories: readonly RawVulnerability[]): {
  readonly provider: VulnerabilityProvider;
  readonly queries: PackageQuery[];
} {
  const queries: PackageQuery[] = [];
  return {
    queries,
    provider: {
      queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
        queries.push(query);
        return Promise.resolve(
          advisories.filter((raw) =>
            (
              raw as { affected?: { package?: { name?: string } }[] }
            ).affected?.some((entry) => entry.package?.name === query.name),
          ),
        );
      },
    },
  };
}

function rule(id: string, name: string): string {
  // Quoted: a scoped name starts with `@`, which YAML reserves.
  const quoted = JSON.stringify(name);
  return (
    `  - id: ${id}\n` +
    `    package:\n` +
    `      name: ${quoted}\n` +
    `    targets:\n` +
    `      - module: ${quoted}\n` +
    `        export: danger\n` +
    `        kind: function\n` +
    `        confidence: 1.0\n`
  );
}

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

const LIB_SOURCE =
  "function danger(input) {\n  return input;\n}\n" +
  "function safe(input) {\n  return input;\n}\n" +
  "module.exports = { danger, safe };\n";

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f1-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

async function scanOutput(
  root: string,
  provider: VulnerabilityProvider,
): Promise<ScanOutputShape> {
  const stdout: string[] = [];
  await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    io: { stdout: (text) => stdout.push(text), stderr: () => {} },
  });
  return JSON.parse(stdout.join("")) as ScanOutputShape;
}

/** Diagnostics that name a version contradiction, in message order. */
function conflictDiagnostics(output: ScanOutputShape): readonly string[] {
  return output.diagnostics
    .filter((diagnostic) => diagnostic.message.includes("conflicting versions"))
    .map((diagnostic) => diagnostic.message);
}

/**
 * A one-dependency project whose lockfile and installed manifest can be
 * made to disagree at will.
 *
 * `declaredVersion` is what the lockfile (and the root manifest's
 * dependency range) claim; `installedVersion` is what the package actually
 * installed at `node_modules/vuln-lib` claims about itself. `undefined`
 * omits the `"version"` field entirely; `null` writes an unparseable
 * manifest.
 */
function divergentProject(options: {
  readonly declaredVersion?: string;
  readonly installedVersion?: string | null;
  readonly extraFiles?: Readonly<Record<string, string>>;
}): string {
  const { declaredVersion, installedVersion, extraFiles = {} } = options;
  const manifest =
    installedVersion === null
      ? "{ this is not JSON"
      : JSON.stringify(
          installedVersion === undefined
            ? { name: "vuln-lib", main: "index.js" }
            : { name: "vuln-lib", version: installedVersion, main: "index.js" },
        );
  return project({
    "vulntrace.yml": CONFIG,
    "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "vuln-lib"),
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "vuln-lib": declaredVersion ?? "*" },
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "app", version: "1.0.0" },
        "node_modules/vuln-lib":
          declaredVersion === undefined ? {} : { version: declaredVersion },
      },
    }),
    "src/index.js":
      'const lib = require("vuln-lib");\n' +
      "function main(input) {\n  return lib.danger(input);\n}\n" +
      "module.exports = { main };\n",
    "node_modules/vuln-lib/package.json": manifest,
    "node_modules/vuln-lib/index.js": LIB_SOURCE,
    ...extraFiles,
  });
}

describe("F1-B: lockfile vs installed manifest version authority", () => {
  it("Case A -- does not report AFFECTED from a declared version the installed package contradicts", async () => {
    // Lockfile: 1.0.0. Installed on disk: 2.0.0. Advisory: < 1.5.0.
    // The vulnerable version is the one that is NOT installed, so a
    // confident AFFECTED here is a false positive about absent code.
    const root = divergentProject({
      declaredVersion: "1.0.0",
      installedVersion: "2.0.0",
    });
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "1.5.0"),
    ]);

    const output = await scanOutput(root, provider);

    expect(
      output.findings.filter((finding) => finding.verdict === "AFFECTED"),
    ).toEqual([]);
    // § 22: not "a query with the right version" -- no query at all. There
    // is no version to ask about.
    expect(queries.map((query) => query.version)).toEqual([]);
    // § 23: the absence of a finding must not be silent.
    expect(conflictDiagnostics(output)).toHaveLength(1);
    expect(conflictDiagnostics(output)[0]).toContain(
      "1.0.0 (declared), 2.0.0 (installed)",
    );
    expect(conflictDiagnostics(output)[0]).toContain("node_modules/vuln-lib");
  });

  it("Case B -- does not silently return nothing when the INSTALLED version is the vulnerable one", async () => {
    // Lockfile: 1.0.0. Installed on disk: 2.0.0. Advisory: >= 2.0.0 < 3.0.0.
    // The vulnerable version IS what is installed and reachable. Before
    // F1-B this scan produced no finding and no diagnostic whatsoever.
    const root = divergentProject({
      declaredVersion: "1.0.0",
      installedVersion: "2.0.0",
    });
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "2.0.0", "3.0.0"),
    ]);

    const output = await scanOutput(root, provider);

    // The honest answer is still not AFFECTED -- the project's own
    // metadata contradicts itself, so applicability is indeterminate --
    // but it must no longer be SILENT.
    expect(conflictDiagnostics(output)).toHaveLength(1);
    expect(conflictDiagnostics(output)[0]).toContain(
      "no advisory version range was evaluated against it",
    );
    expect(queries.map((query) => query.version)).toEqual([]);
  });

  it("§ 15 control -- an agreeing lockfile and manifest keep the existing AFFECTED verdict", async () => {
    const root = divergentProject({
      declaredVersion: "1.2.3",
      installedVersion: "1.2.3",
    });
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "2.0.0"),
    ]);

    const output = await scanOutput(root, provider);

    expect(output.findings.map((finding) => finding.verdict)).toEqual([
      "AFFECTED",
    ]);
    expect(output.findings[0]?.version).toBe("1.2.3");
    expect(queries.map((query) => query.version)).toEqual(["1.2.3"]);
    expect(conflictDiagnostics(output)).toEqual([]);
  });

  it("§ 16 -- a manifest with no version field makes no competing claim, so the declared version still applies", async () => {
    const root = divergentProject({
      declaredVersion: "1.2.3",
      installedVersion: undefined,
    });
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "2.0.0"),
    ]);

    const output = await scanOutput(root, provider);

    expect(output.findings.map((finding) => finding.verdict)).toEqual([
      "AFFECTED",
    ]);
    expect(output.findings[0]?.version).toBe("1.2.3");
    expect(queries.map((query) => query.version)).toEqual(["1.2.3"]);
    expect(conflictDiagnostics(output)).toEqual([]);
  });

  it("§ 17 -- a local package's own manifest version is the authority when no lockfile entry declares one", async () => {
    // The workspace member is declared by the repository's `workspaces`
    // and has NO lockfile entry at all. The only version anywhere is the
    // one the package declares about itself, and it is the authority for
    // that physical root -- it is literally the file Node reads.
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*"],
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: { "": { name: "app", version: "1.0.0" } },
      }),
      "src/index.js":
        'const lib = require("vuln-lib");\n' +
        "function main(input) {\n  return lib.danger(input);\n}\n" +
        "module.exports = { main };\n",
      "packages/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "packages/vuln-lib/index.js": LIB_SOURCE,
      "node_modules/.package-lock.json": "{}",
    });
    symlinkSync(
      path.join(root, "packages/vuln-lib"),
      path.join(root, "node_modules/vuln-lib"),
      "dir",
    );
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "2.0.0"),
    ]);

    const output = await scanOutput(root, provider);

    expect(output.findings.map((finding) => finding.verdict)).toEqual([
      "AFFECTED",
    ]);
    expect(output.findings[0]?.version).toBe("1.0.0");
    expect(queries.map((query) => query.version)).toEqual(["1.0.0"]);
    expect(conflictDiagnostics(output)).toEqual([]);
  });

  it("§ 17 limitation -- a versionless lockfile entry is never enumerated, so its manifest version cannot rescue it", async () => {
    // Pinned, not fixed. `buildDependencyGraph` forms no `DependencyNode`
    // for a lockfile entry with no `version` ("inherent to
    // unversioned/local links"), so this root reaches the registry through
    // NO authority at all -- there is no instance for a manifest version to
    // attach to. That is an ENUMERATION gap, not a metadata-authority one,
    // and closing it means changing what a `DependencyNode` is, which this
    // task deliberately does not do. Recorded as a remaining limitation.
    const root = divergentProject({
      declaredVersion: undefined,
      installedVersion: "1.0.0",
    });
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "2.0.0"),
    ]);

    const output = await scanOutput(root, provider);

    expect(output.findings).toEqual([]);
    expect(queries).toEqual([]);
  });

  it("§ 18 -- an unparseable installed manifest fails closed rather than trusting the declared version", async () => {
    const root = divergentProject({
      declaredVersion: "1.0.0",
      installedVersion: null,
    });
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "2.0.0"),
    ]);

    const output = await scanOutput(root, provider);

    expect(
      output.findings.filter((finding) => finding.verdict === "AFFECTED"),
    ).toEqual([]);
    expect(queries.map((query) => query.version)).toEqual([]);
    expect(
      output.diagnostics.filter((diagnostic) =>
        diagnostic.message.includes("could not be read"),
      ),
    ).toHaveLength(1);
  });

  it("§ 20 control -- the same name at two physical roots with two versions is not a conflict", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0", host: "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/vuln-lib": { version: "1.0.0" },
          "node_modules/host": { version: "1.0.0" },
          "node_modules/host/node_modules/vuln-lib": { version: "2.0.0" },
        },
      }),
      "src/index.js":
        'const lib = require("vuln-lib");\n' +
        "function main(input) {\n  return lib.danger(input);\n}\n" +
        "module.exports = { main };\n",
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/vuln-lib/index.js": LIB_SOURCE,
      "node_modules/host/package.json": JSON.stringify({
        name: "host",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/host/index.js": "module.exports = { run: (x) => x };\n",
      "node_modules/host/node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "2.0.0",
        main: "index.js",
      }),
      "node_modules/host/node_modules/vuln-lib/index.js": LIB_SOURCE,
    });
    const { provider } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "3.0.0"),
    ]);

    const output = await scanOutput(root, provider);

    // Two independent instances, two versions, no contradiction.
    expect(conflictDiagnostics(output)).toEqual([]);
    expect(
      output.findings.some((finding) => finding.verdict === "AFFECTED"),
    ).toBe(true);
  });

  it("§ 19 -- a node_modules symlink and its workspace target converge on one instance and one conflict", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*"],
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          // The lockfile claims 1.0.0 for the very directory the workspace
          // member's own manifest says is 2.0.0.
          "packages/vuln-lib": { name: "vuln-lib", version: "1.0.0" },
        },
      }),
      "src/index.js":
        'const lib = require("vuln-lib");\n' +
        "function main(input) {\n  return lib.danger(input);\n}\n" +
        "module.exports = { main };\n",
      "packages/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "2.0.0",
        main: "index.js",
      }),
      "packages/vuln-lib/index.js": LIB_SOURCE,
      // Materializes `node_modules/` so the symlink below has a parent.
      "node_modules/.package-lock.json": "{}",
    });
    symlinkSync(
      path.join(root, "packages/vuln-lib"),
      path.join(root, "node_modules/vuln-lib"),
      "dir",
    );
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "1.5.0"),
    ]);

    const output = await scanOutput(root, provider);

    // ONE logical instance, therefore exactly ONE conflict diagnostic --
    // not one per metadata source that named the directory.
    expect(conflictDiagnostics(output)).toHaveLength(1);
    expect(queries.map((query) => query.version)).toEqual([]);
    expect(
      output.findings.filter((finding) => finding.verdict === "AFFECTED"),
    ).toEqual([]);
  });

  it("§ 21 -- reversing the lockfile's own entry order changes nothing", async () => {
    const build = (reversed: boolean): string => {
      const entries: [string, unknown][] = [
        ["node_modules/a-lib", { version: "1.0.0" }],
        ["node_modules/vuln-lib", { version: "1.0.0" }],
      ];
      const ordered = reversed ? [...entries].reverse() : entries;
      return project({
        "vulntrace.yml": CONFIG,
        "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "vuln-lib"),
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { "vuln-lib": "1.0.0", "a-lib": "1.0.0" },
        }),
        "package-lock.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: Object.fromEntries([
            ["", { name: "app", version: "1.0.0" }],
            ...ordered,
          ]),
        }),
        "src/index.js":
          'const lib = require("vuln-lib");\n' +
          "function main(input) {\n  return lib.danger(input);\n}\n" +
          "module.exports = { main };\n",
        "node_modules/a-lib/package.json": JSON.stringify({
          name: "a-lib",
          version: "1.0.0",
          main: "index.js",
        }),
        "node_modules/a-lib/index.js": "module.exports = {};\n",
        "node_modules/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "2.0.0",
          main: "index.js",
        }),
        "node_modules/vuln-lib/index.js": LIB_SOURCE,
      });
    };
    const advisories = [advisory("vuln-lib", "GHSA-f1-0001", "0", "1.5.0")];

    const forward = recordingProvider(advisories);
    const backward = recordingProvider(advisories);
    const a = await scanOutput(build(false), forward.provider);
    const b = await scanOutput(build(true), backward.provider);

    expect(conflictDiagnostics(a)).toEqual(conflictDiagnostics(b));
    expect(a.findings.map((f) => f.verdict)).toEqual(
      b.findings.map((f) => f.verdict),
    );
    expect(
      forward.queries.map((q) => `${q.name}@${q.version ?? ""}`).sort(),
    ).toEqual(
      backward.queries.map((q) => `${q.name}@${q.version ?? ""}`).sort(),
    );
  });

  it("§ 14 -- a conflict on one instance does not contaminate a sibling", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml":
        "rules:\n" +
        rule("GHSA-f1-0001", "vuln-lib") +
        rule("GHSA-f1-0002", "other-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0", "other-lib": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/vuln-lib": { version: "1.0.0" },
          "node_modules/other-lib": { version: "1.0.0" },
        },
      }),
      "src/index.js":
        'const lib = require("vuln-lib");\n' +
        'const other = require("other-lib");\n' +
        "function main(input) {\n  return lib.danger(other.danger(input));\n}\n" +
        "module.exports = { main };\n",
      // Divergent.
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "2.0.0",
        main: "index.js",
      }),
      "node_modules/vuln-lib/index.js": LIB_SOURCE,
      // Consistent.
      "node_modules/other-lib/package.json": JSON.stringify({
        name: "other-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/other-lib/index.js": LIB_SOURCE,
    });
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "1.5.0"),
      advisory("other-lib", "GHSA-f1-0002", "0", "1.5.0"),
    ]);

    const output = await scanOutput(root, provider);

    expect(conflictDiagnostics(output)).toHaveLength(1);
    expect(conflictDiagnostics(output)[0]).toContain("vuln-lib");
    // The healthy sibling keeps its query and its verdict.
    expect(queries.map((q) => `${q.name}@${q.version ?? "-"}`)).toContain(
      "other-lib@1.0.0",
    );
    expect(
      output.findings
        .filter((finding) => finding.package === "other-lib")
        .map((finding) => finding.verdict),
    ).toEqual(["AFFECTED"]);
  });
});

describe("F1-B: alias and scoped-package ownership survive version reconciliation", () => {
  /**
   * An npm alias install: the directory is `vuln-alias`, the package's own
   * identity is `vuln-lib`. P1-A3 makes BOTH names select the instance, and
   * reconciling versions must not narrow that -- the same single manifest
   * read now answers the name question and the version question.
   */
  function aliasProject(installedVersion: string): string {
    return project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-alias": "npm:vuln-lib@1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/vuln-alias": { name: "vuln-lib", version: "1.0.0" },
        },
      }),
      "src/index.js":
        'const lib = require("vuln-alias");\n' +
        "function main(input) {\n  return lib.danger(input);\n}\n" +
        "module.exports = { main };\n",
      "node_modules/vuln-alias/package.json": JSON.stringify({
        name: "vuln-lib",
        version: installedVersion,
        main: "index.js",
      }),
      "node_modules/vuln-alias/index.js": LIB_SOURCE,
    });
  }

  it("still selects an aliased instance by its real name when the versions agree (control)", async () => {
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "2.0.0"),
    ]);

    const output = await scanOutput(aliasProject("1.0.0"), provider);

    // The advisory names `vuln-lib`; the directory is `vuln-alias`. That
    // this finding exists at all is the alias-ownership assertion.
    expect(output.findings.map((finding) => finding.verdict)).toEqual([
      "AFFECTED",
    ]);
    expect(output.findings[0]?.packageInstance).toBe("node_modules/vuln-alias");
    expect(queries.map((query) => query.version)).toEqual(["1.0.0"]);
    expect(conflictDiagnostics(output)).toEqual([]);
  });

  it("§ 24.3 -- an aliased instance whose manifest contradicts the lockfile fails closed", async () => {
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "1.5.0"),
    ]);

    const output = await scanOutput(aliasProject("2.0.0"), provider);

    expect(
      output.findings.filter((finding) => finding.verdict === "AFFECTED"),
    ).toEqual([]);
    expect(queries.map((query) => query.version)).toEqual([]);
    expect(conflictDiagnostics(output)).toHaveLength(1);
    // Reported under its real identity, at its real install directory.
    expect(conflictDiagnostics(output)[0]).toContain("vuln-lib");
    expect(conflictDiagnostics(output)[0]).toContain("node_modules/vuln-alias");
  });

  it("handles a scoped package's contradiction under its full scoped name", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "@scope/vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "@scope/vuln-lib": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/@scope/vuln-lib": { version: "1.0.0" },
        },
      }),
      "src/index.js":
        'const lib = require("@scope/vuln-lib");\n' +
        "function main(input) {\n  return lib.danger(input);\n}\n" +
        "module.exports = { main };\n",
      "node_modules/@scope/vuln-lib/package.json": JSON.stringify({
        name: "@scope/vuln-lib",
        version: "2.0.0",
        main: "index.js",
      }),
      "node_modules/@scope/vuln-lib/index.js": LIB_SOURCE,
    });
    const { provider, queries } = recordingProvider([
      advisory("@scope/vuln-lib", "GHSA-f1-0001", "0", "1.5.0"),
    ]);

    const output = await scanOutput(root, provider);

    expect(
      output.findings.filter((finding) => finding.verdict === "AFFECTED"),
    ).toEqual([]);
    expect(queries.map((query) => query.version)).toEqual([]);
    expect(conflictDiagnostics(output)).toHaveLength(1);
    expect(conflictDiagnostics(output)[0]).toContain("@scope/vuln-lib");
  });
});

describe("F1 remediation: conflict diagnostics state TRUE provenance", () => {
  /** The one diagnostic naming a version contradiction. */
  function onlyConflict(output: ScanOutputShape): string {
    const messages = conflictDiagnostics(output);
    expect(messages).toHaveLength(1);
    return messages[0] ?? "";
  }

  it("labels a declared version and an installed version as what they are", async () => {
    // THE BLOCKING CASE. Before this fix the message read "...conflicting
    // versions 1.0.0, 2.0.0 by this project's own dependency metadata",
    // which is false: 2.0.0 appears nowhere in the lockfile or the root
    // manifest -- it exists only in node_modules/vuln-lib/package.json.
    // A reader was sent to grep dependency metadata for a version that was
    // never there.
    const root = divergentProject({
      declaredVersion: "1.0.0",
      installedVersion: "2.0.0",
    });
    const { provider } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "1.5.0"),
    ]);

    const message = onlyConflict(await scanOutput(root, provider));

    expect(message).toContain("1.0.0 (declared)");
    expect(message).toContain("2.0.0 (installed)");
    expect(message).toContain(
      "these claims come from this project's own dependency metadata and from the package installed on disk",
    );
    // The precise false statement this remediation exists to remove.
    expect(message).not.toContain(
      "1.0.0, 2.0.0 by this project's own dependency metadata",
    );
  });

  it("keeps the accurate all-declared wording when no installed claim exists", async () => {
    // Two lockfile entries contradict each other; the package installed at
    // the root they share declares no version at all, so it is silent and
    // makes no claim. Nothing on disk is implicated, and the message must
    // not pretend otherwise.
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "lib-a": "1.0.0", "lib-b": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/lib-a": { name: "vuln-lib", version: "1.0.0" },
          "node_modules/lib-b": { name: "vuln-lib", version: "2.0.0" },
        },
      }),
      "src/index.js":
        "function main(input) {\n  return input;\n}\nmodule.exports = { main };\n",
      "real/package.json": JSON.stringify({
        name: "vuln-lib",
        main: "index.js",
      }),
      "real/index.js": LIB_SOURCE,
      "node_modules/.package-lock.json": "{}",
    });
    symlinkSync(
      path.join(root, "real"),
      path.join(root, "node_modules/lib-a"),
      "dir",
    );
    symlinkSync(
      path.join(root, "real"),
      path.join(root, "node_modules/lib-b"),
      "dir",
    );
    const { provider } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "9.0.0"),
    ]);

    const message = onlyConflict(await scanOutput(root, provider));

    expect(message).toContain("1.0.0 (declared), 2.0.0 (declared)");
    expect(message).toContain(
      "every claim comes from this project's own dependency metadata",
    );
    expect(message).not.toContain("installed on disk");
  });

  it("attributes one version to every authority that claimed it, without repeating it", async () => {
    // The workspace declaration and the installed manifest are the SAME
    // FILE for a workspace root, so both vouch for 1.0.0; the lockfile
    // entry for that same root says 3.0.0. The version must appear once,
    // carrying all three labels it has earned.
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*"],
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "packages/vuln-lib": { name: "vuln-lib", version: "3.0.0" },
        },
      }),
      "src/index.js":
        "function main(input) {\n  return input;\n}\nmodule.exports = { main };\n",
      "packages/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: "1.0.0",
        main: "index.js",
      }),
      "packages/vuln-lib/index.js": LIB_SOURCE,
    });
    const { provider } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "9.0.0"),
    ]);

    const message = onlyConflict(await scanOutput(root, provider));

    expect(message).toContain("1.0.0 (installed, workspace), 3.0.0 (declared)");
  });

  it("produces byte-identical provenance whichever order the claims arrive in", async () => {
    const build = (reversed: boolean): string => {
      const entries: [string, unknown][] = [
        ["node_modules/lib-a", { name: "vuln-lib", version: "1.0.0" }],
        ["node_modules/lib-b", { name: "vuln-lib", version: "2.0.0" }],
      ];
      const ordered = reversed ? [...entries].reverse() : entries;
      const root = project({
        "vulntrace.yml": CONFIG,
        "rules.yml": "rules:\n" + rule("GHSA-f1-0001", "vuln-lib"),
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { "lib-a": "1.0.0", "lib-b": "1.0.0" },
        }),
        "package-lock.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          lockfileVersion: 3,
          packages: Object.fromEntries([
            ["", { name: "app", version: "1.0.0" }],
            ...ordered,
          ]),
        }),
        "src/index.js":
          "function main(input) {\n  return input;\n}\nmodule.exports = { main };\n",
        "real/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "5.0.0",
          main: "index.js",
        }),
        "real/index.js": LIB_SOURCE,
        "node_modules/.package-lock.json": "{}",
      });
      symlinkSync(
        path.join(root, "real"),
        path.join(root, "node_modules/lib-a"),
        "dir",
      );
      symlinkSync(
        path.join(root, "real"),
        path.join(root, "node_modules/lib-b"),
        "dir",
      );
      return root;
    };
    const advisories = [advisory("vuln-lib", "GHSA-f1-0001", "0", "9.0.0")];

    const forward = onlyConflict(
      await scanOutput(build(false), recordingProvider(advisories).provider),
    );
    const backward = onlyConflict(
      await scanOutput(build(true), recordingProvider(advisories).provider),
    );

    expect(forward).toBe(backward);
    expect(forward).toContain(
      "1.0.0 (declared), 2.0.0 (declared), 5.0.0 (installed)",
    );
  });

  it("does not say a manifest was unreadable when only its version field is unusable", async () => {
    // The file reads and parses perfectly; `"version": 123` is simply not
    // a version. Behavior is unchanged -- still fails closed -- but
    // "could not be read" describes a corrupt file that does not exist
    // here, and sends a reader looking for the wrong thing.
    const root = divergentProject({ declaredVersion: "1.0.0" });
    writeFileSync(
      path.join(root, "node_modules/vuln-lib/package.json"),
      '{"name":"vuln-lib","version":123,"main":"index.js"}',
    );
    const { provider, queries } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "9.0.0"),
    ]);

    const output = await scanOutput(root, provider);
    const messages = output.diagnostics
      .filter((diagnostic) => diagnostic.source === "dependencies")
      .map((diagnostic) => diagnostic.message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      'whose "version" field is not a usable version string',
    );
    expect(messages[0]).not.toContain("could not be read");
    // Behavior is untouched: still fails closed, still no query.
    expect(
      output.findings.filter((finding) => finding.verdict === "AFFECTED"),
    ).toEqual([]);
    expect(queries.map((query) => query.version)).toEqual([]);
  });

  it("still says 'could not be read' for a genuinely unparseable manifest", async () => {
    const root = divergentProject({
      declaredVersion: "1.0.0",
      installedVersion: null,
    });
    const { provider } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "9.0.0"),
    ]);

    const messages = (await scanOutput(root, provider)).diagnostics
      .filter((diagnostic) => diagnostic.source === "dependencies")
      .map((diagnostic) => diagnostic.message);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain(
      "has an installed package.json that could not be read",
    );
  });

  it("emits no conflict diagnostic when declared and installed agree (control)", async () => {
    const { provider } = recordingProvider([
      advisory("vuln-lib", "GHSA-f1-0001", "0", "9.0.0"),
    ]);

    const output = await scanOutput(
      divergentProject({ declaredVersion: "1.2.3", installedVersion: "1.2.3" }),
      provider,
    );

    expect(conflictDiagnostics(output)).toEqual([]);
    expect(
      output.diagnostics.filter((d) => d.source === "dependencies"),
    ).toEqual([]);
  });
});
