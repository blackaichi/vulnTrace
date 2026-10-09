import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type {
  RawVulnerability,
  VulnerabilityProvider,
} from "../domain/vulnerability.js";
import { OsvProvider } from "../vulnerabilities/osv-provider.js";
import { renderHtmlReport } from "./html-report.js";
import {
  SCHEMA_VERSION,
  type ScanOutput,
  validateScanOutput,
} from "./output.js";
import { runScanCommand } from "./scan.js";

/**
 * Task B-1 -- provider completeness, end to end through a real scan.
 *
 * Every advisory OSV returns for an installed package must be accounted:
 * by a finding, or by an `unreportedCandidates` entry that says why there
 * is none. Four ways it ended in neither:
 *
 *  - PRM-65: only OSV's first results page was read (silent drop);
 *  - AUD-10: a record the normalizer cannot use reached `diagnostics`
 *    only -- the one no-finding path absent from the channel F3 built to
 *    account for exactly this (silent drop);
 *  - AUD-11: a record with `id: ""` normalized, then failed output
 *    validation: exit 3, and the whole report -- real AFFECTED findings
 *    included -- was lost (scan abort);
 *  - AUD-14: a withdrawn advisory was analyzed like a live one (false
 *    finding); decision 10 makes it a `withdrawn` disposition.
 *
 * Every test runs the REAL `OsvProvider` (so its request, pagination and
 * envelope parsing are the production ones) over a stubbed `fetch`. The
 * fixture is loud: `vuln-lib` exports `danger`, the export every rule here
 * targets, and the application calls it, so every advisory that reaches
 * the verdict layer is AFFECTED. An advisory that silently disappears is
 * therefore a missing AFFECTED finding, never a quiet UNKNOWN.
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

function rule(id: string): string {
  return (
    `  - id: ${id}\n` +
    `    package:\n` +
    `      name: vuln-lib\n` +
    `    targets:\n` +
    `      - module: vuln-lib\n` +
    `        export: danger\n` +
    `        kind: function\n` +
    `        confidence: 1.0\n`
  );
}

const RULE_IDS = [
  "GHSA-b1-page-1",
  "GHSA-b1-page-2",
  "GHSA-b1-live",
  "GHSA-b1-withdrawn",
  "GHSA-b1-future",
  "GHSA-b1-bad",
  "GHSA-b1-unmatched",
];

/** An advisory for `vuln-lib`, affected below 2.0.0. */
function advisory(
  id: string,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    id,
    affected: [
      {
        package: { ecosystem: "npm", name: "vuln-lib" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "0" }, { fixed: "2.0.0" }],
          },
        ],
      },
    ],
    ...extra,
  };
}

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "vulntrace-b1-"));
  dirs.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  return root;
}

/**
 * One installed `vuln-lib@1.0.0`, called through `danger`. With
 * `twoInstances`, a second, nested `vuln-lib@1.0.0` under `host` is called
 * too: two exact instances sharing a name and a version, each of which
 * must be accounted on its own. `nestedVersion` gives the nested one
 * another version, so the scan makes two provider queries.
 */
function projectWithLib(
  options: {
    readonly twoInstances?: boolean;
    readonly nestedVersion?: string;
  } = {},
) {
  const twin = options.twoInstances === true;
  const nested = options.nestedVersion ?? "1.0.0";
  const dependencies: Record<string, string> = {
    "vuln-lib": "1.0.0",
    ...(twin ? { host: "1.0.0" } : {}),
  };
  return project({
    "vulntrace.yml": CONFIG,
    "rules.yml": "rules:\n" + RULE_IDS.map(rule).join(""),
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
        "node_modules/vuln-lib": { version: "1.0.0" },
        ...(twin
          ? {
              "node_modules/host": { version: "1.0.0" },
              "node_modules/host/node_modules/vuln-lib": { version: nested },
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
      version: "1.0.0",
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
            JSON.stringify({ name: "vuln-lib", version: nested }),
          "node_modules/host/node_modules/vuln-lib/index.js": LIB_SOURCE,
        }
      : {}),
  });
}

/**
 * A stubbed OSV: `pages` answers `vuln-lib`'s query, page by page, keyed
 * by `page_token` (`<first>` for the first request); every other package
 * has no advisories. The real `OsvProvider` drives it.
 */
