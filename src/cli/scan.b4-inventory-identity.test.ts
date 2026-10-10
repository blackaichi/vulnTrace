import { execFileSync } from "node:child_process";
import {
  chmodSync,
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
import { validateScanOutput, type ScanOutput } from "./output.js";
import { runScanCommand } from "./scan.js";

/**
 * Task B-4 -- inventory and identity drops, end to end through a real scan.
 *
 * Four ways a package that is really installed, and here really loaded,
 * reached no finding and no `unreportedCandidates` entry:
 *
 *  - PRM-34: a `file:` dependency's lock entry, which real npm writes with
 *    no `name` (and, for a manifest with no version, with no `version`),
 *    was dropped by the dependency graph;
 *  - PRM-64: a versionless instance was never asked about by its own name,
 *    only through its siblings' version-filtered answers;
 *  - PRM-66: a workspace member whose manifest does not parse was dropped
 *    when nothing else named it with a version;
 *  - AUD-08: a package on disk that the lockfile does not list was never
 *    queried and never reported.
 *
 * The fixtures are loud: every library exports `danger` and `safe`, the
 * application calls `danger`, and the rule targets `danger`. A package the
 * scan considers reaches a finding; one it drops leaves a hole. Each case
 * also asks real `node` what it loads, so "really loaded" is measured, not
 * assumed.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

/** A library that prints which export ran, so `node` is the ground truth. */
const LIB_SOURCE =
  'function hit(n){ if (process.env.VT_B4_TRACE) console.log("CALLED " + n + " " + __dirname); }\n' +
  'function danger(x){ hit("danger"); return x; }\n' +
  'function safe(x){ hit("safe"); return x; }\n' +
  "module.exports = { danger, safe };\n";

function rules(...packages: string[]): string {
  return (
    "rules:\n" +
    packages
      .map(
        (name) =>
          `  - id: GHSA-b4-${name}\n` +
          `    package:\n` +
          `      name: ${name}\n` +
          `    targets:\n` +
          `      - module: ${name}\n` +
          `        export: danger\n` +
          `        kind: function\n` +
          `        confidence: 1.0\n`,
      )
      .join("")
  );
}

function app(...packages: string[]): string {
  return (
    packages
      .map(
        (name, index) =>
          `const lib${index} = require(${JSON.stringify(name)});\n`,
      )
      .join("") +
    "function main(input) {\n" +
    packages.map((_, index) => `  lib${index}.danger(input);\n`).join("") +
    "}\nmodule.exports = { main };\nif (require.main === module) main('x');\n"
  );
}

function lock(packages: Readonly<Record<string, unknown>>): string {
  return JSON.stringify({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages,
  });
}

/** Writes `files`, then `links` (link path -> target, both project-relative). */
function project(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
  base?: string,
): string {
  const root = base ?? mkdtempSync(path.join(os.tmpdir(), "vulntrace-b4-"));
  if (base === undefined) {
    dirs.push(root);
  }
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  for (const [linkPath, target] of Object.entries(links)) {
    const absolute = path.join(root, linkPath);
    mkdirSync(path.dirname(absolute), { recursive: true });
    symlinkSync(
      path.relative(path.dirname(absolute), path.join(root, target)),
      absolute,
      "dir",
    );
  }
  return root;
}

/** Which library directories real `node` runs `danger` from. */
function groundTruth(root: string): string[] {
  const out = execFileSync("node", ["src/index.js"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, VT_B4_TRACE: "1" },
  });
  return out
    .split("\n")
    .filter((line) => line.startsWith("CALLED danger "))
    .map((line) => line.slice("CALLED danger ".length));
}

/** An advisory for `name`, affected in [introduced, fixed). */
function advisory(
  id: string,
  name: string,
  introduced = "0",
  fixed = "99.0.0",
): RawVulnerability {
  return {
    id,
    affected: [
      {
        package: { ecosystem: "npm", name },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced }, { fixed }],
          },
        ],
      },
    ],
  } as unknown as RawVulnerability;
}

