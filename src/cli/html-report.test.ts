import { describe, expect, it } from "vitest";
import {
  SUPPORTED_MODEL_EXCLUSIONS,
  SUPPORTED_MODEL_STATEMENT,
} from "../domain/evidence.js";
import {
  escapeHtml,
  formatSourceLocation,
  parseSourceLocation,
  renderHtmlReport,
  unknownReasonToken,
} from "./html-report.js";
import {
  SCHEMA_VERSION,
  validateScanOutput,
  type ScanOutput,
} from "./output.js";

/**
 * HTML Report v0.1 — renderer unit tests.
 *
 * Every case here runs the renderer directly against a hand-built
 * `ScanOutput`: no scan, no filesystem, no network. That is the point of
 * keeping rendering isolated from scanning, and it is also what lets these
 * tests cover evidence variants (a truncated-graph UNKNOWN, all three
 * negative-proof families) that would otherwise need a bespoke fixture
 * project each.
 *
 * Injection/escaping lives in the sibling `html-report.security.test.ts`.
 */

const EMPTY_COVERAGE = {
  files: 0,
  modulesResolved: 0,
  modulesUnresolved: 0,
  functions: 0,
  callsResolved: 0,
  callsDynamic: 0,
} as const;

const EMPTY_TIMINGS = {
  parsingMs: 3,
  resolutionMs: 4,
  graphConstructionMs: 7,
  reachabilityMs: 2,
  providerMs: 11,
  cacheHits: 1,
  cacheMisses: 2,
  totalMs: 42,
} as const;

function scanOutput(partial: Partial<ScanOutput> = {}): ScanOutput {
  return {
    schemaVersion: SCHEMA_VERSION,
    scan: { id: "scan-0001", project: "." },
    findings: [],
    coverage: EMPTY_COVERAGE,
    diagnostics: [],
    timings: EMPTY_TIMINGS,
    ...partial,
  };
}

const AFFECTED_FINDING: ScanOutput["findings"][number] = {
  vulnerability: "GHSA-affected-0001",
  package: "fixture-lib",
  version: "1.0.0",
  verdict: "AFFECTED",
  confidence: 1,
  target: { module: "fixture-lib", symbol: "vulnerable", kind: "function" },
  evidence: {
    path: [
      "/proj/src/index.ts:4",
      "/proj/src/wrapper.ts:12:9",
      "/proj/node_modules/fixture-lib/index.js:10",
    ],
    reasons: [
      "vulnerable symbol resolved",
      "symbol reachable from application entrypoint",
    ],
  },
};

const UNKNOWN_FINDING: ScanOutput["findings"][number] = {
  vulnerability: "GHSA-unknown-0002",
  package: "dynamic-lib",
  version: "2.3.4",
  verdict: "UNKNOWN",
  target: { module: "dynamic-lib", symbol: "risky" },
  evidence: {
    path: [],
    reasons: [
      "dynamic_require at /proj/src/loader.ts#load",
      "declaration_only_resolution at /proj/src/types.ts#shim",
      'could not resolve module "dynamic-lib": module "dynamic-lib" resolved only to a TypeScript declaration file (/proj/node_modules/dynamic-lib/index.d.ts), not a runtime implementation',
    ],
  },
};

const FAMILY_A_FINDING: ScanOutput["findings"][number] = {
  vulnerability: "GHSA-family-a-0003",
  package: "unloaded-lib",
  version: "3.0.0",
  verdict: "NOT_AFFECTED",
  target: { module: "unloaded-lib", symbol: "gadget" },
  evidence: {
    path: [],
    reasons: ["package_instance_not_in_complete_module_load_closure"],
    confirmedAbsentFromModuleLoadClosure: {
      packageInstance: "/proj/node_modules/unloaded-lib",
      entrypointRoots: ["/proj/src/index.ts"],
      closureComplete: true,
    },
  },
};

