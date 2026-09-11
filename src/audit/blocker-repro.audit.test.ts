/**
 * P0-Z BLOCKER -- minimal reproducer, kept as the canonical record.
 *
 * Two application files. The configured entrypoint re-exports a sibling's
 * callable; that callable calls vlib's vulnerable export. Node proves the
 * callable is exported from the entrypoint and that calling it executes the
 * vulnerable target. VulnTrace nevertheless returns NOT_AFFECTED carrying a
 * complete Family C proof (`reachableSubgraphComplete: true`).
 *
 * The entrypoint's exported callable is a REQUIRED reachability root
 * (see `entrypointSourceNodes`). Because the re-export is never chased, the
 * root silently vanishes, and the exhaustive search then reports "no
 * unresolved edge in the reachable subgraph" over a subgraph that was never
 * rooted correctly in the first place -- analysis incompleteness presented
 * as a completed negative proof.
 */
import { afterAll, describe, expect, it } from "vitest";
import { cleanupAll, runNode, scan, type Files } from "./harness.js";

afterAll(cleanupAll);

const FILES: Files = {
  "package.json": JSON.stringify({
    name: "app",
    version: "1.0.0",
    dependencies: { vlib: "1.0.0" },
  }),
  "package-lock.json": JSON.stringify({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "app", version: "1.0.0", dependencies: { vlib: "1.0.0" } },
      "node_modules/vlib": { version: "1.0.0" },
    },
  }),
  "node_modules/vlib/package.json": JSON.stringify({
    name: "vlib",
    version: "1.0.0",
    main: "index.js",
  }),
  "node_modules/vlib/index.js":
    "function vulnerable(){ console.log('VULN_EXECUTED'); return 'boom'; }\n" +
    "module.exports = { vulnerable };\n",
  "src/sibling.js":
    "module.exports = { run: () => require('vlib').vulnerable() };\n",
  "src/index.js": "module.exports = require('./sibling.js');\n",
};

const PROBE =
  "const m = require('./src/index.js');\n" +
  "if (typeof m.run === 'function') { console.log('RUN_EXPORTED'); m.run(); }\n";

describe("P0-Z BLOCKER: entrypoint re-export root vanishes under Family C", () => {
  it("Node executes the target; the analyzer must not claim NOT_AFFECTED", async () => {
    const node = runNode({ ...FILES, "probe.js": PROBE }, "probe.js");
    console.log("RUNTIME EVENTS:", JSON.stringify(node.events));
    expect(node.events).toContain("RUN_EXPORTED");
    expect(node.events).toContain("VULN_EXECUTED");

    const r = await scan({
      files: FILES,
      entrypoints: ["src/index.js"],
      pkgName: "vlib",
      targets: [{ module: "vlib", export: "vulnerable" }],
    });
    const f = r.findings[0];
    console.log("ANALYZER FINDING:", JSON.stringify(f, null, 2));

    // This is the assertion that currently FAILS -- it is the blocker.
    expect(f?.verdict).not.toBe("NOT_AFFECTED");
  }, 60_000);
});