function osv(pages: Readonly<Record<string, unknown>>): {
  readonly provider: OsvProvider;
  readonly requests: Record<string, unknown>[];
} {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url, init) => {
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    requests.push(body);
    const name = (body.package as { name: string }).name;
    if (name !== "vuln-lib") {
      return new Response(JSON.stringify({ vulns: [] }), { status: 200 });
    }
    const token =
      typeof body.page_token === "string" ? body.page_token : "<first>";
    const page = pages[token];
    return page === undefined
      ? new Response(`no page ${token}`, { status: 400 })
      : new Response(JSON.stringify(page), { status: 200 });
  }) as typeof fetch;
  return { provider: new OsvProvider({ fetchImpl }), requests };
}

/** Loosely typed on purpose: the dispositions under test are new. */
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
  }[];
  readonly diagnostics: { readonly source: string; readonly message: string }[];
  readonly unreportedCandidates: Entry[];
}

async function scan(
  root: string,
  provider: VulnerabilityProvider,
  cveFilter?: string,
): Promise<{
  readonly exit: number;
  readonly output: Output | undefined;
  readonly stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exit = await runScanCommand({
    projectPathArg: root,
    configPathOverride: path.join(root, "vulntrace.yml"),
    provider,
    noCache: true,
    ...(cveFilter === undefined ? {} : { cveFilter }),
    io: {
      stdout: (text) => stdout.push(text),
      stderr: (text) => stderr.push(text),
    },
  });
  const text = stdout.join("");
  return {
    exit,
    output: text === "" ? undefined : (JSON.parse(text) as Output),
    stderr: stderr.join(""),
  };
}

function verdictsById(output: Output | undefined): Record<string, string[]> {
  const byId: Record<string, string[]> = {};
  for (const finding of output?.findings ?? []) {
    (byId[finding.vulnerability] ??= []).push(finding.verdict);
  }
  return byId;
}

const entriesWith = (output: Output | undefined, reason: string): Entry[] =>
  (output?.unreportedCandidates ?? []).filter(
    (entry) => entry.reason === reason,
  );

describe("B-1 / PRM-65: every OSV results page reaches the scan", () => {
  it("an advisory on page 2 is a finding", async () => {
    const { provider, requests } = osv({
      "<first>": { vulns: [advisory("GHSA-b1-page-1")], next_page_token: "P2" },
      P2: { vulns: [advisory("GHSA-b1-page-2")] },
    });

    const { exit, output } = await scan(projectWithLib(), provider);

    expect(exit).toBe(1);
    expect(verdictsById(output)).toEqual({
      "GHSA-b1-page-1": ["AFFECTED"],
      "GHSA-b1-page-2": ["AFFECTED"],
    });
    expect(
      requests.filter((request) => request.page_token === "P2"),
    ).toHaveLength(1);
  });

  it("control: the same two advisories on one page", async () => {
    const { provider } = osv({
      "<first>": {
        vulns: [advisory("GHSA-b1-page-1"), advisory("GHSA-b1-page-2")],
      },
    });

    const { output } = await scan(projectWithLib(), provider);

    expect(verdictsById(output)).toEqual({
      "GHSA-b1-page-1": ["AFFECTED"],
      "GHSA-b1-page-2": ["AFFECTED"],
    });
  });

  it("a pagination failure fails the scan as a provider failure (exit 4), never as a shorter report", async () => {
    const { provider } = osv({
      "<first>": { vulns: [advisory("GHSA-b1-page-1")], next_page_token: "P2" },
      // P2 is missing: OSV answers 400.
    });

    const { exit, output } = await scan(projectWithLib(), provider);

    expect(exit).toBe(4);
    expect(output).toBeUndefined();
  });
});

