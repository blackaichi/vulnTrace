import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateScanOutput } from "../cli/output.js";
import {
  type RawScanOutput,
  type Semantics,
  type StubAdvisory,
  cleanupCorpus,
  config,
  installedLib,
  materialize,
  normalizeDeep,
  projectSemantics,
  proofCountOf,
  providerFor,
  rule,
  scanProject,
  under,
} from "./foundation-corpus.js";

/**
 * FOUNDATION F6 — THE OFFLINE SEMANTIC DIFFERENTIAL.
 *
 * A deterministic, network-free corpus that pins the analyzer's SEMANTICS
 * and, unlike the F5 differential it consolidates, proves its own coverage
 * rather than asserting it (F6 § 12–14).
 *
 * THREE THINGS ARE ASSERTED HERE, AND THEY ARE DIFFERENT THINGS.
 *
 * 1. **Per-case semantics.** Each case declares the classes it must
 *    produce — verdicts, proof families, candidate reasons, diagnostic
 *    sources — and the scan must produce them. This is what fails when a
 *    change moves a verdict.
 * 2. **Corpus non-vacuity (§ 14).** Across the corpus, every class the
 *    differential CLAIMS to cover must actually have occurred at least
 *    once. This is what fails when a case silently stops producing the
 *    thing it exists to produce — the exact defect the F5 audit found,
 *    where `unreportedCandidates` was "compared" over a corpus that
 *    produced none.
 * 3. **Determinism (§ 16).** The same project, with its inputs presented
 *    in REVERSED order, must produce the same semantics. Order-dependence
 *    is invisible to a single run.
 *
 * WHY NOT COMPARE AGAINST A STORED SNAPSHOT.
 *
 * A committed baseline of expected output would have to be regenerated
 * whenever any legitimate detail changed, and regenerating a snapshot is
 * indistinguishable from accepting a regression. These assertions are
 * instead statements about SEMANTIC CLASSES, which change only when the
 * analyzer's contract changes — at which point the failure names the
 * class, not a diff.
 *
 * WHAT THIS DOES NOT PROVE. It does not prove the analyzer is sound. It
 * proves that a specific set of Foundation-established distinctions is
 * still drawn, on a corpus small enough to reason about. Real-world
 * evidence lives in `tests/validation/` (live, network-dependent) and in
 * the adversarial suites; neither is a substitute for the other.
 */

/** What a case must produce. Absence of a key means "not asserted". */
interface Expectation {
  readonly verdicts?: readonly string[];
  readonly families?: readonly ("A" | "B" | "C")[];
  readonly candidateReasons?: readonly string[];
  readonly candidateStages?: readonly string[];
  readonly candidateDispositions?: readonly string[];
  readonly diagnosticSources?: readonly string[];
  /** Distinct `packageInstance` values that must all appear in findings. */
  readonly distinctInstances?: number;
}

interface CorpusCase {
  readonly name: string;
  readonly why: string;
  readonly files: Readonly<Record<string, string>>;
  readonly advisories: readonly StubAdvisory[];
  readonly expect: Expectation;
}

const APP_LOCK = (packages: Readonly<Record<string, unknown>>): string =>
  JSON.stringify({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: { "": { name: "app", version: "1.0.0" }, ...packages },
  });

/**
 * The target every fixture's `rules.yml` declares, via {@link rule}.
 *
 * Restated here as the EXPECTED value so a retargeting is caught: the
 * corpus's own declaration is the oracle, and resolution must reproduce
 * it exactly rather than substitute a sibling, drop the kind, or rewrite
 * the rule's confidence.
 */
const DECLARED_TARGET = {
  module: "vuln-lib",
  symbol: "danger",
  kind: "function",
  confidence: 1,
};

const ADVISORY: StubAdvisory = {
  packageName: "vuln-lib",
  id: "GHSA-f6-0001",
  fixed: "9.0.0",
};

// ====================================================================
// THE CORPUS
// ====================================================================