/**
 * A provider that behaves as OSV documents: a query with a version returns
 * only the advisories whose ranges contain that version (by major-minor-
 * patch, enough for these fixtures); a query without one returns every
 * advisory for the name.
 */
function osvLike(advisories: readonly RawVulnerability[]): {
  readonly provider: VulnerabilityProvider;
  readonly queries: string[];
} {
  const queries: string[] = [];
  const parse = (v: string): number[] => v.split(".").map(Number);
  const less = (a: string, b: string): boolean => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < 3; i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) {
        return (x[i] ?? 0) < (y[i] ?? 0);
      }
    }
    return false;
  };
  const provider: VulnerabilityProvider = {
    queryPackage(query: PackageQuery) {
      queries.push(`${query.name}@${query.version ?? "<none>"}`);
      const forName = advisories.filter((entry) =>
        (
          entry as unknown as { affected: { package: { name: string } }[] }
        ).affected.some((affected) => affected.package.name === query.name),
      );
      if (query.version === undefined) {
        return Promise.resolve(forName);
      }
      const version = query.version;
      return Promise.resolve(
        forName.filter((entry) => {
          const events = (
            entry as unknown as {
              affected: { ranges: { events: Record<string, string>[] }[] }[];
            }
          ).affected[0]!.ranges[0]!.events;
          const introduced = events[0]!.introduced!;
          const fixed = events[1]!.fixed!;
          return !less(version, introduced) && less(version, fixed);
        }),
      );
    },
  };
  return { provider, queries };
}

interface Entry {
  readonly stage: string;
  readonly disposition: string;
  readonly vulnerability?: string;
  readonly package?: string;
  readonly packageInstance?: string;
  readonly version?: string;
  readonly reason: string;
  readonly category?: string;
  readonly detail: string;
}

interface Output {
  readonly findings: {
    readonly vulnerability: string;
    readonly verdict: string;
    readonly packageInstance?: string;
    readonly version?: string;
    readonly unknownReasons?: readonly { readonly reason: string }[];
  }[];
  readonly unreportedCandidates: Entry[];
}

async function scan(
  root: string,
  provider: VulnerabilityProvider,
): Promise<{ readonly exit: number; readonly output: Output }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  });
  const text = stdout.join("");
  if (text === "") {
    throw new Error(`scan wrote no output (exit ${exit}): ${stderr.join("")}`);
  }
  const output = JSON.parse(text) as Output;
  // Every new entry must satisfy the published schema.
  expect(validateScanOutput(output as unknown as ScanOutput)).toEqual([]);
  return { exit, output };
}

const findingsFor = (output: Output, instance: string) =>
  output.findings.filter((finding) => finding.packageInstance === instance);

const entriesWith = (output: Output, reason: string): Entry[] =>
  output.unreportedCandidates.filter((entry) => entry.reason === reason);