describe("B-1 / AUD-10: an unusable record is accounted, not only diagnosed", () => {
  // AUD-10's two shapes: one the normalizer's schema refuses
  // (`introduced: 0`, a number), and one with no `affected` entry for the
  // package the query named (ecosystem "NPM").
  const MALFORMED = advisory("GHSA-b1-bad", {
    affected: [
      {
        package: { ecosystem: "npm", name: "vuln-lib" },
        ranges: [{ type: "SEMVER", events: [{ introduced: 0 }] }],
      },
    ],
  });
  const UNMATCHED = advisory("GHSA-b1-unmatched", {
    affected: [{ package: { ecosystem: "NPM", name: "vuln-lib" } }],
  });

  it("each unusable record is an undetermined entry, analysis_precondition_unmet", async () => {
    const { provider } = osv({
      "<first>": {
        vulns: [advisory("GHSA-b1-live"), MALFORMED, UNMATCHED],
      },
    });

    const { exit, output } = await scan(projectWithLib(), provider);

    expect(exit).toBe(1);
    expect(verdictsById(output)).toEqual({ "GHSA-b1-live": ["AFFECTED"] });

    const entries = entriesWith(output, "advisory_record_malformed");
    expect(entries.map((entry) => entry.vulnerability).sort()).toEqual([
      "GHSA-b1-bad",
      "GHSA-b1-unmatched",
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        stage: "advisory_applicability",
        disposition: "undetermined",
        package: "vuln-lib",
        packageInstance: "node_modules/vuln-lib",
        version: "1.0.0",
        category: "analysis_precondition_unmet",
      });
    }

    // The operational channel is unchanged: a human still sees why.
    expect(
      output?.diagnostics.filter(
        (diagnostic) => diagnostic.source === "vulnerabilities",
      ),
    ).toHaveLength(2);
  });

  it("is accounted against EVERY exact instance of the name", async () => {
    const { provider } = osv({ "<first>": { vulns: [MALFORMED] } });

    const { output } = await scan(
      projectWithLib({ twoInstances: true }),
      provider,
    );

    expect(
      entriesWith(output, "advisory_record_malformed")
        .map((entry) => entry.packageInstance)
        .sort(),
    ).toEqual([
      "node_modules/host/node_modules/vuln-lib",
      "node_modules/vuln-lib",
    ]);
  });

  it("--cve: an unusable record whose id or aliases match is accounted", async () => {
    const { provider } = osv({
      "<first>": {
        vulns: [
          { ...MALFORMED, aliases: ["CVE-2099-0001"] },
          advisory("GHSA-b1-live"),
        ],
      },
    });

    const { output } = await scan(projectWithLib(), provider, "CVE-2099-0001");

    expect(verdictsById(output)).toEqual({});
    expect(
      entriesWith(output, "advisory_record_malformed").map(
        (entry) => entry.vulnerability,
      ),
    ).toEqual(["GHSA-b1-bad"]);
  });

  it("--cve: an unusable record that provably names another advisory is filtered like a usable one", async () => {
    const { provider } = osv({
      "<first>": { vulns: [MALFORMED, advisory("GHSA-b1-live")] },
    });

    const { output } = await scan(projectWithLib(), provider, "GHSA-b1-live");

    expect(verdictsById(output)).toEqual({ "GHSA-b1-live": ["AFFECTED"] });
    expect(entriesWith(output, "advisory_record_malformed")).toEqual([]);
  });

  it("--cve: an unusable record whose identity cannot be read is accounted (it may be the one asked for)", async () => {
    const { provider } = osv({
      "<first>": { vulns: [{ id: 42, aliases: "CVE-2099-0001" }] },
    });

    const { output } = await scan(projectWithLib(), provider, "CVE-2099-0001");

    const entries = entriesWith(output, "advisory_record_malformed");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.vulnerability).toBeUndefined();
  });
});

describe("B-1: unusable records, across queries and from an unchecked source", () => {
  // B-1's independent audit, finding 2(b): two installed versions make two
  // provider queries, and both return the same unusable record. It is one
  // unusable advisory, accounted once per instance -- not once per query.
  it("the same unusable record from two version queries is one entry per instance", async () => {
    const { provider, requests } = osv({
      "<first>": {
        vulns: [
          advisory("GHSA-b1-bad", {
            affected: [
              {
                package: { ecosystem: "npm", name: "vuln-lib" },
                ranges: [{ type: "SEMVER", events: [{ introduced: 0 }] }],
              },
            ],
          }),
        ],
      },
    });

    const { output } = await scan(
      projectWithLib({ twoInstances: true, nestedVersion: "1.5.0" }),
      provider,
    );

    expect(
      requests.filter(
        (request) => (request.package as { name: string }).name === "vuln-lib",
      ),
    ).toHaveLength(2);
    expect(
      entriesWith(output, "advisory_record_malformed")
        .map((entry) => `${entry.packageInstance}@${entry.version}`)
        .sort(),
    ).toEqual([
      "node_modules/host/node_modules/vuln-lib@1.5.0",
      "node_modules/vuln-lib@1.0.0",
    ]);
  });

  // B-1's independent audit, finding 1: a cached answer is read back
  // without a shape check (B-3), so a `null` entry can reach the scan. It
  // is an unusable record, accounted -- never a crash that loses the report.
  it("a null record is accounted, and the scan keeps its real finding", async () => {
    const provider: VulnerabilityProvider = {
      queryPackage: (query): Promise<readonly RawVulnerability[]> =>
        Promise.resolve(
          query.name === "vuln-lib"
            ? ([
                null,
                advisory("GHSA-b1-live"),
              ] as unknown as RawVulnerability[])
            : [],
        ),
    };

    const { exit, output } = await scan(projectWithLib(), provider);

    expect(exit).toBe(1);
    expect(verdictsById(output)).toEqual({ "GHSA-b1-live": ["AFFECTED"] });
    const entries = entriesWith(output, "advisory_record_malformed");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.vulnerability).toBeUndefined();
  });
});