const CORPUS: readonly CorpusCase[] = [
  {
    name: "affected-direct-call",
    why:
      "The positive control. A corpus that never produces AFFECTED would " +
      "pass against an analyzer that answered UNKNOWN to everything.",
    files: {
      "vulntrace.yml": config(["src/index.js"]),
      "rules.yml": "rules:\n" + rule(ADVISORY.id, "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": APP_LOCK({
        "node_modules/vuln-lib": { version: "1.0.0" },
      }),
      ...under("node_modules/vuln-lib", installedLib("vuln-lib", "1.0.0")),
      "src/index.js":
        'const { danger } = require("vuln-lib");\n' +
        "function main(x) { return danger(x); }\n" +
        "module.exports = { main };\n",
    },
    advisories: [ADVISORY],
    expect: { verdicts: ["AFFECTED"] },
  },

  {
    name: "family-a-never-loaded",
    why:
      "NOT_AFFECTED family A: the instance is installed and NOTHING loads " +
      "it, corroborated by a complete module-load closure.",
    files: {
      "vulntrace.yml": config(["src/index.js"]),
      "rules.yml": "rules:\n" + rule(ADVISORY.id, "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": APP_LOCK({
        "node_modules/vuln-lib": { version: "1.0.0" },
      }),
      ...under("node_modules/vuln-lib", installedLib("vuln-lib", "1.0.0")),
      "src/index.js":
        "function main() { return 1; }\nmodule.exports = { main };\n",
    },
    advisories: [ADVISORY],
    expect: { verdicts: ["NOT_AFFECTED"], families: ["A"] },
  },

  {
    name: "family-c-safe-export-only",
    why:
      "NOT_AFFECTED family C: the instance IS loaded and IS called — on its " +
      "safe export. Nothing about presence is claimed; the claim is that " +
      "the resolved target has no call path. This is the opposite premise " +
      "to family A, which is what makes the two non-interchangeable.",
    files: {
      "vulntrace.yml": config(["src/index.js"]),
      "rules.yml": "rules:\n" + rule(ADVISORY.id, "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": APP_LOCK({
        "node_modules/vuln-lib": { version: "1.0.0" },
      }),
      ...under("node_modules/vuln-lib", installedLib("vuln-lib", "1.0.0")),
      "src/index.js":
        'const { safe } = require("vuln-lib");\n' +
        "function main(x) { return safe(x); }\n" +
        "module.exports = { main };\n",
    },
    advisories: [ADVISORY],
    expect: { verdicts: ["NOT_AFFECTED"], families: ["C"] },
  },

  {
    name: "family-b-unreached-twin",
    why:
      "NOT_AFFECTED family B AND exact multi-instance identity in one case: " +
      "two installs of the SAME name and SAME version, one reached and " +
      "AFFECTED, the nested twin never traversed. An analyzer that keyed " +
      "on name or version would return one verdict for both.",
    files: {
      "vulntrace.yml": config(["src/index.js"]),
      "rules.yml": "rules:\n" + rule(ADVISORY.id, "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0", host: "1.0.0" },
      }),
      "package-lock.json": APP_LOCK({
        "node_modules/vuln-lib": { version: "1.0.0" },
        "node_modules/host": { version: "1.0.0" },
        "node_modules/host/node_modules/vuln-lib": { version: "1.0.0" },
      }),
      ...under("node_modules/vuln-lib", installedLib("vuln-lib", "1.0.0")),
      "node_modules/host/package.json": JSON.stringify({
        name: "host",
        version: "1.0.0",
        main: "index.js",
      }),
      "node_modules/host/index.js":
        "function idle() { return 1; }\nmodule.exports = { idle };\n",
      ...under(
        "node_modules/host/node_modules/vuln-lib",
        installedLib("vuln-lib", "1.0.0"),
      ),
      "src/index.js":
        'const { danger } = require("vuln-lib");\n' +
        "function main(x) { return danger(x); }\n" +
        "module.exports = { main };\n",
    },
    advisories: [ADVISORY],
    expect: {
      verdicts: ["AFFECTED", "NOT_AFFECTED"],
      families: ["B"],
      distinctInstances: 2,
    },
  },

  {
    name: "unknown-dynamic-dispatch",
    why:
      "UNKNOWN with structured reasons: the call target is computed at " +
      "runtime, so neither reachability nor its absence can be established. " +
      "F3 requires this to carry classified reasons rather than prose.",
    files: {
      "vulntrace.yml": config(["src/index.js"]),
      "rules.yml": "rules:\n" + rule(ADVISORY.id, "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": APP_LOCK({
        "node_modules/vuln-lib": { version: "1.0.0" },
      }),
      ...under("node_modules/vuln-lib", installedLib("vuln-lib", "1.0.0")),
      "src/index.js":
        'const lib = require("vuln-lib");\n' +
        "function main(name, x) { return lib[name](x); }\n" +
        "module.exports = { main };\n",
    },
    advisories: [ADVISORY],
    expect: { verdicts: ["UNKNOWN"] },
  },

  {
    name: "candidate-not-applicable",
    why:
      "F3's CONCLUSION case: the installed version is outside every affected " +
      "range. Produces no finding, and must be recorded as " +
      "`not_applicable` WITHOUT an uncertainty category — the distinction " +
      "that stops an out-of-range package being counted as an analysis gap. " +
      "Absent from the entire F5 differential corpus.",
    files: {
      "vulntrace.yml": config(["src/index.js"]),
      "rules.yml": "rules:\n" + rule(ADVISORY.id, "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "9.9.9" },
      }),
      "package-lock.json": APP_LOCK({
        "node_modules/vuln-lib": { version: "9.9.9" },
      }),
      ...under("node_modules/vuln-lib", installedLib("vuln-lib", "9.9.9")),
      "src/index.js":
        'const { danger } = require("vuln-lib");\n' +
        "function main(x) { return danger(x); }\n" +
        "module.exports = { main };\n",
    },
    advisories: [ADVISORY],
    expect: {
      candidateReasons: ["advisory_not_applicable_to_installed_version"],
      candidateStages: ["advisory_applicability"],
      candidateDispositions: ["not_applicable"],
    },
  },

  {
    name: "candidate-version-unavailable",
    why:
      "F3's GAP case, and the mirror of the one above: an instance with no " +
      "established version, for which no advisory was discovered at all. " +
      "`undetermined` with a category — nothing is claimed either way. Also " +
      "absent from the F5 corpus.",
    files: {
      "vulntrace.yml": config(["src/index.js"]),
      "rules.yml": "rules:\n" + rule("GHSA-f6-other", "other-lib"),
      // A workspace member with a name and NO version: the realistic
      // shape, a private monorepo package that is never published and so
      // has no version to declare. It is a genuine PackageInstance with
      // genuine identity and no version.
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*"],
      }),
      "package-lock.json": APP_LOCK({}),
      "packages/nover-lib/package.json": JSON.stringify({ name: "nover-lib" }),
      "packages/nover-lib/index.js":
        "function danger(x) { return x; }\nmodule.exports = { danger };\n",
      "src/index.js":
        "function main() { return 1; }\nmodule.exports = { main };\n",
    },
    advisories: [],
    expect: {
      candidateReasons: ["installed_version_unavailable"],
      candidateStages: ["package_identity"],
      candidateDispositions: ["undetermined"],
    },
  },

  {
    name: "candidate-manifest-untrusted",
    why:
      "The DEPENDENCIES diagnostic source, which the F5 corpus never " +
      "produced: an installed manifest whose `version` field is unusable. " +
      "One fact, two channels — an operational diagnostic and a classified " +
      "candidate — which F3 § 16 requires to agree.",
    files: {
      "vulntrace.yml": config(["src/index.js"]),
      "rules.yml": "rules:\n" + rule(ADVISORY.id, "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": APP_LOCK({
        "node_modules/vuln-lib": { version: "1.0.0" },
      }),
      // `"version": 123` parses perfectly well; the FIELD is unusable.
      "node_modules/vuln-lib/package.json": JSON.stringify({
        name: "vuln-lib",
        version: 123,
        main: "index.js",
      }),
      "node_modules/vuln-lib/index.js":
        "function danger(input) { return input; }\n" +
        "function safe(input) { return input; }\n" +
        "module.exports = { danger, safe };\n",
      "src/index.js":
        'const { danger } = require("vuln-lib");\n' +
        "function main(x) { return danger(x); }\n" +
        "module.exports = { main };\n",
    },
    advisories: [ADVISORY],
    expect: {
      candidateReasons: ["installed_manifest_untrusted"],
      candidateStages: ["package_identity"],
      diagnosticSources: ["dependencies"],
    },
  },

  {
    name: "candidate-workspace-incomplete",
    why:
      "The WORKSPACES diagnostic source, also never produced by the F5 " +
      "corpus: a declared workspace pattern this analyzer declines to " +
      "interpret. The candidate names NO package deliberately — what is " +
      "missing is precisely the set nobody enumerated.",
    files: {
      "vulntrace.yml": config(["src/index.js"]),
      "rules.yml": "rules:\n" + rule(ADVISORY.id, "vuln-lib"),
      "package.json": JSON.stringify({
        name: "app",
        version: "1.0.0",
        workspaces: ["packages/*", "!packages/excluded"],
        dependencies: { "vuln-lib": "1.0.0" },
      }),
      "package-lock.json": APP_LOCK({
        "node_modules/vuln-lib": { version: "1.0.0" },
      }),
      ...under("node_modules/vuln-lib", installedLib("vuln-lib", "1.0.0")),
      "packages/member/package.json": JSON.stringify({
        name: "member",
        version: "1.0.0",
        main: "index.js",
      }),
      "packages/member/index.js": "module.exports = {};\n",
      "src/index.js":
        'const { danger } = require("vuln-lib");\n' +
        "function main(x) { return danger(x); }\n" +
        "module.exports = { main };\n",
    },
    advisories: [ADVISORY],
    expect: {
      candidateStages: ["workspace_discovery"],
      diagnosticSources: ["workspaces"],
    },
  },
];

