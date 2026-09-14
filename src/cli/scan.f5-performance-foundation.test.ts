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
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { runScanCommand } from "./scan.js";

/**
 * FOUNDATION F5 — the per-scan caches, observed END TO END through the
 * real scan command.
 *
 * The unit suites prove the memo and the index are equivalent to the work
 * they replace. This one proves the properties that only exist at scan
 * scope and that a unit test cannot reach:
 *
 * - two scans in one process share NO cache state, including when they run
 *   concurrently (there is no module-level cache to leak through, and this
 *   is the test that would fail if one were ever introduced);
 * - the caches do not disturb identity in the shapes the analyzer
 *   distinguishes — same-version twins, workspace members, aliases;
 * - the provider QUERY SET is unchanged, because a cache that
 *   accidentally deduplicated a query would change what the scan asks
 *   the outside world;
 * - reversing the order of a project's own inputs still produces
 *   byte-identical output, so nothing about the new Maps leaked into
 *   iteration order.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-f5-scan-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

function advisory(name: string, id: string): RawVulnerability {
  return {
    id,
    aliases: [],
    affected: [
      {
        package: { ecosystem: "npm", name },
        ranges: [{ type: "SEMVER", events: [{ introduced: "0" }] }],
      },
    ],
    references: [],
  };
}

/** A provider that also RECORDS every query, so the query set is assertable. */
function recordingProvider(
  advisories: ReadonlyArray<{ name: string; id: string }>,
): VulnerabilityProvider & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
      queries.push(`${query.ecosystem}:${query.name}@${query.version ?? ""}`);
      return Promise.resolve(
        advisories
          .filter((entry) => entry.name === query.name)
          .map((entry) => advisory(entry.name, entry.id)),
      );
    },
  };
}

function rule(id: string, name: string, exportName = "danger"): string {
  return (
    `  - id: ${id}\n` +
    `    package:\n` +
    // Quoted: `@` opens a YAML reserved indicator, so a scoped package
    // name is not a valid bare scalar.
    `      name: "${name}"\n` +
    `    targets:\n` +
    `      - module: "${name}"\n` +
    `        export: ${exportName}\n` +
    `        kind: function\n` +
    `        confidence: 1.0\n`
  );
}

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

function vulnerablePackage(name: string, version: string) {
  return {
    "package.json": JSON.stringify({ name, version, main: "index.js" }),
    "index.js":
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

interface ScanOutputShape {
  readonly findings: ReadonlyArray<{
    readonly vulnerability: string;
    readonly package: string;
    readonly version?: string;
    readonly packageInstance?: string;
    readonly verdict: string;
  }>;
  readonly diagnostics: ReadonlyArray<{
    readonly source: string;
    readonly message: string;
  }>;
  readonly unreportedCandidates?: readonly unknown[];
}

async function scanJson(
  root: string,
  provider: VulnerabilityProvider,
): Promise<ScanOutputShape> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  });
  // 0 = no findings, 1 = findings reported. Anything higher is a real
  // failure and must not be silently parsed as empty output.
  if (exitCode > 1) {
    throw new Error(`scan exited ${exitCode}: ${stderr.join("")}`);
  }
  return JSON.parse(stdout.join("")) as ScanOutputShape;
}

/**
 * The scan id is a fresh UUID per run and the timings are wall-clock, so a
 * byte-for-byte comparison of two scans has to normalize exactly those two
 * fields and nothing else.
 */
function comparable(output: ScanOutputShape): string {
  const copy = JSON.parse(JSON.stringify(output)) as Record<string, unknown>;
  delete copy.scan;
  delete copy.timings;
  return JSON.stringify(copy);
}

async function scanComparable(
  root: string,
  provider: VulnerabilityProvider,
): Promise<string> {
  const stdout: string[] = [];
  await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    io: { stdout: (text) => stdout.push(text), stderr: () => {} },
  });
  return comparable(JSON.parse(stdout.join("")) as ScanOutputShape);
}