describe("B-4 / PRM-34: a file: dependency's real npm lock entry is an instance", () => {
  /**
   * Exactly the lockfile npm 10.9.0 writes for `"lodash":
   * "file:vendor/lodash"` (measured in this task): the vendored entry has
   * a version and no name, because the directory's basename already
   * equals the manifest's name.
   */
  function vendored(): string {
    return project(
      {
        "vulntrace.yml": CONFIG,
        "rules.yml": rules("lodash"),
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { lodash: "file:vendor/lodash" },
        }),
        "package-lock.json": lock({
          "": {
            name: "app",
            version: "1.0.0",
            dependencies: { lodash: "file:vendor/lodash" },
          },
          "node_modules/lodash": { resolved: "vendor/lodash", link: true },
          "vendor/lodash": { version: "4.17.20" },
        }),
        "vendor/lodash/package.json": JSON.stringify({
          name: "lodash",
          version: "4.17.20",
          main: "index.js",
        }),
        "vendor/lodash/index.js": LIB_SOURCE,
        "src/index.js": app("lodash"),
      },
      { "node_modules/lodash": "vendor/lodash" },
    );
  }

  it("is queried and reaches an AFFECTED finding on its exact instance", async () => {
    const root = vendored();
    expect(groundTruth(root)).toEqual([
      expect.stringMatching(/vendor[/\\]lodash$/),
    ]);
    const { provider, queries } = osvLike([
      advisory("GHSA-b4-lodash", "lodash", "0", "4.17.21"),
    ]);

    const { output } = await scan(root, provider);

    expect(queries).toContain("lodash@4.17.20");
    expect(
      findingsFor(output, "vendor/lodash").map((finding) => [
        finding.vulnerability,
        finding.version,
        finding.verdict,
      ]),
    ).toEqual([["GHSA-b4-lodash", "4.17.20", "AFFECTED"]]);
  });

  it("control: the same lockfile with an explicit name", async () => {
    const root = vendored();
    writeFileSync(
      path.join(root, "package-lock.json"),
      lock({
        "": {
          name: "app",
          version: "1.0.0",
          dependencies: { lodash: "file:vendor/lodash" },
        },
        "node_modules/lodash": { resolved: "vendor/lodash", link: true },
        "vendor/lodash": { name: "lodash", version: "4.17.20" },
      }),
    );
    const { provider } = osvLike([
      advisory("GHSA-b4-lodash", "lodash", "0", "4.17.21"),
    ]);

    const { output } = await scan(root, provider);

    expect(
      findingsFor(output, "vendor/lodash").map((finding) => finding.verdict),
    ).toEqual(["AFFECTED"]);
  });

  it("a named, versionless file: entry is an instance with no version", async () => {
    // Measured with npm 10.9.0: a manifest with no "version" gives
    // `"vendor/nover": { "name": "nv" }`. Not a workspace member, so no
    // other authority names it.
    const root = project(
      {
        "vulntrace.yml": CONFIG,
        "rules.yml": rules("nv"),
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { nv: "file:vendor/nover" },
        }),
        "package-lock.json": lock({
          "": {
            name: "app",
            version: "1.0.0",
            dependencies: { nv: "file:vendor/nover" },
          },
          "node_modules/nv": { resolved: "vendor/nover", link: true },
          "vendor/nover": { name: "nv" },
        }),
        "vendor/nover/package.json": JSON.stringify({ name: "nv" }),
        "vendor/nover/index.js": LIB_SOURCE,
        "src/index.js": app("nv"),
      },
      { "node_modules/nv": "vendor/nover" },
    );
    expect(groundTruth(root)).toHaveLength(1);
    const { provider, queries } = osvLike([advisory("GHSA-b4-nv", "nv")]);

    const { output } = await scan(root, provider);

    expect(queries).toContain("nv@<none>");
    const findings = findingsFor(output, "vendor/nover");
    expect(findings.map((finding) => finding.verdict)).toEqual(["UNKNOWN"]);
    expect(findings[0]!.version).toBeUndefined();
    expect(findings[0]!.unknownReasons?.map((entry) => entry.reason)).toContain(
      "advisory_version_applicability_indeterminate",
    );
  });

  it("an entry no authority names is an identity entry, never silence", async () => {
    // No `name`, no linking `node_modules/<name>` entry, and a manifest
    // with no name: nothing establishes what package this is.
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": rules("anon"),
      "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
      "package-lock.json": lock({
        "": { name: "app", version: "1.0.0" },
        "vendor/anon": { version: "1.0.0" },
      }),
      "vendor/anon/package.json": JSON.stringify({ version: "1.0.0" }),
      "vendor/anon/index.js": LIB_SOURCE,
      "src/index.js": "module.exports = {};\n",
    });
    const { provider } = osvLike([]);

    const { output } = await scan(root, provider);

    const entries = entriesWith(output, "lockfile_entry_unidentified");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      stage: "package_identity",
      disposition: "undetermined",
      packageInstance: "vendor/anon",
      category: "identity_unresolved",
    });
    expect(entries[0]!.package).toBeUndefined();
  });

  it("two linking names that disagree, with no manifest name, are not guessed between", async () => {
    const root = project(
      {
        "vulntrace.yml": CONFIG,
        "rules.yml": rules("left", "right"),
        "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
        "package-lock.json": lock({
          "": { name: "app", version: "1.0.0" },
          "node_modules/left": { resolved: "vendor/both", link: true },
          "node_modules/right": { resolved: "vendor/both", link: true },
          "vendor/both": { version: "1.0.0" },
        }),
        "vendor/both/package.json": JSON.stringify({ version: "1.0.0" }),
        "vendor/both/index.js": LIB_SOURCE,
        "src/index.js": "module.exports = {};\n",
      },
      {
        "node_modules/left": "vendor/both",
        "node_modules/right": "vendor/both",
      },
    );
    const { provider } = osvLike([]);

    const { output } = await scan(root, provider);

    expect(
      entriesWith(output, "lockfile_entry_unidentified").map(
        (entry) => entry.packageInstance,
      ),
    ).toEqual(["vendor/both"]);
  });
});