// ====================================================================
// EXECUTION
// ====================================================================

interface CaseResult {
  readonly name: string;
  readonly semantics: Semantics;
  readonly output: RawScanOutput;
}

const results = new Map<string, CaseResult>();

async function runCase(
  corpusCase: CorpusCase,
  options: { readonly reversed?: boolean } = {},
): Promise<CaseResult> {
  const files = { ...corpusCase.files };
  if (options.reversed) {
    // REVERSE the order the rules are declared in. The analyzer's output
    // must be a function of what it found, not of the order it was told
    // about it (F6 § 16).
    const rulesText = files["rules.yml"];
    if (rulesText !== undefined) {
      const entries = rulesText
        .replace(/^rules:\n/, "")
        .split(/(?=^ {2}- id:)/m)
        .filter((entry) => entry.trim().length > 0);
      files["rules.yml"] = "rules:\n" + [...entries].reverse().join("");
    }
  }
  const root = materialize(
    `${corpusCase.name}${options.reversed ? "-rev" : ""}`,
    files,
  );
  const advisories = options.reversed
    ? [...corpusCase.advisories].reverse()
    : corpusCase.advisories;
  const { provider, queries } = providerFor(advisories);
  const { output } = await scanProject(root, provider);
  const token = `ROOT:${corpusCase.name}`;
  const normalized = normalizeDeep(output, root, token);
  return {
    name: corpusCase.name,
    semantics: projectSemantics(normalized, queries),
    output: normalized,
  };
}