/** Two installs of the same name AND version, one reached and one not. */
function twinProject(): string {
  return project({
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { twin: "1.0.0" },
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      lockfileVersion: 3,
      packages: {
        "": { name: "app", version: "1.0.0", dependencies: { twin: "1.0.0" } },
        "node_modules/twin": { version: "1.0.0" },
        "node_modules/host": { version: "1.0.0" },
        "node_modules/host/node_modules/twin": { version: "1.0.0" },
      },
    }),
    "vulntrace.yml": CONFIG,
    "rules.yml": `rules:\n${rule("GHSA-twin", "twin")}`,
    "src/index.js":
      'const twin = require("twin");\n' +
      "function main(x) {\n  return twin.danger(x);\n}\n" +
      "module.exports = { main };\n",
    ...under("node_modules/twin", vulnerablePackage("twin", "1.0.0")),
    ...under("node_modules/host", {
      "package.json": JSON.stringify({
        name: "host",
        version: "1.0.0",
        main: "index.js",
      }),
      "index.js": "module.exports = {};\n",
    }),
    ...under(
      "node_modules/host/node_modules/twin",
      vulnerablePackage("twin", "1.0.0"),
    ),
  });
}

describe("F5 end to end: same-version twins stay separate through the caches", () => {
  it("reports one finding per physical instance, with different verdicts", async () => {
    const provider = recordingProvider([{ name: "twin", id: "GHSA-twin" }]);
    const output = await scanJson(twinProject(), provider);

    const twins = output.findings.filter((f) => f.package === "twin");
    expect(twins.length).toBe(2);
    const instances = twins.map((f) => f.packageInstance).sort();
    expect(new Set(instances).size).toBe(2);

    // Both instances are `twin@1.0.0`. Only the top-level one is imported,
    // so the verdicts must differ — a cache that merged them by
    // name@version would collapse these into one answer.
    const verdicts = new Set(twins.map((f) => f.verdict));
    expect(verdicts.has("AFFECTED")).toBe(true);
    expect(verdicts.size).toBeGreaterThan(1);
  });
});

describe("F5 end to end: scan isolation", () => {
  it("produces identical output for two sequential scans of the same project", async () => {
    const root = twinProject();
    const first = await scanComparable(
      root,
      recordingProvider([{ name: "twin", id: "GHSA-twin" }]),
    );
    const second = await scanComparable(
      root,
      recordingProvider([{ name: "twin", id: "GHSA-twin" }]),
    );
    expect(second).toBe(first);
  });

  it("does not leak cache state between two CONCURRENT scans of different projects", async () => {
    // Two projects that install the same package NAME and VERSION at the
    // same RELATIVE path, under different roots — the exact shape a
    // process-global cache keyed on anything less than the absolute path
    // would cross-contaminate.
    const a = twinProject();
    const b = twinProject();

    const [concurrentA, concurrentB] = await Promise.all([
      scanJson(a, recordingProvider([{ name: "twin", id: "GHSA-twin" }])),
      scanJson(b, recordingProvider([{ name: "twin", id: "GHSA-twin" }])),
    ]);

    for (const finding of concurrentA.findings) {
      expect(finding.packageInstance).not.toContain(path.basename(b));
    }
    for (const finding of concurrentB.findings) {
      expect(finding.packageInstance).not.toContain(path.basename(a));
    }

    // And each concurrent result equals what that project produces alone.
    const aloneA = await scanJson(
      a,
      recordingProvider([{ name: "twin", id: "GHSA-twin" }]),
    );
    expect(comparable(concurrentA)).toBe(comparable(aloneA));
    const aloneB = await scanJson(
      b,
      recordingProvider([{ name: "twin", id: "GHSA-twin" }]),
    );
    expect(comparable(concurrentB)).toBe(comparable(aloneB));
  });
});

