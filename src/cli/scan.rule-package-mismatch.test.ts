import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * TASK B-6 -- AUD-15: A RULE BELONGS TO ONE PACKAGE, AN ADVISORY MAY
 * AFFECT SEVERAL.
 *
 * `findRuleForVulnerability` selects a rule by advisory id, so the rule of
 * an advisory that affects two packages is attached to both findings. Its
 * `package.name` was never read: the other package's targets were resolved
 * against the other package's own instance, failed, and the finding said
 * something false about resolution. For a package the app loads the verdict
 * was already `UNKNOWN` and stays `UNKNOWN`; what changes is that its reason
 * names the mismatch. For a package the app never loads, the base answered
 * a family-A `NOT_AFFECTED` and this answers `UNKNOWN` (a precision loss,
 * the same as the no-rule branch's; see the "never loads" case).
 *
 * Fixtures export every name their cases bind (`danger` AND `safe` in both
 * packages), so a fabricated attribution would resolve loudly to a wrong
 * target instead of degrading quietly to `UNKNOWN`.
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
  readonly verdict: string;
  readonly unknownReasons?: readonly { category: string; reason: string }[];
  readonly evidence?: { readonly reasons: readonly string[] };
}

interface ScanOutputShape {
  readonly findings: ScanFinding[];
}

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

const LIB_SOURCE =
  "function danger(input) {\n  return input;\n}\n" +
  "function safe(input) {\n  return input;\n}\n" +
  "module.exports = { danger, safe };\n";

/** An advisory over `0 <= v < 1.5.0` affecting every named package. */
function advisory(id: string, names: readonly string[]): RawVulnerability {
  return {
    id,
    aliases: [],
    affected: names.map((name) => ({
      package: { ecosystem: "npm", name },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.5.0" }] },
      ],
    })),
    references: [],
  };
}

function providerFor(raw: RawVulnerability): VulnerabilityProvider {
  return {
    queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
      const names = (
        raw as { affected: { package: { name: string } }[] }
      ).affected.map((entry) => entry.package.name);
      return Promise.resolve(names.includes(query.name) ? [raw] : []);
    },
  };
}

function rule(id: string, packageName: string, moduleName: string): string {
  return (
    `rules:\n  - id: ${id}\n` +
    `    package:\n      name: ${JSON.stringify(packageName)}\n` +
    `    targets:\n` +
    `      - module: ${JSON.stringify(moduleName)}\n` +
    `        export: danger\n        kind: function\n        confidence: 1.0\n`
  );
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b6-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

function installed(name: string, dir = name): Record<string, string> {
  return {
    [`node_modules/${dir}/package.json`]: JSON.stringify({
      name,
      version: "1.0.0",
      main: "index.js",
    }),
    [`node_modules/${dir}/index.js`]: LIB_SOURCE,
  };
}

function lock(dirs_: readonly string[]): string {
  return JSON.stringify({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { name: "app", version: "1.0.0" },
      ...Object.fromEntries(
        dirs_.map((dir) => [`node_modules/${dir}`, { version: "1.0.0" }]),
      ),
    },
  });
}

async function scan(
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

function finding(output: ScanOutputShape, name: string): ScanFinding {
  const found = output.findings.filter((f) => f.package === name);
  expect(found).toHaveLength(1);
  return found[0]!;
}

/** Two packages, one advisory, a rule that names only `vuln-lib`. */
function twoPackageProject(appSource: string): string {
  return project({
    "vulntrace.yml": CONFIG,
    "rules.yml": rule("GHSA-b6-m", "vuln-lib", "vuln-lib"),
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { "vuln-lib": "1.0.0", "other-lib": "1.0.0" },
    }),
    "package-lock.json": lock(["vuln-lib", "other-lib"]),
    "src/index.js": appSource,
    ...installed("vuln-lib"),
    ...installed("other-lib"),
  });
}

const ADVISORY = advisory("GHSA-b6-m", ["vuln-lib", "other-lib"]);