beforeAll(async () => {
  for (const corpusCase of CORPUS) {
    results.set(corpusCase.name, await runCase(corpusCase));
  }
}, 180_000);

afterAll(() => {
  cleanupCorpus();
});

function resultFor(name: string): CaseResult {
  const result = results.get(name);
  if (!result) {
    throw new Error(`corpus case "${name}" did not run`);
  }
  return result;
}

/** Everything a failure needs in order to be actionable. */
function describeCase(result: CaseResult): string {
  return JSON.stringify(result.semantics, undefined, 2);
}

// ====================================================================
// 1. PER-CASE SEMANTICS
// ====================================================================

describe("offline differential: each case produces the semantics it claims", () => {
  for (const corpusCase of CORPUS) {
    describe(corpusCase.name, () => {
      it("produces the expected verdicts, families, candidates and sources", () => {
        const result = resultFor(corpusCase.name);
        const { semantics } = result;
        const expectation = corpusCase.expect;

        if (expectation.verdicts) {
          const actual = [
            ...new Set(semantics.findings.map((finding) => finding.verdict)),
          ].sort();
          expect(
            actual,
            `VERDICT SET CHANGED\n` +
              `  invariant: ${corpusCase.why}\n` +
              `  case:      ${corpusCase.name}\n` +
              `  expected:  ${[...expectation.verdicts].sort().join(", ")}\n` +
              `  actual:    ${actual.join(", ")}\n${describeCase(result)}`,
          ).toEqual([...expectation.verdicts].sort());
        }

        if (expectation.families) {
          const actual = semantics.findings
            .map((finding) => finding.family)
            .filter((family): family is "A" | "B" | "C" => family !== null);
          for (const family of expectation.families) {
            expect(
              actual,
              `PROOF FAMILY MISSING\n` +
                `  invariant: ${corpusCase.why}\n` +
                `  case:      ${corpusCase.name}\n` +
                `  expected:  a family ${family} negative proof\n` +
                `  actual:    families ${actual.join(", ") || "(none)"}\n${describeCase(result)}`,
            ).toContain(family);
          }
        }

        if (expectation.candidateReasons) {
          const actual = semantics.candidates.map(
            (candidate) => candidate.reason,
          );
          for (const reason of expectation.candidateReasons) {
            expect(
              actual,
              `UNREPORTED CANDIDATE MISSING\n` +
                `  invariant: ${corpusCase.why}\n` +
                `  case:      ${corpusCase.name}\n` +
                `  expected:  a candidate with reason "${reason}"\n` +
                `  actual:    ${actual.join(", ") || "(no candidates at all)"}\n${describeCase(result)}`,
            ).toContain(reason);
          }
        }

        if (expectation.candidateStages) {
          const actual = semantics.candidates.map(
            (candidate) => candidate.stage,
          );
          for (const stage of expectation.candidateStages) {
            expect(
              actual,
              `CANDIDATE STAGE MISSING\n  case: ${corpusCase.name}\n` +
                `  expected: stage "${stage}"\n  actual: ${actual.join(", ") || "(none)"}`,
            ).toContain(stage);
          }
        }

        if (expectation.candidateDispositions) {
          const actual = semantics.candidates.map(
            (candidate) => candidate.disposition,
          );
          for (const disposition of expectation.candidateDispositions) {
            expect(
              actual,
              `CANDIDATE DISPOSITION MISSING\n  case: ${corpusCase.name}\n` +
                `  expected: "${disposition}"\n  actual: ${actual.join(", ") || "(none)"}`,
            ).toContain(disposition);
          }
        }

        if (expectation.diagnosticSources) {
          const actual = Object.keys(semantics.diagnosticSources);
          for (const source of expectation.diagnosticSources) {
            expect(
              actual,
              `DIAGNOSTIC SOURCE MISSING\n` +
                `  invariant: ${corpusCase.why}\n` +
                `  case:      ${corpusCase.name}\n` +
                `  expected:  at least one diagnostic from "${source}"\n` +
                `  actual:    ${actual.join(", ") || "(no diagnostics)"}\n${describeCase(result)}`,
            ).toContain(source);
          }
        }

        if (expectation.distinctInstances !== undefined) {
          const instances = new Set(
            semantics.findings
              .map((finding) => finding.packageInstance)
              .filter((instance): instance is string => instance !== null),
          );
          expect(
            instances.size,
            `PACKAGE INSTANCE COLLISION\n` +
              `  invariant: one finding names one exact PackageInstance\n` +
              `  case:      ${corpusCase.name}\n` +
              `  expected:  ${expectation.distinctInstances} distinct instances\n` +
              `  actual:    ${[...instances].join(", ")}\n${describeCase(result)}`,
          ).toBe(expectation.distinctInstances);
        }
      });

      it("binds every negative proof to the finding's own instance", () => {
        // VT-CONTRACT-01 plus F4's binding rule, asserted on every case
        // rather than only where a proof is expected: a proof appearing
        // where none should is as much a defect as one going missing.
        //
        // Families A and B name an INSTANCE, and it must be the finding's
        // own. Family C names a TARGET instead -- deliberately, since its
        // claim is about a resolved target's unreachability and not about
        // an instance's presence -- so the binding it must satisfy is a
        // different one, asserted below rather than skipped.
        const result = resultFor(corpusCase.name);
        for (const finding of result.semantics.findings) {
          if (finding.verdict === "NOT_AFFECTED") {
            expect(
              finding.family,
              `a NOT_AFFECTED carries no single negative proof\n  case: ${corpusCase.name}\n${describeCase(result)}`,
            ).not.toBeNull();

            if (finding.family === "C") {
              expect(
                finding.proofTarget,
                `FAMILY C PROOF NAMES NO TARGET\n  case: ${corpusCase.name}\n${describeCase(result)}`,
              ).not.toBeNull();
              expect(
                finding.reachableSubgraphComplete,
                `VT-CONTRACT-02 VIOLATED\n` +
                  `  invariant: family C rests on the REACHABLE SUBGRAPH being complete\n` +
                  `  case:      ${corpusCase.name}\n` +
                  `  expected:  reachableSubgraphComplete === true\n` +
                  `  actual:    ${finding.reachableSubgraphComplete}`,
              ).toBe(true);
              expect(
                finding.proofInstance,
                `family C must not claim an instance -- that is family A/B's ` +
                  `claim, and borrowing it would overstate what C proves`,
              ).toBeNull();
              continue;
            }

            // A and B: the proof's absolute instance must be exactly the
            // finding's own, once the normalized root token is removed.
            const bare = (finding.proofInstance ?? "").replace(
              /^<ROOT:[^>]+>\//,
              "",
            );
            expect(
              bare,
              `PROOF BINDING VIOLATED\n` +
                `  invariant: a proof about instance A never certifies instance B\n` +
                `  case:      ${corpusCase.name}\n` +
                `  family:    ${finding.family}\n` +
                `  expected:  proof names ${finding.packageInstance}\n` +
                `  actual:    proof names ${finding.proofInstance}`,
            ).toBe(finding.packageInstance);
          } else {
            expect(
              finding.family,
              `a ${finding.verdict} carries a negative proof\n  case: ${corpusCase.name}`,
            ).toBeNull();
          }
        }
      });

      it("carries exactly one proof object on NOT_AFFECTED and none otherwise", () => {
        const result = resultFor(corpusCase.name);
        for (const finding of result.output.findings) {
          expect(
            proofCountOf(finding),
            `VT-CONTRACT-01 VIOLATED\n  case: ${corpusCase.name}\n` +
              `  expected: ${finding.verdict === "NOT_AFFECTED" ? 1 : 0} proof object(s)\n` +
              `  actual:   ${proofCountOf(finding)}`,
          ).toBe(finding.verdict === "NOT_AFFECTED" ? 1 : 0);
        }
      });

      it("reports the advisory's declared target and a matching confidence", () => {
        // VALUE assertions, not merely presence. The differential's other
        // comparisons are run-against-run, so a change that moved EVERY
        // confidence or retargeted EVERY finding would shift both sides
        // equally and stay green -- which is exactly what a first attempt
        // at this coverage did. Pinning the expected values is what makes
        // the two fields gated rather than merely carried.
        const result = resultFor(corpusCase.name);
        for (const finding of result.semantics.findings) {
          // The target is the one the fixture's own rules.yml declares.
          // It must survive resolution unchanged: same module specifier,
          // same exported symbol, same kind, same rule confidence.
          expect(
            finding.target,
            `TARGET CHANGED\n` +
              `  invariant: a finding reports the advisory target its rule declared\n` +
              `  case:      ${corpusCase.name} (${finding.vulnerability})\n` +
              `  expected:  ${JSON.stringify(DECLARED_TARGET)}\n` +
              `  actual:    ${JSON.stringify(finding.target)}`,
          ).toEqual(DECLARED_TARGET);

          // Confidence tracks the VERDICT: an AFFECTED is a positive claim
          // and carries one; a NOT_AFFECTED rests on a negative proof and
          // an UNKNOWN claims nothing, so neither does.
          const expected = finding.verdict === "AFFECTED" ? 1 : null;
          expect(
            finding.confidence,
            `CONFIDENCE CHANGED\n` +
              `  invariant: an AFFECTED carries confidence; other verdicts do not\n` +
              `  case:      ${corpusCase.name} (${finding.verdict})\n` +
              `  expected:  ${expected}\n` +
              `  actual:    ${finding.confidence}`,
          ).toBe(expected);
        }
      });

      it("never presents an UNKNOWN without structured reasons", () => {
        const result = resultFor(corpusCase.name);
        for (const finding of result.semantics.findings) {
          if (finding.verdict === "UNKNOWN") {
            expect(
              finding.unknownReasons.length,
              `F3 VIOLATED: an UNKNOWN with no structured reason\n  case: ${corpusCase.name}\n${describeCase(result)}`,
            ).toBeGreaterThan(0);
            for (const category of finding.unknownCategories) {
              expect(
                category,
                `an unknown reason carries no category\n  case: ${corpusCase.name}`,
              ).not.toBe("(none)");
            }
          }
        }
      });

      it("keeps candidate dispositions and categories structurally consistent", () => {
        // F3's single most important structural rule: a `category` is
        // present IF AND ONLY IF the disposition is `undetermined`.
        const result = resultFor(corpusCase.name);
        for (const candidate of result.semantics.candidates) {
          if (candidate.disposition === "not_applicable") {
            expect(
              candidate.category,
              `F3 VIOLATED: a confident not_applicable carries an uncertainty ` +
                `category, so a consumer summing categories would count it as ` +
                `an analysis gap\n  case: ${corpusCase.name}\n  candidate: ${JSON.stringify(candidate)}`,
            ).toBeNull();
          } else {
            expect(
              candidate.category,
              `F3 VIOLATED: an undetermined candidate carries no category\n` +
                `  case: ${corpusCase.name}\n  candidate: ${JSON.stringify(candidate)}`,
            ).not.toBeNull();
          }
        }
      });

      it("never emits a candidate as a finding, or a finding as a candidate", () => {
        // F3 § 25: the two arrays are separate BY CONSTRUCTION. A
        // candidate has no verdict and no evidence; promoting one would be
        // exactly the unproven negative AGENTS.md forbids.
        const result = resultFor(corpusCase.name);
        for (const candidate of result.output.unreportedCandidates) {
          expect(Object.keys(candidate)).not.toContain("verdict");
          expect(Object.keys(candidate)).not.toContain("evidence");
          expect(Object.keys(candidate)).not.toContain("confidence");
        }
      });
    });
  }
});

