/**
 * P0-Z PART K + PART M: cross-family compositions of RWF-025/025b/026/027/
 * 028, each paired with a REAL NODE differential oracle.
 *
 * Shape of every case: the application entrypoint may or may not complete
 * its module body. If it completes, `module.exports.run` exists and calling
 * it executes vlib's vulnerable export -- so the target is genuinely
 * runtime-reachable and NOT_AFFECTED would be FALSE. If the body definitely
 * aborts first, `run` is never exported and a negative proof is sound.
 *
 * The oracle decides which of those two worlds each fixture is in by
 * actually running Node, rather than by replaying a committed expectation.
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

/** vlib: the vulnerable dependency. Prints a marker when `vulnerable` runs. */
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

/** Helper module offering both genuinely-abrupt and genuinely-normal calls. */
const HELPERS =
  "function bail(){ throw new Error('bail'); }\n" +
  "function ok(){ return 1; }\n" +
  "function heritage(f){ return f ? class Base {} : null; }\n" +
  "module.exports = { bail, ok, heritage };\n";

/**
 * A probe that loads the entry the way the scan's entrypoint config does and
 * reports exactly what the runtime did: did the module body complete, was
 * `run` exported, and did calling it execute the vulnerable target.
 */
const PROBE =
  "let m;\n" +
  "try { m = require('./src/index.js'); console.log('MODULE_LOADED'); }\n" +
  "catch (e) { console.log('MODULE_ABRUPT:' + e.message); process.exit(0); }\n" +
  "if (m && typeof m.run === 'function') {\n" +
  "  console.log('RUN_EXPORTED');\n" +
  "  try { m.run(); } catch (e) { console.log('RUN_THREW:' + e.message); }\n" +
  "} else { console.log('RUN_ABSENT'); }\n";

interface CaseResult {
  id: string;
  verdict: string;
  runtimeReachable: boolean;
  events: string[];
}

const results: CaseResult[] = [];

async function assess(id: string, entrySrc: string): Promise<CaseResult> {
  const files: Files = {
    ...SCAFFOLD,
    ...VLIB,
    "src/helpers.js": HELPERS,
    "src/reexport.js":
      "module.exports = { run: () => require('vlib').vulnerable() };\n",
    "src/index.js": entrySrc,
  };

  // --- real Node differential oracle ---
  const node = runNode({ ...files, "probe.js": PROBE }, "probe.js");
  const runtimeReachable = node.events.includes("VULN_EXECUTED");

  // --- analyzer ---
  const r = await scan({
    files,
    entrypoints: ["src/index.js"],
    pkgName: "vlib",
    targets: [{ module: "vlib", export: "vulnerable" }],
  });
  const f: AuditFinding | undefined = r.findings[0];
  const verdict = describe1(f);

  const out: CaseResult = {
    id,
    verdict,
    runtimeReachable,
    events: node.events,
  };
  results.push(out);
  console.log(
    `[${id}] analyzer=${verdict} runtimeVulnExecuted=${runtimeReachable} events=${JSON.stringify(node.events)}`,
  );
  return out;
}

/** THE P0 INVARIANT: runtime-reachable target must never be NOT_AFFECTED. */
function assertSound(c: CaseResult): void {
  if (c.runtimeReachable) {
    expect(
      c.verdict.startsWith("NOT_AFFECTED"),
      `${c.id}: Node executed the vulnerable target but analyzer said ${c.verdict}`,
    ).toBe(false);
  }
}

afterAll(() => {
  console.log("\n===== PART K/M COMPOSITION MATRIX =====");
  for (const c of results) {
    const flag = c.runtimeReachable && c.verdict.startsWith("NOT_AFFECTED");
    console.log(
      `${flag ? "!! FALSE-NEG !!" : "ok            "} ${c.id.padEnd(34)} analyzer=${c.verdict.padEnd(22)} runtimeReached=${c.runtimeReachable}`,
    );
  }
});