describe("B-4 / PRM-64: a versionless instance is asked about by its own name", () => {
  /**
   * The round-2 audit's fixture: workspace member `packages/foo` declares
   * no version; `bar` depends on a nested, versioned `foo@1.0.0`.
   * GHSA-x affects foo < 2.0.0, GHSA-y affects foo 3.0.x: OSV's versioned
   * query for 1.0.0 returns only GHSA-x.
   */
  function monorepo(): string {
    return project(
      {
        "vulntrace.yml": CONFIG,
        "rules.yml": rules("foo"),
        "package.json": JSON.stringify({
          name: "root",
          private: true,
          workspaces: ["packages/*"],
        }),
        "package-lock.json": lock({
          "": { name: "root", workspaces: ["packages/*"] },
          "node_modules/app": { resolved: "packages/app", link: true },
          "node_modules/foo": { resolved: "packages/foo", link: true },
          "node_modules/bar": {
            version: "1.0.0",
            dependencies: { foo: "1.0.0" },
          },
          "node_modules/bar/node_modules/foo": { version: "1.0.0" },
          "packages/app": {
            version: "1.0.0",
            dependencies: { bar: "1.0.0" },
          },
          "packages/foo": {},
        }),
        "packages/foo/package.json": JSON.stringify({ name: "foo" }),
        "packages/foo/index.js": LIB_SOURCE,
        "packages/app/package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          dependencies: { bar: "1.0.0" },
        }),
        "node_modules/bar/package.json": JSON.stringify({
          name: "bar",
          version: "1.0.0",
        }),
        "node_modules/bar/index.js":
          'const foo = require("foo");\nmodule.exports = { run(x){ return foo.danger(x); } };\n',
        "node_modules/bar/node_modules/foo/package.json": JSON.stringify({
          name: "foo",
          version: "1.0.0",
        }),
        "node_modules/bar/node_modules/foo/index.js": LIB_SOURCE,
        "src/index.js": app("foo"),
      },
      {
        "node_modules/foo": "packages/foo",
        "node_modules/app": "packages/app",
      },
    );
  }

  const ADVISORIES = [
    advisory("GHSA-x", "foo", "0", "2.0.0"),
    advisory("GHSA-y", "foo", "3.0.0", "3.1.0"),
  ];

  it("is queried without a version and evaluated against every advisory returned", async () => {
    const root = monorepo();
    expect(groundTruth(root)).toEqual([
      expect.stringMatching(/packages[/\\]foo$/),
    ]);
    const { provider, queries } = osvLike(ADVISORIES);

    const { output } = await scan(root, provider);

    expect(queries).toEqual(
      expect.arrayContaining(["foo@1.0.0", "foo@<none>"]),
    );
    expect(
      findingsFor(output, "packages/foo")
        .map((finding) => [finding.vulnerability, finding.verdict])
        .sort(),
    ).toEqual([
      ["GHSA-x", "UNKNOWN"],
      ["GHSA-y", "UNKNOWN"],
    ]);
  });

  it("the versioned sibling keeps its own applicability: GHSA-y does not apply to 1.0.0", async () => {
    const { provider } = osvLike(ADVISORIES);

    const { output } = await scan(monorepo(), provider);

    const nested = "node_modules/bar/node_modules/foo";
    expect(
      findingsFor(output, nested).map((finding) => finding.vulnerability),
    ).toEqual(["GHSA-x"]);
    expect(
      entriesWith(output, "advisory_not_applicable_to_installed_version")
        .filter((entry) => entry.packageInstance === nested)
        .map((entry) => entry.vulnerability),
    ).toEqual(["GHSA-y"]);
  });
});

