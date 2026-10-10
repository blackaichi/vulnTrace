import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OsvProvider } from "../vulnerabilities/osv-provider.js";
import { validateScanOutput } from "./output.js";
import { runScanCommand } from "./scan.js";

/**
 * Task B-2 -- version applicability, end to end through a real scan.
 *
 * An advisory whose ranges are read wrongly is declared out of range
 * (`not_applicable`) for an installed version that is inside it: no
 * finding, and an entry that says the advisory does not apply -- a silent
 * drop. Three ways it happened:
 *
 *  - AUD-05: `semver.coerce` stripped prereleases, so `2.0.0-rc.1` read as
 *    `2.0.0`, outside `fixed: 2.0.0` (and, the other way, `1.5.0-beta.3`
 *    read as inside `last_affected: 1.5.0-beta.2`);
 *  - AUD-09: a GIT range's commit hash was coerced into a semver, and an
 *    `affected` entry with no ranges and no versions read as "no version
 *    affected";
 *  - RWF-091 (found by B-2): OSV events were paired in array order, while
 *    OSV's specification sorts them before evaluating.
 *
 * Every test runs the REAL `OsvProvider` over a stubbed `fetch`. The
 * fixture is loud: `vuln-lib` exports `danger`, the export every rule
 * targets, and the application calls it, so every advisory that reaches
 * the verdict layer as applicable is AFFECTED, and one whose applicability
 * cannot be decided is UNKNOWN with the applicability reason. An advisory
 * wrongly declared out of range is a missing finding.
 */

const dirs: string[] = [];

afterAll(() => {
  for (const dir of dirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const CONFIG =
  "analysis:\n  entrypoints:\n    - src/index.js\nrules:\n  files:\n    - rules.yml\n";

const LIB_SOURCE =
  "function danger(x){ return x; }\n" +
  "function safe(x){ return x; }\n" +
  "module.exports = { danger, safe };\n";

const ADVISORY_ID = "GHSA-b2-range";

const RULES =
  "rules:\n" +
  `  - id: ${ADVISORY_ID}\n` +
  `    package:\n` +
  `      name: vuln-lib\n` +
  `    targets:\n` +
  `      - module: vuln-lib\n` +
  `        export: danger\n` +
  `        kind: function\n` +
  `        confidence: 1.0\n`;

/** One OSV record for `vuln-lib`, with the given `affected[0]` body. */
function advisory(affected: Readonly<Record<string, unknown>>) {
  return {
    id: ADVISORY_ID,
    affected: [
      { package: { ecosystem: "npm", name: "vuln-lib" }, ...affected },
    ],
  };
}

function semverRange(events: readonly Record<string, string>[]) {
  return advisory({ ranges: [{ type: "SEMVER", events }] });
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b2-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

/**
 * An installed `vuln-lib@<version>`, called through `danger`. With
 * `nestedVersion`, a second exact instance under `host`, at that version,
 * is called too: each instance's applicability is its own.
 */
function projectWithLib(version: string, nestedVersion?: string): string {
  const twin = nestedVersion !== undefined;
  const dependencies: Record<string, string> = {
    "vuln-lib": version,
    ...(twin ? { host: "1.0.0" } : {}),
  };
  return project({
    "vulntrace.yml": CONFIG,
    "rules.yml": RULES,
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies,
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { name: "app", version: "1.0.0", dependencies },
        "node_modules/vuln-lib": { version },
        ...(twin
          ? {
              "node_modules/host": { version: "1.0.0" },
              "node_modules/host/node_modules/vuln-lib": {
                version: nestedVersion,
              },
            }
          : {}),
      },
    }),
    "src/index.js":
      'const lib = require("vuln-lib");\n' +
      (twin ? 'const host = require("host");\n' : "") +
      "function main(input) {\n" +
      (twin ? "  host.run(input);\n" : "") +
      "  return lib.danger(input);\n}\n" +
      "module.exports = { main };\n",
    "node_modules/vuln-lib/package.json": JSON.stringify({
      name: "vuln-lib",
      version,
    }),
    "node_modules/vuln-lib/index.js": LIB_SOURCE,
    ...(twin
      ? {
          "node_modules/host/package.json": JSON.stringify({
            name: "host",
            version: "1.0.0",
          }),
          "node_modules/host/index.js":
            'const lib = require("vuln-lib");\n' +
            "function run(x){ return lib.danger(x); }\n" +
            "module.exports = { run };\n",
          "node_modules/host/node_modules/vuln-lib/package.json":
            JSON.stringify({ name: "vuln-lib", version: nestedVersion }),
          "node_modules/host/node_modules/vuln-lib/index.js": LIB_SOURCE,
        }
      : {}),
  });
}

/** A stubbed OSV answering `vuln-lib`'s query with `records`, through the real provider. */
function osv(records: readonly unknown[]): OsvProvider {
  const fetchImpl = (async (_url, init) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    const name = (body.package as { name: string }).name;
    return new Response(
      JSON.stringify({ vulns: name === "vuln-lib" ? records : [] }),
      { status: 200 },
    );
  }) as typeof fetch;
  return new OsvProvider({ fetchImpl });
}