// ====================================================================
// 2. CORPUS NON-VACUITY (F6 § 14)
// ====================================================================

describe("offline differential: the corpus is non-vacuous", () => {
  function all(): readonly Semantics[] {
    return [...results.values()].map((result) => result.semantics);
  }

  it("produces every verdict at least once", () => {
    const verdicts = new Set(
      all().flatMap((semantics) =>
        semantics.findings.map((finding) => finding.verdict),
      ),
    );
    for (const verdict of ["AFFECTED", "NOT_AFFECTED", "UNKNOWN"]) {
      expect(
        verdicts.has(verdict),
        `NON-VACUITY FAILED\n` +
          `  invariant: the differential exercises every verdict\n` +
          `  expected:  at least one ${verdict}\n` +
          `  actual:    ${[...verdicts].join(", ") || "(no findings at all)"}`,
      ).toBe(true);
    }
  });

  it("produces all three negative-proof families at least once", () => {
    const families = new Set(
      all().flatMap((semantics) =>
        semantics.findings
          .map((finding) => finding.family)
          .filter((family): family is "A" | "B" | "C" => family !== null),
      ),
    );
    for (const family of ["A", "B", "C"] as const) {
      expect(
        families.has(family),
        `NON-VACUITY FAILED\n` +
          `  invariant: the differential exercises every negative-proof family\n` +
          `  expected:  at least one family ${family} proof\n` +
          `  actual:    families ${[...families].sort().join(", ") || "(none)"}\n` +
          `  why it matters: negative proofs are exactly what a caching or\n` +
          `  identity defect would fabricate. A corpus that produces none\n` +
          `  cannot detect one.`,
      ).toBe(true);
    }
  });

  it("produces unreportedCandidates -- the first F5 coverage gap", () => {
    const total = all().reduce(
      (sum, semantics) => sum + semantics.candidates.length,
      0,
    );
    expect(
      total,
      `NON-VACUITY FAILED\n` +
        `  invariant: the differential actually compares unreportedCandidates\n` +
        `  expected:  more than zero across the corpus\n` +
        `  actual:    ${total}\n` +
        `  why it matters: F5's 15-fixture differential produced ZERO, so its\n` +
        `  claim to compare this array was true of the mechanism and empty of\n` +
        `  evidence (RWF-038). This assertion is what stops that recurring.`,
    ).toBeGreaterThan(0);
  });

  it("covers every required unreportedCandidate class", () => {
    const reasons = new Set(
      all().flatMap((semantics) =>
        semantics.candidates.map((candidate) => candidate.reason),
      ),
    );
    const REQUIRED = [
      // The GAP: an instance whose version was never established.
      "installed_version_unavailable",
      // The CONCLUSION: confidently out of range. Not an uncertainty.
      "advisory_not_applicable_to_installed_version",
      // An identity gap from unusable installed metadata.
      "installed_manifest_untrusted",
    ];
    for (const reason of REQUIRED) {
      expect(
        reasons.has(reason),
        `NON-VACUITY FAILED\n` +
          `  invariant: every candidate class F6 claims to cover occurs\n` +
          `  expected:  a candidate with reason "${reason}"\n` +
          `  actual:    ${[...reasons].sort().join(", ") || "(none)"}`,
      ).toBe(true);
    }
  });

  it("covers both candidate dispositions and every stage", () => {
    const dispositions = new Set(
      all().flatMap((semantics) =>
        semantics.candidates.map((candidate) => candidate.disposition),
      ),
    );
    expect(dispositions).toEqual(new Set(["not_applicable", "undetermined"]));

    const stages = new Set(
      all().flatMap((semantics) =>
        semantics.candidates.map((candidate) => candidate.stage),
      ),
    );
    for (const stage of [
      "workspace_discovery",
      "package_identity",
      "advisory_applicability",
    ]) {
      expect(
        stages.has(stage),
        `NON-VACUITY FAILED\n  expected: a candidate at stage "${stage}"\n` +
          `  actual: ${[...stages].sort().join(", ")}`,
      ).toBe(true);
    }
  });

  it("covers multiple diagnostic sources -- the second F5 coverage gap", () => {
    const sources = new Set(
      all().flatMap((semantics) => Object.keys(semantics.diagnosticSources)),
    );
    const REQUIRED = ["call-graph", "workspaces", "dependencies"];
    for (const source of REQUIRED) {
      expect(
        sources.has(source),
        `NON-VACUITY FAILED\n` +
          `  invariant: the differential exercises more than one diagnostic source\n` +
          `  expected:  at least one diagnostic from "${source}"\n` +
          `  actual:    ${[...sources].sort().join(", ") || "(none)"}\n` +
          `  why it matters: all 2,240 diagnostics in F5's differential came\n` +
          `  from call-graph alone, so the workspace and dependency-metadata\n` +
          `  channels were compared against nothing (RWF-038).`,
      ).toBe(true);
    }
    expect(
      sources.size,
      `the corpus must exercise more than one diagnostic source`,
    ).toBeGreaterThan(1);
  });

  it("produces findings that name more than one distinct instance", () => {
    const instances = new Set(
      all().flatMap((semantics) =>
        semantics.findings
          .map((finding) => finding.packageInstance)
          .filter((instance): instance is string => instance !== null),
      ),
    );
    expect(
      instances.size,
      `NON-VACUITY FAILED\n  invariant: exact multi-instance identity is exercised\n` +
        `  expected: more than one distinct packageInstance across the corpus\n` +
        `  actual:   ${[...instances].join(", ")}`,
    ).toBeGreaterThan(1);
  });

  it("compares a real confidence value, not a column of nulls", () => {
    // A field added to the projection is only compared if the corpus
    // actually produces one. This is the same non-vacuity discipline the
    // candidate and diagnostic assertions apply, turned on the two fields
    // an independent audit found missing from the comparison entirely.
    const confidences = all().flatMap((semantics) =>
      semantics.findings.map((finding) => finding.confidence),
    );
    expect(
      confidences.some((value) => value !== null),
      `NON-VACUITY FAILED\n` +
        `  invariant: the differential compares finding confidence\n` +
        `  expected:  at least one finding carrying a confidence value\n` +
        `  actual:    ${JSON.stringify(confidences)}`,
    ).toBe(true);
  });

  it("compares a real resolved target, not a column of nulls", () => {
    const targets = all().flatMap((semantics) =>
      semantics.findings.map((finding) => finding.target),
    );
    const named = targets.filter(
      (target) =>
        target !== null && target.module !== "" && target.symbol !== "",
    );
    expect(
      named.length,
      `NON-VACUITY FAILED\n` +
        `  invariant: the differential compares the finding's own target\n` +
        `  expected:  at least one finding naming module and symbol\n` +
        `  actual:    ${JSON.stringify(targets)}`,
    ).toBeGreaterThan(0);
  });

  it("produces at least one AFFECTED carrying a witness path", () => {
    // An AFFECTED with no path would be an assertion without evidence,
    // and it is the positive control for the whole corpus.
    const paths = all().flatMap((semantics) =>
      semantics.findings
        .filter((finding) => finding.verdict === "AFFECTED")
        .map((finding) => finding.pathLength),
    );
    expect(
      paths.some((length) => length !== null && length > 0),
      `NON-VACUITY FAILED: no AFFECTED finding carries a call path\n` +
        `  actual path lengths: ${JSON.stringify(paths)}`,
    ).toBe(true);
  });
});

