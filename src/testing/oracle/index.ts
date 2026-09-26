/**
 * THE SHARED REAL-NODE ORACLE HARNESS (task H-0).
 *
 * Test infrastructure only: no analyzer behavior changes here, and this
 * whole directory is excluded from the build (tsconfig.build.json already
 * excludes `src/testing/**`, the same way it excludes
 * `open-soundness-defect.ts`).
 *
 * One method, generalized from every reproduction in docs/audits/
 * (2026-09-premise-sweep-round-1/2, 2026-09-independent-audit): build a
 * fixture project ({@link ProjectSpec}), assert it is LOUD in real Node
 * ({@link assertLoudFixture}), run the real scan pipeline
 * ({@link runOracleScan}), and run real Node on the same fixture for
 * ground truth ({@link runGroundTruth}) -- tied together by
 * {@link runOracleCase}, which also enforces the positive/negative
 * control requirement structurally.
 */
export * from "./hit.js";
export * from "./project.js";
export * from "./loud-fixture.js";
export * from "./ground-truth.js";
export * from "./provider.js";
export * from "./typescript-compile.js";
export * from "./config-files.js";
export * from "./scan.js";
export * from "./case.js";
export * from "./builtin-probe.js";