const FAMILY_B_FINDING: ScanOutput["findings"][number] = {
  vulnerability: "GHSA-family-b-0004",
  package: "nested-lib",
  version: "4.1.0",
  verdict: "NOT_AFFECTED",
  target: { module: "nested-lib", symbol: "gadget" },
  evidence: {
    path: [],
    reasons: [
      "package_instance_absent_from_call_graph_and_module_load_closure",
    ],
    confirmedAbsentInstance: {
      packageInstance: "/proj/node_modules/consumer/node_modules/nested-lib",
      entrypointRoots: ["/proj/src/index.ts", "/proj/src/cli.ts"],
      graphTruncated: false,
      moduleLoadClosureComplete: true,
    },
  },
};

const FAMILY_C_FINDING: ScanOutput["findings"][number] = {
  vulnerability: "GHSA-family-c-0005",
  package: "loaded-lib",
  version: "5.2.1",
  verdict: "NOT_AFFECTED",
  target: { module: "loaded-lib", symbol: "neverCalled" },
  evidence: {
    path: [],
    reasons: [
      "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
    ],
    confirmedUnreachableTarget: {
      target: { module: "loaded-lib", export: "neverCalled" },
      entrypointRoots: ["/proj/src/index.ts"],
      reachableSubgraphComplete: true,
    },
  },
};