describe("B-1 / AUD-11: one record with an empty id cannot lose the report", () => {
  it("the scan keeps its real AFFECTED finding, exits 1, and accounts the record", async () => {
    const { provider } = osv({
      "<first>": { vulns: [advisory("GHSA-b1-live"), advisory("")] },
    });

    const { exit, output } = await scan(projectWithLib(), provider);

    expect(exit).toBe(1);
    expect(verdictsById(output)).toEqual({ "GHSA-b1-live": ["AFFECTED"] });
    const entries = entriesWith(output, "advisory_record_malformed");
    expect(entries).toHaveLength(1);
    // There is no usable identity to name, so none is invented.
    expect(entries[0]?.vulnerability).toBeUndefined();
    expect(entries[0]).toMatchObject({
      disposition: "undetermined",
      packageInstance: "node_modules/vuln-lib",
      category: "analysis_precondition_unmet",
    });
  });
});

describe("B-1 / AUD-14: a withdrawn advisory is a withdrawn disposition (decision 10)", () => {
  it("a withdrawn advisory produces no finding and a withdrawn entry, with no category", async () => {
    const { provider } = osv({
      "<first>": {
        vulns: [
          advisory("GHSA-b1-withdrawn", { withdrawn: "2020-01-01T00:00:00Z" }),
        ],
      },
    });

    const { exit, output } = await scan(projectWithLib(), provider);

    expect(exit).toBe(0);
    expect(verdictsById(output)).toEqual({});
    const entries = entriesWith(output, "advisory_withdrawn");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      stage: "advisory_applicability",
      disposition: "withdrawn",
      vulnerability: "GHSA-b1-withdrawn",
      package: "vuln-lib",
      packageInstance: "node_modules/vuln-lib",
      version: "1.0.0",
    });
    expect(entries[0]?.category).toBeUndefined();
    expect(entries[0]?.detail).toContain("2020-01-01T00:00:00Z");
  });

  it("control: the same advisory, not withdrawn, is AFFECTED", async () => {
    const { provider } = osv({
      "<first>": { vulns: [advisory("GHSA-b1-withdrawn")] },
    });

    const { output } = await scan(projectWithLib(), provider);

    expect(verdictsById(output)).toEqual({
      "GHSA-b1-withdrawn": ["AFFECTED"],
    });
    expect(entriesWith(output, "advisory_withdrawn")).toEqual([]);
  });

  // OSV: `withdrawn` is "the time the entry should be considered to have
  // been withdrawn". Before that time it is a live advisory.
  it("an advisory withdrawn only in the future is still analyzed", async () => {
    const { provider } = osv({
      "<first>": {
        vulns: [
          advisory("GHSA-b1-future", { withdrawn: "2999-01-01T00:00:00Z" }),
        ],
      },
    });

    const { output } = await scan(projectWithLib(), provider);

    expect(verdictsById(output)).toEqual({ "GHSA-b1-future": ["AFFECTED"] });
    expect(entriesWith(output, "advisory_withdrawn")).toEqual([]);
  });

  it("is recorded against EVERY exact instance of the name", async () => {
    const { provider } = osv({
      "<first>": {
        vulns: [
          advisory("GHSA-b1-withdrawn", { withdrawn: "2020-01-01T00:00:00Z" }),
        ],
      },
    });

    const { output } = await scan(
      projectWithLib({ twoInstances: true }),
      provider,
    );

    expect(verdictsById(output)).toEqual({});
    expect(
      entriesWith(output, "advisory_withdrawn")
        .map((entry) => entry.packageInstance)
        .sort(),
    ).toEqual([
      "node_modules/host/node_modules/vuln-lib",
      "node_modules/vuln-lib",
    ]);
  });

  // A withdrawn copy never displaces a live copy of the same advisory:
  // dropping a live advisory is the direction that hides a finding.
  it("a live copy of the same id wins over a withdrawn copy", async () => {
    const { provider } = osv({
      "<first>": {
        vulns: [
          advisory("GHSA-b1-withdrawn", { withdrawn: "2020-01-01T00:00:00Z" }),
          advisory("GHSA-b1-withdrawn"),
        ],
      },
    });

    const { output } = await scan(projectWithLib(), provider);

    expect(verdictsById(output)).toEqual({
      "GHSA-b1-withdrawn": ["AFFECTED"],
    });
  });

  it("a withdrawn that cannot be read is an unusable record, not a withdrawal", async () => {
    const { provider } = osv({
      "<first>": {
        vulns: [advisory("GHSA-b1-withdrawn", { withdrawn: "soon" })],
      },
    });

    const { output } = await scan(projectWithLib(), provider);

    expect(verdictsById(output)).toEqual({});
    expect(entriesWith(output, "advisory_withdrawn")).toEqual([]);
    expect(
      entriesWith(output, "advisory_record_malformed").map(
        (entry) => entry.vulnerability,
      ),
    ).toEqual(["GHSA-b1-withdrawn"]);
  });
});