describe("PART K -- cross-family composition matrix", () => {
  it(
    "K1: RWF-028 alias + RWF-026 call argument -- foo(alias())",
    async () => {
      // alias is an exact const alias of a definitely-throwing callable, used
      // in a MANDATORY call-argument position: the body definitely aborts.
      const c = await assess(
        "K1-alias+call-arg",
        "const h = require('./helpers.js');\n" +
          "const alias = h.bail;\n" +
          "function foo(x){ return x; }\n" +
          "foo(alias());\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K1b: MUTATION -- alias reassigned to a NON-throwing callable before use",
    async () => {
      // The RWF-028 provenance assumption is invalidated: the body completes,
      // `run` IS exported, and the target is genuinely reachable.
      const c = await assess(
        "K1b-alias-reassigned",
        "const h = require('./helpers.js');\n" +
          "let alias = h.bail;\n" +
          "alias = h.ok;\n" +
          "function foo(x){ return x; }\n" +
          "foo(alias());\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K2: RWF-028 object member + RWF-026 object value -- const x = { y: h.bail() }",
    async () => {
      const c = await assess(
        "K2-member+object-value",
        "const h = require('./helpers.js');\n" +
          "const x = { y: h.bail() };\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K2b: MUTATION -- property overwritten so the member is no longer bail",
    async () => {
      const c = await assess(
        "K2b-member-overwritten",
        "const h = require('./helpers.js');\n" +
          "h.bail = h.ok;\n" +
          "const x = { y: h.bail() };\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K3: RWF-028 wrapper + RWF-026 assignment RHS -- module.exports = helper()",
    async () => {
      const c = await assess(
        "K3-wrapper+assign-rhs",
        "const h = require('./helpers.js');\n" +
          "function wrapper(){ return h.bail(); }\n" +
          "module.exports = wrapper();\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K3b: MUTATION -- wrapper reassigned to a returning function",
    async () => {
      const c = await assess(
        "K3b-wrapper-reassigned",
        "const h = require('./helpers.js');\n" +
          "let wrapper = function(){ return h.bail(); };\n" +
          "wrapper = function(){ return {}; };\n" +
          "module.exports = wrapper();\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K4: RWF-028 provenance + RWF-027 class heritage",
    async () => {
      // heritage(false) returns null -> `extends null` is a VALID class
      // definition in JS. The body does NOT abort.
      const c = await assess(
        "K4-alias+heritage-null",
        "const h = require('./helpers.js');\n" +
          "const alias = h.heritage;\n" +
          "class C extends alias(false) {}\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K4b: RWF-028 provenance + RWF-027 heritage that is genuinely invalid",
    async () => {
      const c = await assess(
        "K4b-alias+heritage-invalid",
        "const h = require('./helpers.js');\n" +
          "const alias = function(){ return 42; };\n" +
          "class C extends alias() {}\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K5: RWF-025 reassignment + RWF-028 alias",
    async () => {
      const c = await assess(
        "K5-reassign+alias",
        "const h = require('./helpers.js');\n" +
          "let alias = h.bail;\n" +
          "alias = h.ok;\n" +
          "function foo(x){ return x; }\n" +
          "foo(alias());\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K6: RWF-025 target-side nested real assignment invalidating RWF-028 provenance",
    async () => {
      const c = await assess(
        "K6-nested-assign-invalidates",
        "const h = require('./helpers.js');\n" +
          "const box = { fn: h.bail };\n" +
          "box.fn = h.ok;\n" +
          "function foo(x){ return x; }\n" +
          "foo(box.fn());\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K7: RWF-025b CommonJS attribution restoration + RWF-021 roots",
    async () => {
      // A bare evaluated reference to `run` is NOT a write; the export stands
      // and the root must survive.
      const c = await assess(
        "K7-cjs-bare-ref+roots",
        "const h = require('./helpers.js');\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n" +
          "void module.exports.run;\n" +
          "const t = typeof module.exports.run;\n",
      );
      assertSound(c);
      // The export is genuinely live at runtime -- must not be NOT_AFFECTED.
      expect(c.runtimeReachable).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "K8: RWF-026 abrupt export-authority withdrawal + Family C",
    async () => {
      const c = await assess(
        "K8-abrupt-withdrawal+C",
        "const h = require('./helpers.js');\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n" +
          "h.bail();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K8b: MUTATION -- the abrupt call is CAUGHT, so the module completes",
    async () => {
      const c = await assess(
        "K8b-abrupt-caught",
        "const h = require('./helpers.js');\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n" +
          "try { h.bail(); } catch (e) { /* swallowed */ }\n",
      );
      assertSound(c);
      expect(c.runtimeReachable).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "K9: RWF-027 class cutoff + later CommonJS export/reexport",
    async () => {
      const c = await assess(
        "K9-class-cutoff+later-export",
        "const h = require('./helpers.js');\n" +
          "class C extends h.heritage(false) {}\n" +
          "module.exports = require('./reexport.js');\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K11: RWF-026 optional/conditional refusal + RWF-028 alias provenance",
    async () => {
      // Optional call on a possibly-nullish receiver: abruptness is NOT proven.
      const c = await assess(
        "K11-optional+alias",
        "const h = require('./helpers.js');\n" +
          "const alias = process.env.X ? h.bail : undefined;\n" +
          "alias?.();\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
      expect(c.runtimeReachable).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "K12: RWF-027 unknown path + RWF-028 resolvable nested call",
    async () => {
      const c = await assess(
        "K12-unknown-path+nested-call",
        "const h = require('./helpers.js');\n" +
          "const alias = h.heritage;\n" +
          "class C extends alias(process.env.FLAG ? true : false) {}\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
    },
    TIMEOUT,
  );

  it(
    "K13: conditional-arm refusal -- abrupt only on ONE arm",
    async () => {
      const c = await assess(
        "K13-conditional-arm",
        "const h = require('./helpers.js');\n" +
          "const v = process.env.X ? h.bail() : h.ok();\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
      expect(c.runtimeReachable).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "K14: logical-RHS refusal -- abrupt only if the left side is truthy",
    async () => {
      const c = await assess(
        "K14-logical-rhs",
        "const h = require('./helpers.js');\n" +
          "const v = process.env.X && h.bail();\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
      expect(c.runtimeReachable).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "K15: parameter shadow barrier -- inner `bail` is a parameter, not the import",
    async () => {
      const c = await assess(
        "K15-param-shadow",
        "const h = require('./helpers.js');\n" +
          "function outer(bail){ return bail(); }\n" +
          "outer(h.ok);\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
      expect(c.runtimeReachable).toBe(true);
    },
    TIMEOUT,
  );

  it(
    "K16: async wrapper -- a throwing callable made async no longer aborts the body",
    async () => {
      const c = await assess(
        "K16-async-defers",
        "const h = require('./helpers.js');\n" +
          "async function ab(){ return h.bail(); }\n" +
          "ab().catch(() => {});\n" +
          "module.exports.run = () => require('vlib').vulnerable();\n",
      );
      assertSound(c);
      expect(c.runtimeReachable).toBe(true);
    },
    TIMEOUT,
  );
});