// ====================================================================
// 3. DETERMINISM AND ORDERING (F6 § 16)
// ====================================================================

describe("offline differential: output is deterministic", () => {
  it.each(CORPUS.map((corpusCase) => corpusCase.name))(
    "%s produces identical semantics when re-run",
    async (name) => {
      const corpusCase = CORPUS.find((entry) => entry.name === name);
      const again = await runCase(corpusCase as CorpusCase);
      expect(
        again.semantics,
        `NON-DETERMINISM\n  case: ${name}\n  the same project scanned twice ` +
          `produced different semantics`,
      ).toEqual(resultFor(name).semantics);
    },
    180_000,
  );

  it.each(CORPUS.map((corpusCase) => corpusCase.name))(
    "%s is unchanged when its inputs are presented in reverse order",
    async (name) => {
      const corpusCase = CORPUS.find((entry) => entry.name === name);
      const reversed = await runCase(corpusCase as CorpusCase, {
        reversed: true,
      });
      expect(
        reversed.semantics,
        `INPUT-ORDER DEPENDENCE\n` +
          `  invariant: output is a function of WHAT was analysed, not of the\n` +
          `             order the analyzer was told about it (F6 s 16)\n` +
          `  case:      ${name}\n` +
          `  The rules and advisories were declared in reverse order and the\n` +
          `  findings, proofs, unknownReasons, candidates or diagnostics moved.`,
      ).toEqual(resultFor(name).semantics);
    },
    180_000,
  );
});