const ALL_FINDINGS = [
  AFFECTED_FINDING,
  UNKNOWN_FINDING,
  FAMILY_A_FINDING,
  FAMILY_B_FINDING,
  FAMILY_C_FINDING,
];

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters exactly once", () => {
    expect(escapeHtml(`<a href="x">& '</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp; &#39;&lt;/a&gt;",
    );
  });

  it("does not double-escape an ampersand it introduced itself", () => {
    expect(escapeHtml("<&>")).toBe("&lt;&amp;&gt;");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeHtml("node_modules/lodash@4.17.4")).toBe(
      "node_modules/lodash@4.17.4",
    );
  });
});

describe("source-location formatting", () => {
  it("renders file:line:column when all three are present", () => {
    expect(formatSourceLocation("src/index.ts:12:9")).toBe("src/index.ts:12:9");
  });

  it("renders file:line when there is no column", () => {
    expect(formatSourceLocation("src/index.ts:12")).toBe("src/index.ts:12");
  });

  it("renders the file alone when there is no location detail", () => {
    expect(formatSourceLocation("src/index.ts")).toBe("src/index.ts");
  });

  it("drops the trailing separator locationOf emits for a node with no line", () => {
    expect(formatSourceLocation("src/index.ts:")).toBe("src/index.ts");
  });

  it("never renders undefined/null segments", () => {
    expect(formatSourceLocation("src/index.ts:undefined")).toBe("src/index.ts");
    expect(formatSourceLocation("src/index.ts:undefined:undefined")).toBe(
      "src/index.ts",
    );
    expect(formatSourceLocation("   ")).toBe("");
    expect(parseSourceLocation(":")).toBeUndefined();
  });

  it("keeps a Windows-style drive letter intact rather than reading it as a line", () => {
    expect(formatSourceLocation("C:/proj/src/index.ts:12")).toBe(
      "C:/proj/src/index.ts:12",
    );
  });
});

describe("unknownReasonToken", () => {
  it("lifts the blocker vocabulary token out of a reachability blocker", () => {
    expect(unknownReasonToken("dynamic_require at /proj/src/a.ts#load")).toBe(
      "dynamic_require",
    );
    expect(
      unknownReasonToken("loader_capability_escape at /proj/src/a.ts#hook"),
    ).toBe("loader_capability_escape");
  });

  it("returns undefined for a prose reason rather than inventing a token", () => {
    expect(
      unknownReasonToken(
        "no entrypoints were available to check reachability from",
      ),
    ).toBeUndefined();
    expect(
      unknownReasonToken('could not resolve module "x": something happened'),
    ).toBeUndefined();
  });
});

describe("renderHtmlReport document shape", () => {
  it("produces one complete, self-contained HTML document", () => {
    const html = renderHtmlReport(scanOutput({ findings: ALL_FINDINGS }));

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain("<title>VulnTrace report");
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    // Tag balance: every opened structural element is closed. Matched
    // with a delimiter so `<head` does not also count `<header>`.
    for (const tag of ["html", "head", "body", "main", "style", "script"]) {
      const opened = html.match(new RegExp(`<${tag}[\\s>]`, "g")) ?? [];
      const closed = html.match(new RegExp(`</${tag}>`, "g")) ?? [];
      expect(opened.length).toBe(closed.length);
      expect(opened.length).toBe(1);
    }
  });

  it("references no external asset and issues no network request", () => {
    const html = renderHtmlReport(scanOutput({ findings: ALL_FINDINGS }));

    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(/@import/i);
    expect(html).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(
      /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/,
    );
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("is deterministic for a fixed ScanResult", () => {
    const output = scanOutput({
      findings: ALL_FINDINGS,
      diagnostics: [{ source: "call-graph", message: "dynamic_require" }],
    });

    expect(renderHtmlReport(output)).toBe(renderHtmlReport(output));
    // Stable, index-derived ids -- never random.
    expect(renderHtmlReport(output)).toContain('id="finding-1"');
    expect(renderHtmlReport(output)).toContain('id="finding-5"');
    expect(renderHtmlReport(output)).not.toMatch(/id="finding-[0-9a-f]{8}-/);
  });

  it("renders the scan summary fields the result actually carries", () => {
    const html = renderHtmlReport(
      scanOutput({
        scan: { id: "scan-abc", project: "./my-project" },
        findings: ALL_FINDINGS,
        coverage: { ...EMPTY_COVERAGE, files: 12, callsDynamic: 3 },
      }),
    );

    expect(html).toContain("Scan summary");
    expect(html).toContain("scan-abc");
    expect(html).toContain("./my-project");
    expect(html).toContain(SCHEMA_VERSION);
    expect(html).toContain("42"); // timings.totalMs
    expect(html).toContain("Analysis coverage");
    expect(html).toContain("Files analyzed");
    expect(html).toContain("Timings");
  });

  it("counts and groups every verdict, and links the summary counts to their groups", () => {
    const html = renderHtmlReport(scanOutput({ findings: ALL_FINDINGS }));

    expect(html).toContain('href="#verdict-AFFECTED"');
    expect(html).toContain('href="#verdict-UNKNOWN"');
    expect(html).toContain('href="#verdict-NOT_AFFECTED"');
    expect(html).toContain('id="verdict-AFFECTED"');
    expect(html).toContain('id="verdict-UNKNOWN"');
    expect(html).toContain('id="verdict-NOT_AFFECTED"');
    expect(
      html.split('data-verdict="NOT_AFFECTED"').length - 1,
    ).toBeGreaterThan(1);
    // One overview row plus one detail article per finding.
    expect(html.split('class="finding-row"').length - 1).toBe(
      ALL_FINDINGS.length,
    );
    expect(html.split('<article class="finding"').length - 1).toBe(
      ALL_FINDINGS.length,
    );
  });

  it("never communicates a verdict by colour alone", () => {
    const html = renderHtmlReport(scanOutput({ findings: ALL_FINDINGS }));

    for (const verdict of ["AFFECTED", "UNKNOWN", "NOT_AFFECTED"]) {
      expect(html).toContain(`<span class="badge-label">${verdict}</span>`);
    }
    expect(html).toContain('class="glyph"');
  });

  it("keeps every finding expanded in the static document, for no-JS readers and printing", () => {
    const html = renderHtmlReport(scanOutput({ findings: ALL_FINDINGS }));

    expect(html.split("<details open>").length - 1).toBe(ALL_FINDINGS.length);
    expect(html).not.toContain("<details>");
    expect(html).toContain("@media print");
  });
});

describe("supported-model disclosure", () => {
  it("renders the shared supported-model statement and every declared exclusion", () => {
    const html = renderHtmlReport(scanOutput({ findings: ALL_FINDINGS }));

    expect(html).toContain("Analysis scope / supported model");
    expect(html).toContain(escapeHtml(SUPPORTED_MODEL_STATEMENT));
    for (const exclusion of SUPPORTED_MODEL_EXCLUSIONS) {
      expect(html).toContain(escapeHtml(exclusion));
    }
    expect(SUPPORTED_MODEL_EXCLUSIONS.length).toBeGreaterThan(0);
  });

  it("never claims a NOT_AFFECTED package can't execute", () => {
    const html = renderHtmlReport(scanOutput({ findings: ALL_FINDINGS }));

    expect(html).not.toMatch(/cannot ever execute/i);
    expect(html).not.toMatch(/can never (?:run|execute)/i);
    expect(html).toContain("declared supported");
  });
});

describe("AFFECTED rendering", () => {
  const html = renderHtmlReport(scanOutput({ findings: [AFFECTED_FINDING] }));

  it("shows the advisory, package, version and vulnerable symbol", () => {
    expect(html).toContain("GHSA-affected-0001");
    expect(html).toContain("fixture-lib");
    expect(html).toContain("1.0.0");
    expect(html).toContain("fixture-lib#vulnerable");
    expect(html).toContain("Target kind");
  });

  it("renders the reachability path in the result's own order", () => {
    expect(html).toContain("Reachability path");
    const entry = html.indexOf("/proj/src/index.ts:4");
    const middle = html.indexOf("/proj/src/wrapper.ts:12:9");
    const target = html.indexOf("/proj/node_modules/fixture-lib/index.js:10");
    expect(entry).toBeGreaterThan(-1);
    expect(middle).toBeGreaterThan(entry);
    expect(target).toBeGreaterThan(middle);
  });

  it("labels the first and last path nodes without describing any step as a call", () => {
    const start = html.indexOf('<ol class="path">');
    const pathSection = html.slice(start, html.indexOf("</ol>", start));

    expect(pathSection).toContain("Entrypoint");
    expect(pathSection).toContain("Step 1");
    expect(pathSection).toContain("Vulnerable target");
    // A `module_load` edge must never be rendered as a call
    // (see CallEdgeType in domain/graph.ts).
    expect(pathSection).not.toMatch(/\bcall(?:s|ed|ing)?\b/i);
  });

  it("shows the reasons the scan recorded", () => {
    expect(html).toContain("vulnerable symbol resolved");
    expect(html).toContain("symbol reachable from application entrypoint");
  });

  it("says so plainly when an AFFECTED finding carries no path", () => {
    const pathless = renderHtmlReport(
      scanOutput({
        findings: [
          {
            ...AFFECTED_FINDING,
            evidence: { path: [], reasons: ["vulnerable symbol resolved"] },
          },
        ],
      }),
    );

    expect(pathless).toContain("carries no path in the scan result");
    expect(pathless).toContain("vulnerable symbol resolved");
  });
});

describe("UNKNOWN rendering", () => {
  const html = renderHtmlReport(scanOutput({ findings: [UNKNOWN_FINDING] }));

  it("treats UNKNOWN as a first-class result, not an error", () => {
    expect(html).toContain("first-class result");
    expect(html).toContain("Why this is UNKNOWN");
  });

  it("shows every blocking reason verbatim, with its own vocabulary token", () => {
    expect(html).toContain("dynamic_require at /proj/src/loader.ts#load");
    expect(html).toContain(
      "declaration_only_resolution at /proj/src/types.ts#shim",
    );
    expect(html).toContain("resolved only to a TypeScript declaration file");
    expect(html).toContain('<span class="token">dynamic_require</span>');
    expect(html).toContain(
      '<span class="token">declaration_only_resolution</span>',
    );
  });

  it("does not collapse distinct blockers into one generic explanation", () => {
    const reasons = UNKNOWN_FINDING.evidence?.reasons ?? [];
    expect(reasons.length).toBe(3);
    expect(html.split('<li><span class="token"').length - 1).toBe(2);
    expect(html).not.toMatch(/analysis incomplete/i);
  });

  it("renders a graph-truncation UNKNOWN with its own reason", () => {
    const truncated = renderHtmlReport(
      scanOutput({
        findings: [
          {
            vulnerability: "GHSA-truncated",
            package: "big-lib",
            version: "1.0.0",
            verdict: "UNKNOWN",
            evidence: {
              path: [],
              reasons: [
                "call-graph construction was truncated by a configured resource limit (analysis.limits) before every reachable path could be exhaustively searched",
              ],
            },
          },
        ],
      }),
    );

    expect(truncated).toContain("truncated by a configured resource limit");
  });

  it("states the absence plainly for an UNKNOWN with no evidence at all", () => {
    const bare = renderHtmlReport(
      scanOutput({
        findings: [
          {
            vulnerability: "GHSA-no-rule",
            package: "lodash",
            version: "4.17.4",
            verdict: "UNKNOWN",
          },
        ],
      }),
    );

    expect(bare).toContain("records no reason for this UNKNOWN finding");
    expect(bare).toContain("no vulnerable-behavior target was established");
    expect(bare).not.toContain("undefined");
  });
});

describe("NOT_AFFECTED positive proof", () => {
  it("family A shows the module-load absence evidence in full", () => {
    const html = renderHtmlReport(scanOutput({ findings: [FAMILY_A_FINDING] }));

    expect(html).toContain("Family A — module-load absence");
    expect(html).toContain("/proj/node_modules/unloaded-lib");
    expect(html).toContain("Entrypoint roots");
    expect(html).toContain("/proj/src/index.ts");
    expect(html).toContain("Module-load closure complete");
    expect(html).toContain(
      "package_instance_not_in_complete_module_load_closure",
    );
    expect(html).toContain("absent from a complete module-load closure");
    expect(html).toContain(
      "It says nothing about which symbols inside a package that IS loaded are reachable",
    );
  });

  it("family B shows the exact instance plus both corroborating conditions", () => {
    const html = renderHtmlReport(scanOutput({ findings: [FAMILY_B_FINDING] }));

    expect(html).toContain("Family B");
    expect(html).toContain(
      "/proj/node_modules/consumer/node_modules/nested-lib",
    );
    expect(html).toContain("Call graph truncated");
    expect(html).toContain("Module-load closure complete");
    expect(html).toContain(
      "package_instance_absent_from_call_graph_and_module_load_closure",
    );
    // The current reason identifier, read from the merged code -- not an
    // obsolete pre-VT-307e name.
    expect(html).not.toContain(
      "package_instance_absent_from_complete_call_graph",
    );
    expect(html).toContain("independently corroborated");
    // Never describes the call graph as globally complete for family B.
    expect(html).toContain(
      "not the same claim as the call graph being complete",
    );
  });

  it("family C shows the target identity and the exhaustive-search conditions", () => {
    const html = renderHtmlReport(scanOutput({ findings: [FAMILY_C_FINDING] }));

    expect(html).toContain("Family C — confirmed unreachable target");
    expect(html).toContain("loaded-lib#neverCalled");
    // VT-CONTRACT-02: the row names the reachable subgraph the search
    // actually exhausted, never the whole call graph.
    expect(html).toContain("Reachable subgraph complete");
    expect(html).toContain(
      "Scoped to that subgraph, not a claim that the whole call graph is complete",
    );
    expect(html).toContain(
      "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
    );
    expect(html).toContain(
      "Says nothing about whether the package is present or loaded",
    );
  });

  it("never suggests whole-program call-graph completeness for family C (VT-CONTRACT-02)", () => {
    const html = renderHtmlReport(scanOutput({ findings: [FAMILY_C_FINDING] }));

    // The retired label and field name must not appear anywhere in the
    // rendered document -- a reader skimming "Call graph complete" could
    // take it as a claim the analyzer never makes.
    expect(html).not.toContain("Call graph complete");
    expect(html).not.toContain("callGraphComplete");
    // Family B's own row, which legitimately mentions the call graph, is
    // about truncation and is explicitly hedged -- it is untouched here.
    const familyBHtml = renderHtmlReport(
      scanOutput({ findings: [FAMILY_B_FINDING] }),
    );
    expect(familyBHtml).toContain("Call graph truncated");
    expect(familyBHtml).toContain(
      "not the same claim as the call graph being complete",
    );
  });

  it("shows the exact canonical PackageInstance in the overview, not name@version", () => {
    const html = renderHtmlReport(
      scanOutput({ findings: [FAMILY_A_FINDING, FAMILY_B_FINDING] }),
    );

    expect(html).toContain("Package instance");
    expect(html).toContain("/proj/node_modules/unloaded-lib");
    expect(html).toContain(
      "/proj/node_modules/consumer/node_modules/nested-lib",
    );
  });

  it("says the package instance is not in the result rather than substituting one", () => {
    const html = renderHtmlReport(scanOutput({ findings: [FAMILY_C_FINDING] }));

    expect(html).toContain("does not carry a canonical package instance");
    expect(html).toContain("not in result");
  });

  it("does not guess a family for a NOT_AFFECTED with no proof evidence object", () => {
    const html = renderHtmlReport(
      scanOutput({
        findings: [
          {
            vulnerability: "GHSA-legacy",
            package: "legacy-lib",
            version: "1.0.0",
            verdict: "NOT_AFFECTED",
            evidence: {
              path: [],
              reasons: [
                "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
              ],
            },
          },
        ],
      }),
    );

    expect(html).toContain("carries no negative-proof evidence object");
    expect(html).not.toContain("Family A");
    expect(html).not.toContain("Family B —");
    expect(html).not.toContain("Family C —");
  });
});

describe("zero-findings report", () => {
  const html = renderHtmlReport(scanOutput());

  it("renders a complete document that explains the empty result honestly", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("This scan produced no findings");
    expect(html).toContain("not that the project was proved unaffected");
    expect(html).toContain("Analysis coverage");
    expect(html).toContain("Analysis scope / supported model");
  });

  it("omits the interactive controls and detail section when there is nothing to filter", () => {
    expect(html).not.toContain('id="finding-search"');
    expect(html).not.toContain('id="finding-details"');
    expect(html).not.toContain("<article");
  });

  it("renders diagnostics that explain why nothing was analyzed", () => {
    const withDiagnostics = renderHtmlReport(
      scanOutput({
        diagnostics: [
          {
            source: "entrypoints",
            message:
              "no entrypoints were discovered (no analysis.entrypoints configured, and no resolvable package.json main/bin field); nothing could be analyzed",
          },
        ],
      }),
    );

    expect(withDiagnostics).toContain("no entrypoints were discovered");
    expect(withDiagnostics).toContain("entrypoints");
  });
});

describe("module-load closure diagnostics", () => {
  it("surfaces a closure-availability diagnostic verbatim", () => {
    const html = renderHtmlReport(
      scanOutput({
        diagnostics: [
          {
            source: "module-load-closure",
            message:
              "module-load absence proof is unavailable: closure construction failed (boom); findings fall back to call-graph reachability alone",
          },
        ],
      }),
    );

    expect(html).toContain("module-load-closure");
    expect(html).toContain("module-load absence proof is unavailable");
  });
});

describe("result compatibility", () => {
  it("renders every evidence variant from a result that validates against the checked-in schema", () => {
    const output = scanOutput({ findings: ALL_FINDINGS });

    expect(validateScanOutput(output)).toEqual([]);

    const html = renderHtmlReport(output);
    expect(html).toContain("Family A");
    expect(html).toContain("Family B");
    expect(html).toContain("Family C");
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain("undefined:undefined");
  });

  it("renders a finding with no target, evidence or confidence without visual garbage", () => {
    const html = renderHtmlReport(
      scanOutput({
        findings: [
          {
            vulnerability: "GHSA-minimal",
            package: "minimal-lib",
            version: "0.0.1",
            verdict: "UNKNOWN",
          },
        ],
      }),
    );

    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain(">undefined<");
    expect(html).not.toContain(">null<");
    expect(html).not.toContain("NaN");
  });
});
