import { describe, expect, it } from "vitest";
import { renderHtmlReport } from "./html-report.js";
import { SCHEMA_VERSION, type ScanOutput } from "./output.js";

/**
 * FOUNDATION F3 § 23 -- the report exposes the taxonomy, and does NOT
 * present unreported candidates as vulnerabilities.
 *
 * The second half is self-review attack N and is the reason this file
 * exists separately from `html-report.test.ts`. A reader skimming headings
 * is exactly who would mistake a "candidates" table for a findings table,
 * and the failure mode is bad in the worst direction: someone chasing a
 * patched package because a report implied it was vulnerable.
 */

const EMPTY_COVERAGE = {
  files: 0,
  modulesResolved: 0,
  modulesUnresolved: 0,
  functions: 0,
  callsResolved: 0,
  callsDynamic: 0,
};

const EMPTY_TIMINGS = {
  parsingMs: 0,
  resolutionMs: 0,
  graphConstructionMs: 0,
  reachabilityMs: 0,
  providerMs: 0,
  cacheHits: 0,
  cacheMisses: 0,
  totalMs: 0,
};

function scanOutput(partial: Partial<ScanOutput> = {}): ScanOutput {
  return {
    schemaVersion: SCHEMA_VERSION,
    scan: { id: "scan-f3", project: "." },
    findings: [],
    coverage: EMPTY_COVERAGE,
    diagnostics: [],
    unreportedCandidates: [],
    timings: EMPTY_TIMINGS,
    ...partial,
  };
}

describe("F3 § 23: UNKNOWN categories are exposed", () => {
  const output = scanOutput({
    findings: [
      {
        vulnerability: "GHSA-f3-html",
        package: "vuln-lib",
        version: "1.0.0",
        verdict: "UNKNOWN",
        evidence: {
          path: [],
          reasons: ["eval at node_modules/vuln-lib/index.js:3"],
        },
        unknownReasons: [
          {
            category: "unmodeled_construct",
            reason: "unsupported_construct",
            count: 47,
          },
          { category: "capability_escape", reason: "eval", count: 1 },
        ],
      },
    ],
  });

  it("renders the category token and a readable label for it", () => {
    const html = renderHtmlReport(output);
    expect(html).toContain("capability_escape");
    // F3 § 22: never a bare enum. The token is what a reader greps for;
    // the label is what tells them what it means.
    expect(html).toContain("Runtime capabilities that escape static analysis");
    expect(html).toContain("Constructs this analyzer does not model yet");
  });

  it("renders every reason, with counts, and elects no primary cause", () => {
    const html = renderHtmlReport(output);
    expect(html).toContain("unsupported_construct");
    expect(html).toContain("eval");
    expect(html).toContain("47");
    // F3 § 20: no "main cause" styling, no truncation, no "and 1 more".
    expect(html).not.toContain("primary");
    expect(html).toContain("No single cause is singled out");
  });

  it("keeps the verbatim prose blockers alongside the classification", () => {
    const html = renderHtmlReport(output);
    // F3 § 6: structure does not replace detail.
    expect(html).toContain("node_modules/vuln-lib/index.js:3");
  });

  it("no longer claims an early UNKNOWN has no recorded reason", () => {
    // The pre-F3 fallback paragraph guessed, in prose, which of two causes
    // produced an evidence-less UNKNOWN. A classified finding must not
    // reach it.
    const html = renderHtmlReport(
      scanOutput({
        findings: [
          {
            vulnerability: "GHSA-f3-html",
            package: "vuln-lib",
            verdict: "UNKNOWN",
            unknownReasons: [
              {
                category: "identity_unresolved",
                reason: "advisory_version_applicability_indeterminate",
                count: 1,
              },
            ],
          },
        ],
      }),
    );
    expect(html).not.toContain("records no reason for this UNKNOWN finding");
    expect(html).toContain("advisory_version_applicability_indeterminate");
  });
});

describe("F3 § 23 / attack N: unreported candidates are not presented as vulnerabilities", () => {
  const output = scanOutput({
    unreportedCandidates: [
      {
        stage: "advisory_applicability",
        disposition: "not_applicable",
        vulnerability: "GHSA-f3-html",
        package: "semver",
        packageInstance: "node_modules/semver",
        version: "7.5.2",
        reason: "advisory_not_applicable_to_installed_version",
        detail:
          "installed version 7.5.2 is outside every affected range declared by GHSA-f3-html, so this advisory does not apply to this instance; no reachability analysis was performed and this is not a proof of non-reachability",
      },
      {
        stage: "workspace_discovery",
        disposition: "undetermined",
        reason: "workspace_enumeration_truncated",
        category: "budget_exceeded",
        detail: "workspace pattern could not be enumerated completely",
      },
    ],
  });

  it("renders them in their own section, outside the findings sections", () => {
    const html = renderHtmlReport(output);
    expect(html).toContain('id="unreported-candidates"');

    // Structurally outside `#findings` and `#finding-details`: with no
    // findings at all, neither detail section is even emitted, yet the
    // candidates section is.
    expect(html).not.toContain('id="finding-details"');
    expect(html).toContain("Candidates with no finding");
  });

  it("states the negative explicitly, for a reader who skims headings", () => {
    const html = renderHtmlReport(output);
    expect(html).toContain(
      "<strong>Nothing in this section is a reported vulnerability.</strong>",
    );
  });

  it("never implies a not_applicable entry is a proof of safety", () => {
    const html = renderHtmlReport(output);
    // Says what it actually means -- a statement about version ranges.
    expect(html).toContain("Does not apply");
    expect(html).toContain("outside every affected range");
    expect(html).toContain("not</em> proofs of non-reachability");

    // The section DOES name NOT_AFFECTED -- in the sentence denying it.
    // That is the point: the clarification has to be where the reader is,
    // not in a doc comment. What must be absent is any VERDICT MARKUP that
    // would make a row look like a result.
    const section = html.slice(html.indexOf('id="unreported-candidates"'));
    const candidatesSection = section.slice(0, section.indexOf("</section>"));

    expect(candidatesSection).toContain("are <em>not</em> proofs");
    expect(candidatesSection).toContain("not NOT_AFFECTED verdicts");
    // No badge, no glyph, no verdict-coloured row: the three things that
    // make something read as a finding in this report.
    expect(candidatesSection).not.toContain("badge");
    expect(candidatesSection).not.toContain("data-verdict");
    expect(candidatesSection).not.toContain("▲");
  });

  it("does not count them in the verdict summary", () => {
    const html = renderHtmlReport(output);
    // No findings exist, so the report must still say so plainly rather
    // than letting two candidate rows look like two results.
    expect(html).toContain("This scan produced no findings");
  });

  it("is omitted entirely when there is nothing to report", () => {
    const html = renderHtmlReport(scanOutput());
    expect(html).not.toContain('id="unreported-candidates"');
  });

  it("escapes candidate content exactly once, like every other channel", () => {
    const html = renderHtmlReport(
      scanOutput({
        unreportedCandidates: [
          {
            stage: "package_identity",
            disposition: "undetermined",
            package: "<script>alert(1)</script>",
            reason: "installed_version_conflicted",
            category: "identity_unresolved",
            detail: "<img src=x onerror=alert(1)>",
          },
        ],
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});