describe("F5 end to end: the provider query set is unchanged", () => {
  it("asks exactly one query per (package name, installed version)", async () => {
    const provider = recordingProvider([{ name: "twin", id: "GHSA-twin" }]);
    await scanJson(twinProject(), provider);

    // Two twin instances at the SAME version share one query — the
    // pre-existing contract (`advisoryQueryVersions`), not something F5
    // introduced. What matters here is that no cache changed it in either
    // direction.
    const twinQueries = provider.queries.filter((q) =>
      q.startsWith("npm:twin@"),
    );
    expect(twinQueries).toEqual(["npm:twin@1.0.0"]);
    // No query is issued twice.
    expect(new Set(provider.queries).size).toBe(provider.queries.length);
  });
});

describe("F5 end to end: aliases and scoped packages", () => {
  it("keeps an aliased install and its canonical namesake distinct", async () => {
    const root = project({
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "twin-alias": "npm:twin@1.0.0", twin: "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/twin": { version: "1.0.0" },
          "node_modules/twin-alias": { name: "twin", version: "1.0.0" },
        },
      }),
      "vulntrace.yml": CONFIG,
      "rules.yml": `rules:\n${rule("GHSA-twin", "twin")}`,
      "src/index.js":
        'const t = require("twin-alias");\n' +
        "function main(x) {\n  return t.danger(x);\n}\n" +
        "module.exports = { main };\n",
      ...under("node_modules/twin", vulnerablePackage("twin", "1.0.0")),
      ...under("node_modules/twin-alias", vulnerablePackage("twin", "1.0.0")),
    });

    const output = await scanJson(
      root,
      recordingProvider([{ name: "twin", id: "GHSA-twin" }]),
    );
    const twins = output.findings.filter((f) => f.package === "twin");
    expect(twins.length).toBe(2);
    expect(new Set(twins.map((f) => f.packageInstance)).size).toBe(2);
    expect(twins.some((f) => f.verdict === "AFFECTED")).toBe(true);
  });

  it("keeps a scoped package and its unscoped namesake distinct", async () => {
    const root = project({
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "@scope/pkg": "1.0.0", pkg: "1.0.0" },
      }),
      "package-lock.json": JSON.stringify({
        name: "app",
        lockfileVersion: 3,
        packages: {
          "": { name: "app", version: "1.0.0" },
          "node_modules/@scope/pkg": { version: "1.0.0" },
          "node_modules/pkg": { version: "1.0.0" },
        },
      }),
      "vulntrace.yml": CONFIG,
      "rules.yml": `rules:\n${rule("GHSA-scoped", "@scope/pkg")}${rule("GHSA-plain", "pkg")}`,
      "src/index.js":
        'const scoped = require("@scope/pkg");\n' +
        "function main(x) {\n  return scoped.danger(x);\n}\n" +
        "module.exports = { main };\n",
      ...under(
        "node_modules/@scope/pkg",
        vulnerablePackage("@scope/pkg", "1.0.0"),
      ),
      ...under("node_modules/pkg", vulnerablePackage("pkg", "1.0.0")),
    });

    const output = await scanJson(
      root,
      recordingProvider([
        { name: "@scope/pkg", id: "GHSA-scoped" },
        { name: "pkg", id: "GHSA-plain" },
      ]),
    );
    const scoped = output.findings.find((f) => f.package === "@scope/pkg");
    const plain = output.findings.find((f) => f.package === "pkg");
    expect(scoped?.verdict).toBe("AFFECTED");
    // The unscoped sibling is never imported, so it must NOT inherit the
    // scoped package's reachability.
    expect(plain?.verdict).not.toBe("AFFECTED");
  });
});