interface Finding {
  readonly vulnerability: string;
  readonly verdict: string;
  readonly packageInstance?: string;
  readonly unknownReasons?: readonly { readonly reason: string }[];
}

interface Entry {
  readonly disposition: string;
  readonly vulnerability?: string;
  readonly packageInstance?: string;
  readonly version?: string;
  readonly reason: string;
  readonly category?: string;
}

interface Output {
  readonly findings: readonly Finding[];
  readonly unreportedCandidates: readonly Entry[];
}

async function scan(
  root: string,
  records: readonly unknown[],
): Promise<{ readonly exit: number; readonly output: Output }> {
  const stdout: string[] = [];
  const exit = await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider: osv(records),
    noCache: true,
    io: { stdout: (text) => stdout.push(text), stderr: () => undefined },
  });
  const parsed: unknown = JSON.parse(stdout.join(""));
  expect(validateScanOutput(parsed)).toEqual([]);
  return { exit, output: parsed as Output };
}

/** Each exact instance's outcome for the one advisory: a verdict, or the entry's disposition. */
function outcomes(output: Output): Record<string, string> {
  const byInstance: Record<string, string> = {};
  for (const finding of output.findings) {
    expect(finding.vulnerability).toBe(ADVISORY_ID);
    byInstance[finding.packageInstance ?? "?"] = finding.verdict;
  }
  for (const entry of output.unreportedCandidates) {
    if (entry.vulnerability === ADVISORY_ID) {
      byInstance[entry.packageInstance ?? "?"] = entry.disposition;
    }
  }
  return byInstance;
}

const HOISTED = "node_modules/vuln-lib";
const NESTED = "node_modules/host/node_modules/vuln-lib";

/** The one `UNKNOWN` an undecidable range must produce, with its reason. */
function expectApplicabilityUnknown(output: Output): void {
  expect(outcomes(output)).toEqual({ [HOISTED]: "UNKNOWN" });
  expect(output.findings[0]?.unknownReasons?.map((r) => r.reason)).toEqual([
    "advisory_version_applicability_indeterminate",
  ]);
  expect(
    output.unreportedCandidates.filter(
      (entry) => entry.disposition === "not_applicable",
    ),
  ).toEqual([]);
}

describe("B-2 / AUD-05: prerelease precedence, never coerced", () => {
  it("an installed prerelease below `fixed` is a finding", async () => {
    const { exit, output } = await scan(projectWithLib("2.0.0-rc.1"), [
      semverRange([{ introduced: "0" }, { fixed: "2.0.0" }]),
    ]);

    expect(exit).toBe(1);
    expect(outcomes(output)).toEqual({ [HOISTED]: "AFFECTED" });
  });

  it("an installed prerelease below a prerelease `fixed` is a finding", async () => {
    const { output } = await scan(projectWithLib("2.0.0-rc.1"), [
      semverRange([{ introduced: "0" }, { fixed: "2.0.0-rc.2" }]),
    ]);

    expect(outcomes(output)).toEqual({ [HOISTED]: "AFFECTED" });
  });

  it("an installed prerelease above a prerelease `last_affected` is not applicable", async () => {
    const { exit, output } = await scan(projectWithLib("1.5.0-beta.3"), [
      semverRange([{ introduced: "0" }, { last_affected: "1.5.0-beta.2" }]),
    ]);

    expect(exit).toBe(0);
    expect(outcomes(output)).toEqual({ [HOISTED]: "not_applicable" });
  });

  it("control: the release itself is the first fixed version", async () => {
    const { output } = await scan(projectWithLib("2.0.0"), [
      semverRange([{ introduced: "0" }, { fixed: "2.0.0" }]),
    ]);

    expect(outcomes(output)).toEqual({ [HOISTED]: "not_applicable" });
  });

  it("each exact instance is evaluated against its own version, never a sibling's", async () => {
    const { output } = await scan(projectWithLib("2.0.0-rc.1", "2.0.0"), [
      semverRange([{ introduced: "0" }, { fixed: "2.0.0" }]),
    ]);

    expect(outcomes(output)).toEqual({
      [HOISTED]: "AFFECTED",
      [NESTED]: "not_applicable",
    });
    expect(
      output.unreportedCandidates.find(
        (entry) => entry.packageInstance === NESTED,
      )?.version,
    ).toBe("2.0.0");
  });

  it("each exact instance is evaluated against its own version (mirrored)", async () => {
    const { output } = await scan(projectWithLib("2.0.0", "2.0.0-rc.1"), [
      semverRange([{ introduced: "0" }, { fixed: "2.0.0" }]),
    ]);

    expect(outcomes(output)).toEqual({
      [HOISTED]: "not_applicable",
      [NESTED]: "AFFECTED",
    });
  });
});