describe("B-4 / PRM-66: a malformed workspace manifest is recorded even when versionless", () => {
  function malformed(variant: "versioned-lock" | "versionless-lock"): string {
    return project(
      {
        "vulntrace.yml": CONFIG,
        "rules.yml": rules("bad"),
        "package.json": JSON.stringify({
          name: "app",
          version: "1.0.0",
          workspaces: ["packages/*"],
        }),
        "package-lock.json": lock({
          "": { name: "app", version: "1.0.0", workspaces: ["packages/*"] },
          "node_modules/bad": { resolved: "packages/bad", link: true },
          "packages/bad":
            variant === "versioned-lock"
              ? { name: "bad", version: "1.0.0" }
              : {},
        }),
        "packages/bad/package.json": '{"name": "bad", "version": "1.0.0",\n',
        "packages/bad/index.js": LIB_SOURCE,
        "src/index.js":
          'const b = require("../packages/bad/index.js");\nb.danger("x");\n',
      },
      { "node_modules/bad": "packages/bad" },
    );
  }

  for (const variant of ["versioned-lock", "versionless-lock"] as const) {
    it(`${variant}: one installed_manifest_untrusted entry naming the instance`, async () => {
      const { provider } = osvLike([advisory("GHSA-b4-bad", "bad")]);

      const { output } = await scan(malformed(variant), provider);

      expect(
        entriesWith(output, "installed_manifest_untrusted").map((entry) => [
          entry.package,
          entry.packageInstance,
        ]),
      ).toEqual([["bad", "packages/bad"]]);
      expect(
        findingsFor(output, "packages/bad").map((finding) => finding.verdict),
      ).toEqual(["UNKNOWN"]);
    });
  }

  it("a malformed manifest that only a workspace pattern covers is recorded", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": rules("bad"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": lock({
        "": { name: "app", version: "1.0.0", workspaces: ["packages/*"] },
      }),
      "packages/bad/package.json": "{ not json",
      "packages/bad/index.js": LIB_SOURCE,
      "src/index.js": "module.exports = {};\n",
    });
    const { provider } = osvLike([]);

    const { output } = await scan(root, provider);

    const entries = entriesWith(output, "installed_manifest_untrusted");
    expect(entries.map((entry) => entry.packageInstance)).toEqual([
      "packages/bad",
    ]);
    expect(entries[0]).toMatchObject({
      stage: "package_identity",
      disposition: "undetermined",
      category: "identity_unresolved",
    });
  });

  it("control: a workspace directory with no manifest at all is not a package", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": rules("bad"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": lock({
        "": { name: "app", version: "1.0.0", workspaces: ["packages/*"] },
      }),
      "packages/notes/README.md": "not a package\n",
      "src/index.js": "module.exports = {};\n",
    });
    const { provider } = osvLike([]);

    const { output } = await scan(root, provider);

    expect(output.unreportedCandidates).toEqual([]);
  });
});