describe("B-1: the result schema (0.7) and the HTML report carry the withdrawn disposition", () => {
  const timings = {
    parsingMs: 0,
    resolutionMs: 0,
    graphConstructionMs: 0,
    reachabilityMs: 0,
    providerMs: 0,
    cacheHits: 0,
    cacheMisses: 0,
    totalMs: 0,
  };
  const coverage = {
    files: 0,
    modulesResolved: 0,
    modulesUnresolved: 0,
    functions: 0,
    callsResolved: 0,
    callsDynamic: 0,
    callsPossible: 0,
  };
  const withdrawn = {
    stage: "advisory_applicability",
    disposition: "withdrawn",
    vulnerability: "GHSA-b1-withdrawn",
    package: "vuln-lib",
    packageInstance: "node_modules/vuln-lib",
    version: "1.0.0",
    reason: "advisory_withdrawn",
    detail: "the vulnerability provider withdrew GHSA-b1-withdrawn",
  };
  const outputWith = (entries: readonly Record<string, unknown>[]) => ({
    schemaVersion: SCHEMA_VERSION,
    scan: { id: "scan-b1", project: "." },
    findings: [],
    coverage,
    diagnostics: [],
    unreportedCandidates: entries,
    timings,
  });

  it("is version 0.7", () => {
    expect(SCHEMA_VERSION).toBe("0.7");
  });

  it("accepts a withdrawn entry and an advisory_record_malformed entry", () => {
    expect(
      validateScanOutput(
        outputWith([
          withdrawn,
          {
            stage: "advisory_applicability",
            disposition: "undetermined",
            package: "vuln-lib",
            reason: "advisory_record_malformed",
            category: "analysis_precondition_unmet",
            detail: "an unusable record",
          },
        ]),
      ),
    ).toEqual([]);
  });

  it.each([
    ["with a category", { ...withdrawn, category: "identity_unresolved" }],
    [
      "with an uncertainty reason",
      { ...withdrawn, reason: "unresolved_module" },
    ],
    ["naming no advisory", { ...withdrawn, vulnerability: undefined }],
  ])("rejects a withdrawn entry %s", (_label, entry) => {
    const json = JSON.parse(JSON.stringify(outputWith([entry]))) as unknown;
    expect(validateScanOutput(json)).not.toEqual([]);
  });

  it("the HTML report labels it in words, not as Undetermined", () => {
    const html = renderHtmlReport(
      outputWith([withdrawn]) as unknown as ScanOutput,
    );
    expect(html).toContain("Withdrawn by the provider");
    expect(html).not.toContain(">Undetermined<");
  });
});
