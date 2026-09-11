/**
 * P0-Z: blast radius of the "entrypoint re-export root vanishes, Family C
 * still claims completeness" defect isolated in k9-isolate.audit.test.ts.
 *
 * Each case makes the ENTRYPOINT re-export a callable that reaches vlib's
 * vulnerable export. Runtime confirms the callable is genuinely exported and
 * genuinely executes the target. Any NOT_AFFECTED here is a false negative.
 */
import { afterAll, describe, it } from "vitest";
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

function scaffold(type: "module" | "commonjs"): Files {
  return {
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      type,
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
}

const VLIB_CJS: Files = {
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

const VLIB_ESM: Files = {
  "node_modules/vlib/package.json": JSON.stringify({
    name: "vlib",
    version: "1.0.0",
    type: "module",
    exports: { ".": "./index.js" },
  }),
  "node_modules/vlib/index.js":
    "export function vulnerable(){ console.log('VULN_EXECUTED'); return 'boom'; }\n" +
    "export function safe(){ return 'ok'; }\n",
};

const rows: string[] = [];

async function probe(
  id: string,
  files: Files,
  entry: string,
  probeSrc: string,
  probeName: string,
): Promise<void> {
  const node = runNode({ ...files, [probeName]: probeSrc }, probeName);
  const reachable = node.events.includes("VULN_EXECUTED");
  const r = await scan({
    files,
    entrypoints: [entry],
    pkgName: "vlib",
    targets: [{ module: "vlib", export: "vulnerable" }],
  });
  const f: AuditFinding | undefined = r.findings[0];
  const v = describe1(f);
  const bad = reachable && v.startsWith("NOT_AFFECTED");
  rows.push(
    `${bad ? "!! FALSE-NEG !!" : "ok            "} ${id.padEnd(38)} analyzer=${v.padEnd(24)} runtimeReached=${reachable}`,
  );
  console.log(`[${id}] ${v} runtime=${reachable} ev=${JSON.stringify(node.events)}`);
}

afterAll(() => {
  console.log("\n===== BLAST RADIUS =====");
  for (const r of rows) console.log(r);
});

const CJS_PROBE =
  "let m; try { m = require('./src/index.js'); } catch(e){ console.log('ABRUPT:'+e.message); process.exit(0);}\n" +
  "const fn = m && (m.run || (m.default && m.default.run));\n" +
  "if (typeof fn === 'function'){ console.log('RUN_EXPORTED'); fn(); } else console.log('RUN_ABSENT');\n";

const ESM_PROBE =
  "import('./src/index.js').then(m => {\n" +
  "  const fn = m.run || (m.default && m.default.run);\n" +
  "  if (typeof fn === 'function'){ console.log('RUN_EXPORTED'); fn(); } else console.log('RUN_ABSENT');\n" +
  "}).catch(e => console.log('ABRUPT:'+e.message));\n";

describe("blast radius of vanished re-export roots", () => {
  it(
    "B1 CJS: module.exports = require('./sibling')",
    async () => {
      await probe(
        "B1-cjs-whole-module-reexport",
        {
          ...scaffold("commonjs"),
          ...VLIB_CJS,
          "src/sibling.js":
            "module.exports = { run: () => require('vlib').vulnerable() };\n",
          "src/index.js": "module.exports = require('./sibling.js');\n",
        },
        "src/index.js",
        CJS_PROBE,
        "probe.js",
      );
    },
    TIMEOUT,
  );

  it(
    "B2 CJS: Object.assign(module.exports, require('./sibling'))",
    async () => {
      await probe(
        "B2-cjs-object-assign",
        {
          ...scaffold("commonjs"),
          ...VLIB_CJS,
          "src/sibling.js":
            "module.exports = { run: () => require('vlib').vulnerable() };\n",
          "src/index.js":
            "Object.assign(module.exports, require('./sibling.js'));\n",
        },
        "src/index.js",
        CJS_PROBE,
        "probe.js",
      );
    },
    TIMEOUT,
  );

  it(
    "B3 CJS: module.exports.run = require('./sibling').run",
    async () => {
      await probe(
        "B3-cjs-named-property-reexport",
        {
          ...scaffold("commonjs"),
          ...VLIB_CJS,
          "src/sibling.js":
            "module.exports = { run: () => require('vlib').vulnerable() };\n",
          "src/index.js":
            "module.exports.run = require('./sibling.js').run;\n",
        },
        "src/index.js",
        CJS_PROBE,
        "probe.js",
      );
    },
    TIMEOUT,
  );

  it(
    "B4 ESM: export * from './sibling.js'",
    async () => {
      await probe(
        "B4-esm-export-star",
        {
          ...scaffold("module"),
          ...VLIB_ESM,
          "src/sibling.js":
            "import { vulnerable } from 'vlib';\nexport const run = () => vulnerable();\n",
          "src/index.js": "export * from './sibling.js';\n",
        },
        "src/index.js",
        ESM_PROBE,
        "probe.mjs",
      );
    },
    TIMEOUT,
  );

  it(
    "B5 ESM: export { run } from './sibling.js'",
    async () => {
      await probe(
        "B5-esm-named-reexport",
        {
          ...scaffold("module"),
          ...VLIB_ESM,
          "src/sibling.js":
            "import { vulnerable } from 'vlib';\nexport const run = () => vulnerable();\n",
          "src/index.js": "export { run } from './sibling.js';\n",
        },
        "src/index.js",
        ESM_PROBE,
        "probe.mjs",
      );
    },
    TIMEOUT,
  );

  it(
    "B6 ESM control: direct export calling vlib",
    async () => {
      await probe(
        "B6-esm-direct-control",
        {
          ...scaffold("module"),
          ...VLIB_ESM,
          "src/index.js":
            "import { vulnerable } from 'vlib';\nexport const run = () => vulnerable();\n",
        },
        "src/index.js",
        ESM_PROBE,
        "probe.mjs",
      );
    },
    TIMEOUT,
  );

  it(
    "B7 CJS: re-export from a PACKAGE rather than a sibling file",
    async () => {
      await probe(
        "B7-cjs-reexport-package",
        {
          ...scaffold("commonjs"),
          ...VLIB_CJS,
          "src/index.js": "module.exports = require('vlib');\n",
        },
        "src/index.js",
        "let m; try { m = require('./src/index.js'); } catch(e){ console.log('ABRUPT:'+e.message); process.exit(0);}\n" +
          "if (typeof m.vulnerable === 'function'){ console.log('RUN_EXPORTED'); m.vulnerable(); } else console.log('RUN_ABSENT');\n",
        "probe.js",
      );
    },
    TIMEOUT,
  );
});