describe("B-4 / AUD-08: an installed package the lockfile does not list is reported", () => {
  function base(
    lockPackages: Readonly<Record<string, unknown>>,
    files: Readonly<Record<string, string>>,
    requires: readonly string[],
  ): string {
    return project({
      "vulntrace.yml": CONFIG,
      "rules.yml": rules("vuln-lib"),
      "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
      "package-lock.json": lock({
        "": { name: "app", version: "1.0.0" },
        ...lockPackages,
      }),
      "src/index.js": app(...requires),
      ...files,
    });
  }

  it("a hoisted package on disk and loaded, absent from the lockfile", async () => {
    const root = base(
      {},
      {
        "node_modules/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "1.0.0",
        }),
        "node_modules/vuln-lib/index.js": LIB_SOURCE,
      },
      ["vuln-lib"],
    );
    expect(groundTruth(root)).toHaveLength(1);
    const { provider } = osvLike([advisory("GHSA-b4-vuln-lib", "vuln-lib")]);

    const { output } = await scan(root, provider);

    const entries = entriesWith(output, "installed_package_not_in_lockfile");
    expect(
      entries.map((entry) => [entry.package, entry.packageInstance]),
    ).toEqual([["vuln-lib", "node_modules/vuln-lib"]]);
    expect(entries[0]).toMatchObject({
      stage: "package_identity",
      disposition: "undetermined",
      category: "identity_unresolved",
    });
  });

  function shadowed(nestedVersion: string): string {
    // The lockfile lists a hoisted vuln-lib@1.0.1 and host@1.0.0; on disk
    // a nested host/node_modules/vuln-lib exists too, and Node runs IT.
    return base(
      {
        "node_modules/host": { version: "1.0.0" },
        "node_modules/vuln-lib": { version: "1.0.1" },
      },
      {
        "node_modules/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "1.0.1",
        }),
        "node_modules/vuln-lib/index.js": LIB_SOURCE,
        "node_modules/host/package.json": JSON.stringify({
          name: "host",
          version: "1.0.0",
        }),
        "node_modules/host/index.js":
          'const lib = require("vuln-lib");\nmodule.exports = { danger(x){ return lib.danger(x); }, safe(x){ return x; } };\n',
        "node_modules/host/node_modules/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: nestedVersion,
        }),
        "node_modules/host/node_modules/vuln-lib/index.js": LIB_SOURCE,
      },
      ["host"],
    );
  }

  it("a nested on-disk-only copy shadowing a listed hoisted one", async () => {
    const root = shadowed("1.0.0");
    expect(groundTruth(root)).toEqual([
      expect.stringMatching(/host[/\\]node_modules[/\\]vuln-lib$/),
    ]);
    const { provider } = osvLike([
      advisory("GHSA-b4-vuln-lib", "vuln-lib", "0", "1.0.1"),
    ]);

    const { output } = await scan(root, provider);

    expect(
      entriesWith(output, "installed_package_not_in_lockfile").map(
        (entry) => entry.packageInstance,
      ),
    ).toEqual(["node_modules/host/node_modules/vuln-lib"]);
  });

  it("sibling borrow: a nested copy with the listed copy's own name AND version is still its own instance", async () => {
    // Same name, same version, different directory: two instances. An
    // inventory keyed by name@version would call the nested one listed.
    const { provider } = osvLike([]);

    const { output } = await scan(shadowed("1.0.1"), provider);

    expect(
      entriesWith(output, "installed_package_not_in_lockfile").map(
        (entry) => entry.packageInstance,
      ),
    ).toEqual(["node_modules/host/node_modules/vuln-lib"]);
  });

  it("sibling borrow, walk only: an unloaded nested twin of a listed copy is still its own instance", async () => {
    // As above, but nothing loads `host`, so the module-load closure never
    // sees the nested copy: only the installed-tree cross-check can report
    // it, and only by its own canonical root.
    const root = shadowed("1.0.1");
    writeFileSync(path.join(root, "src", "index.js"), "module.exports = {};\n");
    const { provider } = osvLike([]);

    const { output } = await scan(root, provider);

    expect(
      entriesWith(output, "installed_package_not_in_lockfile").map(
        (entry) => entry.packageInstance,
      ),
    ).toEqual(["node_modules/host/node_modules/vuln-lib"]);
  });

  it("a package the closure loads from an ancestor node_modules outside the project", async () => {
    const outer = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b4-outer-"));
    dirs.push(outer);
    project(
      {
        "node_modules/outside-lib/package.json": JSON.stringify({
          name: "outside-lib",
          version: "1.0.0",
        }),
        "node_modules/outside-lib/index.js": LIB_SOURCE,
      },
      {},
      outer,
    );
    const root = project(
      {
        "vulntrace.yml": CONFIG,
        "rules.yml": rules("outside-lib"),
        "package.json": JSON.stringify({ name: "app", version: "1.0.0" }),
        "package-lock.json": lock({ "": { name: "app", version: "1.0.0" } }),
        "src/index.js": app("outside-lib"),
      },
      {},
      path.join(outer, "app"),
    );
    expect(groundTruth(root)).toEqual([expect.stringContaining("outside-lib")]);
    const { provider } = osvLike([]);

    const { output } = await scan(root, provider);

    const entries = entriesWith(output, "installed_package_not_in_lockfile");
    expect(entries.map((entry) => entry.package)).toEqual(["outside-lib"]);
    expect(entries[0]!.packageInstance).toMatch(
      /node_modules[/\\]outside-lib$/,
    );
  });

  it("control: a lockfile that lists everything on disk adds no entry", async () => {
    const root = base(
      { "node_modules/vuln-lib": { version: "1.0.0" } },
      {
        "node_modules/vuln-lib/package.json": JSON.stringify({
          name: "vuln-lib",
          version: "1.0.0",
        }),
        "node_modules/vuln-lib/index.js": LIB_SOURCE,
        "node_modules/.package-lock.json": "{}",
        "node_modules/.bin/tool": "#!/bin/sh\n",
      },
      ["vuln-lib"],
    );
    const { provider } = osvLike([]);

    const { output } = await scan(root, provider);

    expect(entriesWith(output, "installed_package_not_in_lockfile")).toEqual(
      [],
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "a node_modules the scan cannot read is reported, never read as empty (audit finding 1)",
    async () => {
      // The audit's reproduction: the package is loaded through a computed
      // specifier the closure cannot follow, and node_modules is
      // executable but not readable, so Node still loads it.
      const root = base(
        { "node_modules/lib": { version: "1.0.0" } },
        {
          "node_modules/lib/package.json": JSON.stringify({
            name: "lib",
            version: "1.0.0",
          }),
          "node_modules/lib/index.js": LIB_SOURCE,
          "node_modules/unlisted/package.json": JSON.stringify({
            name: "unlisted",
            version: "1.0.0",
          }),
          "node_modules/unlisted/index.js": LIB_SOURCE,
        },
        [],
      );
      writeFileSync(
        path.join(root, "src", "index.js"),
        'const n = ["un", "listed"].join("");\nrequire(n).danger("x");\n',
      );
      const nodeModules = path.join(root, "node_modules");
      chmodSync(nodeModules, 0o311);
      try {
        expect(groundTruth(root)).toHaveLength(1);
        const { provider } = osvLike([]);

        const { output } = await scan(root, provider);

        const entries = entriesWith(output, "installed_tree_unreadable");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          stage: "workspace_discovery",
          disposition: "undetermined",
          category: "analysis_precondition_unmet",
        });
        expect(entries[0]!.detail).toContain("node_modules");
      } finally {
        chmodSync(nodeModules, 0o755);
      }
    },
  );

  it("a scoped package absent from the lockfile is reported by its scoped name", async () => {
    const root = base(
      {},
      {
        "node_modules/@scope/lib/package.json": JSON.stringify({
          name: "@scope/lib",
          version: "1.0.0",
        }),
        "node_modules/@scope/lib/index.js": LIB_SOURCE,
      },
      [],
    );
    const { provider } = osvLike([]);

    const { output } = await scan(root, provider);

    expect(
      entriesWith(output, "installed_package_not_in_lockfile").map((entry) => [
        entry.package,
        entry.packageInstance,
      ]),
    ).toEqual([["@scope/lib", "node_modules/@scope/lib"]]);
  });
});
