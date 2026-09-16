import { defineConfig } from "vitest/config";

/**
 * FOUNDATION F6 — THE FAST DETERMINISTIC FOUNDATION GATE.
 *
 * `npm run test:foundation`. The subset of `npm test` that owns a
 * Foundation invariant, run on its own so that "did a Foundation invariant
 * break" is answerable in well under a minute rather than in the ~3.5
 * minutes the full suite takes.
 *
 * THIS IS A SUBSET, NOT A SECOND SUITE. Every file below is also run by
 * `npm test` — the same file, under the same `vitest.config.ts` rules, with
 * no separate copy and no duplicated assertions. Nothing here is excluded
 * from the full run, so the fast gate can never disagree with it, and CI
 * does not execute the full suite twice (F6 § 25): CI runs `npm test`,
 * which contains all of this.
 *
 * WHAT QUALIFIES. A file belongs here when its failure is an unambiguous
 * report that a named Foundation invariant broke. The authoritative list
 * of those invariants and their owners is
 * `src/testing/foundation-invariants.ts`, and
 * `src/testing/foundation-invariants.test.ts` fails if any owner named
 * there is missing from the `include` below — so this list cannot drift
 * away from the map, in either direction.
 *
 * WHAT IS DELIBERATELY ABSENT.
 *
 * - **Wall-clock guards** (`cli/scan-performance.test.ts`). They measure
 *   elapsed time; they are coarse smoke, they need their own serial run,
 *   and a Foundation gate that could fail because a machine was busy would
 *   teach people to ignore it. `npm run test:performance`.
 * - **Adversarial suites** (`tests/adversarial/`). Deterministic, but they
 *   deliberately keep failing scenarios as a research record rather than
 *   fixing the analyzer — so their result is not an invariant.
 * - **Live validation** (`tests/validation/`). Needs the network and the
 *   real OSV database. See `LIVE_SIGNALS` in the invariant map.
 *
 * The full gate remains `npm test` plus adversarial, performance, build,
 * typecheck, lint, prettier and `validate:history`; see README.md.
 */
export default defineConfig({
  test: {
    include: [
      // -- The proof contracts (VT-CONTRACT-01/02/03) ------------------
      "src/cli/result-schema.negative-proof.test.ts",
      "src/analysis/verdict.analysis-context.test.ts",
      "src/cli/scan.analysis-context.test.ts",

      // -- F4: the negative-proof mutation harness ---------------------
      "src/analysis/verdict.f4-proof-mutation.test.ts",
      "src/analysis/verdict.negative-proof.test.ts",
      "src/testing/finding.f4-closure-hardening.test.ts",

      // -- F2: fail-closed guards --------------------------------------
      "src/analysis/verdict.f2-proof-guards.test.ts",
      "src/analysis/verdict.module-load-absence.test.ts",
      "src/analysis/module-load-closure.test.ts",
      "src/analysis/module-load-closure.differential-oracle.test.ts",

      // -- F3: the output contract -------------------------------------
      "src/analysis/verdict.f3-uncertainty-taxonomy.test.ts",
      "src/cli/scan.f3-no-finding.test.ts",
      "src/cli/scan.metadata-uncertainty.test.ts",
      "src/cli/scan.workspace-uncertainty.test.ts",
      "src/domain/uncertainty.test.ts",
      "src/domain/verdict.test.ts",
      "src/dependencies/workspaces.truncation.test.ts",

      // -- PackageInstance exact isolation ------------------------------
      "src/dependencies/package-instances.test.ts",
      "src/dependencies/package-instances.differential-oracle.test.ts",
      "src/domain/resolved-target.workspace-twins.test.ts",

      // -- F5: per-scan caches, the graph index, the multiplier ---------
      "src/domain/resolved-target.f5-identity-cache.test.ts",
      "src/analysis/scan-caches.f5-graph-index.test.ts",
      "src/analysis/scan-caches.f5-multiplier.test.ts",
      "src/cli/scan.f5-performance-foundation.test.ts",

      // -- F6: the gates themselves -------------------------------------
      "src/testing/foundation-differential.test.ts",
      "src/testing/foundation-invariants.test.ts",
      "src/testing/fixtures-are-committed.test.ts",
      "src/testing/commit-metadata-policy.test.ts",
    ],
    // Same reason as `vitest.config.ts`: several of these run REAL
    // end-to-end scans over vendored `node_modules` and legitimately take
    // seconds. A generous ceiling bounds pathological hangs and asserts
    // nothing about speed.
    testTimeout: 30_000,
  },
});
