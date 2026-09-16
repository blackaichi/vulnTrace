import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION, validateScanOutput } from "./output.js";

/**
 * FOUNDATION F6 — the deterministic owner of SCHEMA ADDITIVITY.
 *
 * THE INVARIANT, stated precisely, because it is easy to confuse with a
 * different one: a result a consumer would have accepted BEFORE a later
 * Foundation task added its fields must STILL validate against
 * `schemas/result.schema.json`. The new structured output (F3's
 * `unknownReasons` and `unreportedCandidates`) is ADDITIVE — neither key
 * is `required`, so an archived pre-F3 result, and a producer that never
 * emits them, both remain valid.
 *
 * This is NOT the negative-proof shape contract. VT-CONTRACT-01/02 —
 * exactly one negative proof on a NOT_AFFECTED, none on any other verdict,
 * family C's own evidence shape — is a different invariant with a
 * different owner (`result-schema.negative-proof.test.ts`). Conflating the
 * two is exactly the mistake an independent audit of F6 found: the
 * invariant map named that file as the owner of additivity, and it does
 * not test additivity at all. This file exists so the map can name
 * something that does.
 *
 * Extracted wholesale from `output.test.ts` rather than rewritten, so the
 * assertions are the same ones that have been running since F3 — moved,
 * not duplicated, and not reimplemented. It reaches the schema only
 * through the PRODUCTION validator (`validateScanOutput`), never a
 * locally-configured Ajv instance that could be more permissive than the
 * one the CLI enforces.
 *
 * Both directions are covered, which is what makes it a real gate rather
 * than an acceptance rubber-stamp: legacy-shaped output must be ACCEPTED,
 * and malformed new fields (a category outside the taxonomy, a candidate
 * missing its disposition) must still be REJECTED. An "additive" schema
 * that accepted everything would pass the first half and fail the point.
 */

describe("FOUNDATION F3: the schema additions are additive (§ 21, attack M)", () => {
  /**
   * A result produced BEFORE F3 -- no `unreportedCandidates`, no
   * `unknownReasons` -- must still validate. This is the whole reason
   * neither key was added to `required`, and it is the kind of promise
   * that is easy to make in a doc comment and break in a schema edit.
   */
  const preF3Output = {
    schemaVersion: SCHEMA_VERSION,
    scan: { id: "scan-legacy", project: "." },
    findings: [
      {
        vulnerability: "GHSA-legacy",
        package: "legacy-lib",
        version: "1.0.0",
        packageInstance: "node_modules/legacy-lib",
        verdict: "NOT_AFFECTED",
        target: {
          module: "legacy-lib",
          symbol: "vulnerable",
          kind: "function",
        },
        evidence: {
          path: [],
          reasons: [
            "vulnerable symbol confirmed unreachable from all analyzed entrypoints",
          ],
          confirmedUnreachableTarget: {
            target: { module: "legacy-lib", export: "vulnerable" },
            entrypointRoots: ["/p/src/index.js"],
            reachableSubgraphComplete: true,
            graphTruncated: false,
          },
        },
      },
      {
        vulnerability: "GHSA-legacy-2",
        package: "legacy-lib",
        verdict: "UNKNOWN",
      },
    ],
    coverage: {
      files: 1,
      modulesResolved: 1,
      modulesUnresolved: 0,
      functions: 1,
      callsResolved: 1,
      callsDynamic: 0,
    },
    diagnostics: [],
    timings: {
      parsingMs: 0,
      resolutionMs: 0,
      graphConstructionMs: 0,
      reachabilityMs: 0,
      providerMs: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalMs: 0,
    },
  };

  it("still validates a result that predates both new fields", () => {
    expect(validateScanOutput(preF3Output)).toEqual([]);
  });

  it("still validates an UNKNOWN that carries no structured reasons", () => {
    // The second finding above is exactly that shape. Restated as its own
    // case because it is the one a naive "every UNKNOWN must have reasons"
    // schema rule would break, retroactively invalidating every archived
    // result.
    const onlyUnknown = {
      ...preF3Output,
      findings: [preF3Output.findings[1]],
    };
    expect(validateScanOutput(onlyUnknown)).toEqual([]);
  });

  it("rejects a category outside the taxonomy, so the enum is real", () => {
    const bogus = {
      ...preF3Output,
      findings: [
        {
          ...preF3Output.findings[1],
          unknownReasons: [
            { category: "made_up_category", reason: "eval", count: 1 },
          ],
        },
      ],
    };
    expect(validateScanOutput(bogus).length).toBeGreaterThan(0);
  });

  it("rejects an unreported candidate missing its disposition", () => {
    // `disposition` is what separates a conclusion from a gap. A schema
    // that let it be omitted would let a consumer see an entry it cannot
    // classify, which is worse than no entry.
    const missing = {
      ...preF3Output,
      unreportedCandidates: [
        {
          stage: "advisory_applicability",
          reason: "advisory_not_applicable_to_installed_version",
          detail: "…",
        },
      ],
    };
    expect(validateScanOutput(missing).length).toBeGreaterThan(0);
  });

  it("accepts a well-formed pair of new fields", () => {
    const withF3 = {
      ...preF3Output,
      findings: [
        {
          ...preF3Output.findings[1],
          unknownReasons: [
            { category: "capability_escape", reason: "eval", count: 3 },
          ],
        },
      ],
      unreportedCandidates: [
        {
          stage: "advisory_applicability",
          disposition: "not_applicable",
          vulnerability: "GHSA-legacy",
          package: "legacy-lib",
          packageInstance: "node_modules/legacy-lib",
          version: "9.0.0",
          reason: "advisory_not_applicable_to_installed_version",
          detail: "outside every affected range",
        },
      ],
    };
    expect(validateScanOutput(withF3)).toEqual([]);
  });
});