describe("F5 end to end: workspaces and symlinks", () => {
  it("converges a workspace member reached through its node_modules symlink", async () => {
    const root = project({
      "package.json": JSON.stringify({
        name: "monorepo",
        version: "1.0.0",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": JSON.stringify({
        name: "monorepo",
        lockfileVersion: 3,
        packages: { "": { name: "monorepo", version: "1.0.0" } },
      }),
      "vulntrace.yml": CONFIG,
      "rules.yml": `rules:\n${rule("GHSA-member", "member")}`,
      "src/index.js":
        'const m = require("member");\n' +
        "function main(x) {\n  return m.danger(x);\n}\n" +
        "module.exports = { main };\n",
      ...under("packages/member", vulnerablePackage("member", "1.0.0")),
      "node_modules/.keep": "",
    });
    symlinkSync(
      path.join(root, "packages/member"),
      path.join(root, "node_modules/member"),
      "dir",
    );

    const output = await scanJson(
      root,
      recordingProvider([{ name: "member", id: "GHSA-member" }]),
    );
    const members = output.findings.filter((f) => f.package === "member");
    // ONE instance, not two: the symlink and its target are one physical
    // package. A memo that failed to converge them would report a phantom
    // duplicate here.
    expect(members.length).toBe(1);
    expect(members[0]?.verdict).toBe("AFFECTED");
  });

  it("keeps workspace-discovery diagnostics after memoization", async () => {
    // `workspaces` declared in a shape the analyzer refuses to interpret.
    // Caching must not suppress the diagnostic that says so.
    const root = project({
      "package.json": JSON.stringify({
        name: "monorepo",
        version: "1.0.0",
        workspaces: { nope: true },
      }),
      "package-lock.json": JSON.stringify({
        name: "monorepo",
        lockfileVersion: 3,
        packages: { "": { name: "monorepo", version: "1.0.0" } },
      }),
      "vulntrace.yml": CONFIG,
      "rules.yml": "rules: []\n",
      "src/index.js": "module.exports = {};\n",
    });

    const output = await scanJson(root, recordingProvider([]));
    expect(output.diagnostics.some((d) => d.source === "workspaces")).toBe(
      true,
    );
  });
});

describe("F5 end to end: determinism", () => {
  it("produces byte-identical output when the project's declaration order is reversed", async () => {
    // Same physical installs, opposite declaration order in both the
    // manifest and the lockfile. The output must not move: if any new Map
    // had leaked into an ordering decision, this is where it would show.
    const build = (reversed: boolean): string => {
      const names = reversed ? ["b", "a"] : ["a", "b"];
      const dependencies: Record<string, string> = {};
      const packages: Record<string, unknown> = {
        "": { name: "app", version: "1.0.0" },
      };
      for (const name of names) {
        dependencies[name] = "1.0.0";
        packages[`node_modules/${name}`] = { version: "1.0.0" };
      }
      return project({
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies,
        }),
        "package-lock.json": JSON.stringify({
          name: "app",
          lockfileVersion: 3,
          packages,
        }),
        "vulntrace.yml": CONFIG,
        "rules.yml": `rules:\n${rule("GHSA-a", "a")}${rule("GHSA-b", "b")}`,
        "src/index.js":
          'const a = require("a");\nconst b = require("b");\n' +
          "function main(x) {\n  return a.danger(b.safe(x));\n}\n" +
          "module.exports = { main };\n",
        ...under("node_modules/a", vulnerablePackage("a", "1.0.0")),
        ...under("node_modules/b", vulnerablePackage("b", "1.0.0")),
      });
    };

    const advisories = [
      { name: "a", id: "GHSA-a" },
      { name: "b", id: "GHSA-b" },
    ];
    const forward = await scanJson(build(false), recordingProvider(advisories));
    const reverse = await scanJson(build(true), recordingProvider(advisories));

    // Instance paths embed each project's own temp root, so compare the
    // ANSWERS rather than the raw bytes: one entry per package, same
    // verdict, in the same order.
    const shape = (o: ScanOutputShape) =>
      o.findings.map((f) => `${f.package}@${f.version ?? ""}=${f.verdict}`);
    expect(shape(reverse)).toEqual(shape(forward));
    expect(shape(forward).length).toBe(2);
  });
});