// ====================================================================
// 4. PATH NORMALIZATION SAFETY (F6 § 17)
// ====================================================================

describe("path normalization preserves instance identity", () => {
  it("keeps two same-name, same-version twins distinguishable", () => {
    // THE assertion F6 § 17 asks for. An earlier harness normalized paths
    // to make mkdtemp roots comparable; normalization that went one step
    // further and collapsed paths entirely would make PackageInstance A
    // and PackageInstance B compare EQUAL -- and the differential would
    // then certify precisely the identity defect it exists to catch.
    const result = resultFor("family-b-unreached-twin");
    const instances = result.semantics.findings
      .map((finding) => finding.packageInstance)
      .filter((instance): instance is string => instance !== null);

    expect(new Set(instances).size).toBe(2);
    expect(instances).toContain("node_modules/vuln-lib");
    expect(instances).toContain("node_modules/host/node_modules/vuln-lib");

    // ...and the two really are the same name AND version, so nothing but
    // the PATH distinguishes them.
    const versions = new Set(
      result.semantics.findings.map((finding) => finding.version),
    );
    expect(versions).toEqual(new Set(["1.0.0"]));
  });

  it("normalizes the temp root without touching anything below it", () => {
    // Bijectivity, stated directly: the root prefix is replaced, every
    // suffix survives byte for byte, and no absolute temp path leaks.
    for (const [name, result] of results) {
      const serialized = JSON.stringify(result.output);
      expect(
        serialized,
        `case "${name}" leaked an absolute temp path into its output, so the ` +
          `comparison is machine-dependent`,
      ).not.toMatch(/vulntrace-f6-[a-z-]+-[A-Za-z0-9]{6}/);
    }
  });

  it("rewrites only the root, so distinct suffixes stay distinct", () => {
    // A direct unit check of the mapping itself, independent of any scan.
    const root = "/tmp/vulntrace-f6-probe-AbCdEf";
    const a = `${root}/node_modules/vuln-lib`;
    const b = `${root}/node_modules/host/node_modules/vuln-lib`;
    const normalizedA = normalizeDeep({ p: a }, root, "R").p;
    const normalizedB = normalizeDeep({ p: b }, root, "R").p;
    expect(normalizedA).toBe("<R>/node_modules/vuln-lib");
    expect(normalizedB).toBe("<R>/node_modules/host/node_modules/vuln-lib");
    expect(
      normalizedA,
      "normalization collapsed two distinct instances into one token",
    ).not.toBe(normalizedB);
  });
});

