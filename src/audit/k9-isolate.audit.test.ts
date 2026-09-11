/**
 * P0-Z: isolation of the K9 candidate false NOT_AFFECTED.
 *
 * K9 combined (a) a `class C extends <null>` heritage and (b) a
 * whole-module CommonJS re-export `module.exports = require('./reexport.js')`.
 * This file varies one factor at a time to find which construct produces the
 * negative proof, and whether the target is genuinely runtime-reachable.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupAll,
  describe1,
  runNode,
  scan,
  type Files,
  type AuditFinding,
} from "./harness.js";

afterAll(cleanupAll);
const TIMEOUT = 60_000;

const VLIB: Files = {
  "node_modules/vlib/package.json": JSON.stringify({
    name: "vlib",
    version: "1.0.0",
    main: "index.js",
  }),
  "node_modules/vlib/index.js":
    "function vulnerable(){ console.log('VULN_EXECUTED'); return 'boom'; }\n" +
    "function safe(){ return 'ok'; }\n" +
    "module.exports = { vulnerable, safe };\n",
};

const SCAFFOLD: Files = {
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
};

const PROBE =
  "let m;\n" +
  "try { m = require('./src/index.js'); console.log('MODULE_LOADED'); }\n" +
  "catch (e) { console.log('MODULE_ABRUPT:' + e.message); process.exit(0); }\n" +
  "if (m && typeof m.run === 'function') {\n" +
  "  console.log('RUN_EXPORTED');\n" +
  "  try { m.run(); } catch (e) { console.log('RUN_THREW:' + e.message); }\n" +
  "} else { console.log('RUN_ABSENT'); }\n";

const rows: string[] = [];

async function probe(id: string, entry: string): Promise<void> {
  const files: Files = {
    ...SCAFFOLD,
    ...VLIB,
    "src/helpers.js":
      "function bail(){ throw new Error('bail'); }\n" +
      "function ok(){ return 1; }\n" +
      "function heritage(f){ return f ? class Base {} : null; }\n" +
      "module.exports = { bail, ok, heritage };\n",
    "src/reexport.js":
      "module.exports = { run: () => require('vlib').vulnerable() };\n",
    "src/index.js": entry,
  };
  const node = runNode({ ...files, "probe.js": PROBE }, "probe.js");
  const reachable = node.events.includes("VULN_EXECUTED");
  const r = await scan({
    files,
    entrypoints: ["src/index.js"],
    pkgName: "vlib",
    targets: [{ module: "vlib", export: "vulnerable" }],
  });
  const f: AuditFinding | undefined = r.findings[0];
  const v = describe1(f);
  const bad = reachable && v.startsWith("NOT_AFFECTED");
  rows.push(
    `${bad ? "!! FALSE-NEG !!" : "ok            "} ${id.padEnd(40)} analyzer=${v.padEnd(24)} runtimeReached=${reachable}`,
  );
  console.log(`[${id}] analyzer=${v} runtime=${reachable} ev=${JSON.stringify(node.events)}`);
  if (f?.evidence?.reasons) console.log(`    reasons: ${JSON.stringify(f.evidence.reasons)}`);
}

afterAll(() => {
  console.log("\n===== K9 ISOLATION =====");
  for (const r of rows) console.log(r);
});

describe("K9 isolation", () => {
  it(
    "I1: whole-module CJS re-export ALONE (no class at all)",
    async () => {
      await probe("I1-reexport-only", "module.exports = require('./reexport.js');\n");
    },
    TIMEOUT,
  );

  it(
    "I2: class extends null ALONE, then a DIRECT export",
    async () => {
      await probe(
        "I2-heritage-null+direct-export",
        "const h = require('./helpers.js');\n" +
          "class C extends h.heritage(false) {}\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
    },
    TIMEOUT,
  );

  it(
    "I3: literal `extends null` + whole-module re-export",
    async () => {
      await probe(
        "I3-literal-null+reexport",
        "class C extends null {}\n" +
          "module.exports = require('./reexport.js');\n",
      );
    },
    TIMEOUT,
  );

  it(
    "I4: no class, re-export via an intermediate const",
    async () => {
      await probe(
        "I4-const-then-reexport",
        "const re = require('./reexport.js');\n" + "module.exports = re;\n",
      );
    },
    TIMEOUT,
  );

  it(
    "I5: control -- direct export of a local calling vlib",
    async () => {
      await probe(
        "I5-direct-export-control",
        "module.exports.run = () => require('vlib').vulnerable();\n",
      );
    },
    TIMEOUT,
  );

  it(
    "I6: re-export where the sibling calls vlib at LOAD time",
    async () => {
      await probe(
        "I6-reexport-loadtime",
        "module.exports = require('./loadtime.js');\n",
      );
    },
    TIMEOUT,
  );
});