describe("B-2 / AUD-09: a range VulnTrace cannot order is undecided, never out of range", () => {
  it("a GIT range is UNKNOWN, not coerced into a semver", async () => {
    const { exit, output } = await scan(projectWithLib("5.0.0"), [
      advisory({
        ranges: [
          {
            type: "GIT",
            repo: "https://example.invalid/vuln-lib",
            events: [{ introduced: "0" }, { fixed: "3f2a9c1b0d" }],
          },
        ],
      }),
    ]);

    expect(exit).toBe(0);
    expectApplicabilityUnknown(output);
  });

  it("an affected entry with no ranges and no versions is UNKNOWN", async () => {
    const { output } = await scan(projectWithLib("5.0.0"), [advisory({})]);

    expectApplicabilityUnknown(output);
  });

  it("an ECOSYSTEM range is UNKNOWN", async () => {
    const { output } = await scan(projectWithLib("5.0.0"), [
      advisory({
        ranges: [
          {
            type: "ECOSYSTEM",
            events: [{ introduced: "0" }, { fixed: "4.0.0" }],
          },
        ],
      }),
    ]);

    expectApplicabilityUnknown(output);
  });

  it("a range with no type is UNKNOWN", async () => {
    const { output } = await scan(projectWithLib("5.0.0"), [
      advisory({
        ranges: [{ events: [{ introduced: "0" }, { fixed: "4.0.0" }] }],
      }),
    ]);

    expectApplicabilityUnknown(output);
  });

  it("control: a GIT range beside a `versions` list naming the installed version is a finding", async () => {
    const { output } = await scan(projectWithLib("5.0.0"), [
      advisory({
        ranges: [
          {
            type: "GIT",
            events: [{ introduced: "0" }, { fixed: "3f2a9c1b0d" }],
          },
        ],
        versions: ["4.9.0", "5.0.0"],
      }),
    ]);

    expect(outcomes(output)).toEqual({ [HOISTED]: "AFFECTED" });
  });
});

describe("B-2 / RWF-091: SEMVER events are evaluated in version order, as OSV specifies", () => {
  it("an unsorted event list still covers the version its sorted walk covers", async () => {
    const { exit, output } = await scan(projectWithLib("2.5.0"), [
      semverRange([{ introduced: "2.0.0" }, { fixed: "1.0.0" }]),
    ]);

    expect(exit).toBe(1);
    expect(outcomes(output)).toEqual({ [HOISTED]: "AFFECTED" });
  });

  it("control: the same events, sorted", async () => {
    const { output } = await scan(projectWithLib("2.5.0"), [
      semverRange([{ fixed: "1.0.0" }, { introduced: "2.0.0" }]),
    ]);

    expect(outcomes(output)).toEqual({ [HOISTED]: "AFFECTED" });
  });

  it("control: a version below the reopened range is not applicable", async () => {
    const { output } = await scan(projectWithLib("1.5.0"), [
      semverRange([{ introduced: "2.0.0" }, { fixed: "1.0.0" }]),
    ]);

    expect(outcomes(output)).toEqual({ [HOISTED]: "not_applicable" });
  });
});