describe("B-6 / AUD-15: a rule applies only to the package it names", () => {
  const app =
    'const v = require("vuln-lib");\nconst o = require("other-lib");\n' +
    "function main(x) {\n  v.safe(x);\n  return o.danger(x);\n}\n" +
    "module.exports = { main };\n";

  it("the package the rule does not name is UNKNOWN, with a reason that names the mismatch", async () => {
    const output = await scan(twoPackageProject(app), providerFor(ADVISORY));
    const other = finding(output, "other-lib");

    expect(other.verdict).toBe("UNKNOWN");
    expect(other.unknownReasons?.map((r) => r.reason)).toEqual([
      "rule_package_mismatch",
    ]);
    expect(other.unknownReasons?.map((r) => r.category)).toEqual([
      "analysis_precondition_unmet",
    ]);
    // The prose names both packages and does not blame resolution.
    const prose = (other.evidence?.reasons ?? []).join("\n");
    expect(prose).toContain("vuln-lib");
    expect(prose).toContain("other-lib");
    expect(prose).not.toContain("could not resolve");
    expect(prose).not.toContain("never traversed");
  });

  it("a package the app never loads is UNKNOWN too (a documented precision loss, fail closed)", async () => {
    // The base proved this `other-lib` absent from the module-load closure
    // (family A, NOT_AFFECTED). The mismatch is decided before any
    // instance matching, as the no-rule branch is, so it is UNKNOWN now;
    // restoring the proof is precision work, not a soundness repair.
    const output = await scan(
      twoPackageProject(
        'const v = require("vuln-lib");\nfunction main(x) {\n  return v.safe(x);\n}\nmodule.exports = { main };\n',
      ),
      providerFor(ADVISORY),
    );

    expect(finding(output, "other-lib").verdict).toBe("UNKNOWN");
    expect(
      finding(output, "other-lib").unknownReasons?.map((r) => r.reason),
    ).toEqual(["rule_package_mismatch"]);
  });

  it("control: the package the rule names keeps its verdict", async () => {
    const output = await scan(twoPackageProject(app), providerFor(ADVISORY));

    // `danger` of vuln-lib is not called; `safe` is.
    expect(finding(output, "vuln-lib").verdict).toBe("NOT_AFFECTED");
  });

  it("control: the package the rule names is AFFECTED when its target is called", async () => {
    const output = await scan(
      twoPackageProject(
        'const v = require("vuln-lib");\nconst o = require("other-lib");\n' +
          "function main(x) {\n  o.safe(x);\n  return v.danger(x);\n}\n" +
          "module.exports = { main };\n",
      ),
      providerFor(ADVISORY),
    );

    expect(finding(output, "vuln-lib").verdict).toBe("AFFECTED");
    expect(finding(output, "other-lib").verdict).toBe("UNKNOWN");
  });

  it("a name that differs only by case is a different package", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": rule("GHSA-b6-c", "Vuln-Lib", "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": lock(["vuln-lib"]),
      "src/index.js":
        'const v = require("vuln-lib");\nfunction main(x) {\n  return v.danger(x);\n}\nmodule.exports = { main };\n',
      ...installed("vuln-lib"),
    });
    const output = await scan(
      root,
      providerFor(advisory("GHSA-b6-c", ["vuln-lib"])),
    );

    expect(finding(output, "vuln-lib").verdict).toBe("UNKNOWN");
    expect(
      finding(output, "vuln-lib").unknownReasons?.map((r) => r.reason),
    ).toEqual(["rule_package_mismatch"]);
  });
});

describe("B-6: the mismatch check does not reject a rule that does name the package", () => {
  it("an npm alias is the package it actually is", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": rule("GHSA-b6-a", "vuln-lib", "vuln-alias"),
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
        'const v = require("vuln-alias");\nfunction main(x) {\n  return v.danger(x);\n}\nmodule.exports = { main };\n',
      ...installed("vuln-lib", "vuln-alias"),
    });
    const output = await scan(
      root,
      providerFor(advisory("GHSA-b6-a", ["vuln-lib"])),
    );

    expect(finding(output, "vuln-lib").verdict).toBe("AFFECTED");
  });

  it("a scoped package", async () => {
    const root = project({
      "vulntrace.yml": CONFIG,
      "rules.yml": rule("GHSA-b6-s", "@scope/vuln-lib", "@scope/vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "@scope/vuln-lib": "1.0.0" },
      }),
      "package-lock.json": lock(["@scope/vuln-lib"]),
      "src/index.js":
        'const v = require("@scope/vuln-lib");\nfunction main(x) {\n  return v.danger(x);\n}\nmodule.exports = { main };\n',
      ...installed("@scope/vuln-lib"),
    });
    const output = await scan(
      root,
      providerFor(advisory("GHSA-b6-s", ["@scope/vuln-lib"])),
    );

    expect(finding(output, "@scope/vuln-lib").verdict).toBe("AFFECTED");
  });
});