// ====================================================================
// 5. SCHEMA (F6 § 18)
// ====================================================================

/**
 * Validated with the PRODUCTION validator (`validateScanOutput`), not a
 * locally-constructed Ajv instance. A second validator configured slightly
 * differently — a different draft, `strict` off — would be a second oracle
 * that could disagree with the one the CLI actually enforces, and the
 * disagreement would favour passing.
 *
 * What this adds over the existing schema suite: those cases construct
 * output objects directly, which is the right way to test rejection and
 * old-compatible acceptance (owned by `cli/result-schema.negative-proof.test.ts`,
 * including the pre-F3 additivity cases). These are REAL outputs from the
 * real pipeline, carrying all three verdicts, all three proof families and
 * populated `unreportedCandidates` — so a producer that emits something the
 * schema forbids is caught even though no test ever wrote that shape by hand.
 */
describe("every corpus output satisfies the published result schema", () => {
  it.each(CORPUS.map((corpusCase) => corpusCase.name))(
    "%s validates against schemas/result.schema.json",
    (name) => {
      const result = resultFor(name);
      const issues = validateScanOutput(result.output);
      expect(
        issues,
        `SCHEMA DRIFT\n` +
          `  invariant: every scan output validates against the published schema\n` +
          `  case:      ${name}\n` +
          `  expected:  no validation issues\n` +
          `  actual:    ${JSON.stringify(issues, undefined, 2)}`,
      ).toEqual([]);
    },
  );

  it("validates outputs that actually carry the interesting shapes", () => {
    // Guards the guard. Validating nine documents that all happen to be
    // minimal would pass against a schema that constrains nothing of
    // interest, so this asserts the corpus really did put every shape
    // Part 18 names in front of the validator.
    const outputs = [...results.values()].map((result) => result.output);
    const verdicts = new Set(
      outputs.flatMap((output) =>
        output.findings.map((finding) => finding.verdict),
      ),
    );
    expect(verdicts).toEqual(new Set(["AFFECTED", "NOT_AFFECTED", "UNKNOWN"]));
    expect(
      outputs.some((output) =>
        output.findings.some(
          (finding) =>
            finding.evidence?.confirmedAbsentFromModuleLoadClosure !==
            undefined,
        ),
      ),
      "no family A proof was put in front of the schema",
    ).toBe(true);
    expect(
      outputs.some((output) =>
        output.findings.some(
          (finding) => finding.evidence?.confirmedAbsentInstance !== undefined,
        ),
      ),
      "no family B proof was put in front of the schema",
    ).toBe(true);
    expect(
      outputs.some((output) =>
        output.findings.some(
          (finding) =>
            finding.evidence?.confirmedUnreachableTarget !== undefined,
        ),
      ),
      "no family C proof was put in front of the schema",
    ).toBe(true);
    expect(
      outputs.some((output) => output.unreportedCandidates.length > 0),
      "no populated unreportedCandidates array was put in front of the schema",
    ).toBe(true);
  });
});
