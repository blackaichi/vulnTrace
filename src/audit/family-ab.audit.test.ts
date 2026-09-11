/**
 * P0-Z PART P + PART D: real Family A / Family B end-to-end controls, a
 * duplicate same-name/same-version PackageInstance twin matrix, and
 * one-at-a-time mutation of each completeness assumption.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  cleanupAll,
  describe1,
  family,
  scan,
  type Files,
  type AuditFinding,
} from "./harness.js";

afterAll(cleanupAll);

const TIMEOUT = 60_000;

function libFiles(prefix: string): Files {
  return {
    [`${prefix}/package.json`]: JSON.stringify({
      name: "vlib",
      version: "1.0.0",
      main: "index.js",
    }),
    [`${prefix}/index.js`]:
      "function vulnerable(){return 'boom';}\n" +
      "function safe(){return 'ok';}\n" +
      "module.exports = { vulnerable, safe };\n",
  };
}

/** App + two DISTINCT installs of vlib@1.0.0 (top-level and nested). */
function twinScaffold(): Files {
  return {
    "package.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { vlib: "1.0.0", consumer: "1.0.0" },
    }),
    "package-lock.json": JSON.stringify({
      name: "app",
      version: "1.0.0",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "app",
          version: "1.0.0",
          dependencies: { vlib: "1.0.0", consumer: "1.0.0" },
        },
        "node_modules/vlib": { version: "1.0.0" },
        "node_modules/consumer": {
          version: "1.0.0",
          dependencies: { vlib: "1.0.0" },
        },
        "node_modules/consumer/node_modules/vlib": { version: "1.0.0" },
      },
    }),
    ...libFiles("node_modules/vlib"),
    ...libFiles("node_modules/consumer/node_modules/vlib"),
    "node_modules/consumer/package.json": JSON.stringify({
      name: "consumer",
      version: "1.0.0",
      main: "index.js",
    }),
    "node_modules/consumer/index.js":
      "const v = require('vlib');\nmodule.exports.callVuln = () => v.vulnerable();\n",
  };
}

function soleScaffold(): Files {
  return {
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
    ...libFiles("node_modules/vlib"),
  };
}

async function run(files: Files, entry = "src/index.js") {
  return scan({
    files,
    entrypoints: [entry],
    pkgName: "vlib",
    targets: [{ module: "vlib", export: "vulnerable" }],
  });
}

function instanceOf(f: AuditFinding | undefined): string {
  const e = f?.evidence;
  return (
    e?.confirmedAbsentFromModuleLoadClosure?.packageInstance ??
    e?.confirmedAbsentInstance?.packageInstance ??
    "(none)"
  );
}

describe("PART P -- Family A end-to-end control + mutations", () => {
  it(
    "A-CONTROL: installed but never loaded -> Family A naming the exact instance",
    async () => {
      const r = await run({
        ...soleScaffold(),
        "src/index.js": "module.exports.main = () => 'no dependency use';\n",
      });
      const f = r.findings[0];
      console.log("A-CONTROL:", describe1(f), "instance=", instanceOf(f));
      expect(f?.verdict).toBe("NOT_AFFECTED");
      expect(family(f!)).toBe("A");
      // Exact install LOCATION, never a bare name/version.
      expect(instanceOf(f)).toContain("node_modules/vlib");
    },
    TIMEOUT,
  );

  it(
    "A-MUT-1 (dynamic require): completeness broken -> NOT_AFFECTED must disappear",
    async () => {
      const r = await run({
        ...soleScaffold(),
        "src/index.js":
          "const n = process.env.M;\nrequire(n);\nmodule.exports.main = () => 'x';\n",
      });
      const f = r.findings[0];
      console.log("A-MUT-1 dynamic require:", describe1(f));
      expect(f?.verdict).not.toBe("NOT_AFFECTED");
    },
    TIMEOUT,
  );

  it(
    "A-MUT-2 (eval): completeness broken -> NOT_AFFECTED must disappear",
    async () => {
      const r = await run({
        ...soleScaffold(),
        "src/index.js":
          "eval(process.env.CODE);\nmodule.exports.main = () => 'x';\n",
      });
      const f = r.findings[0];
      console.log("A-MUT-2 eval:", describe1(f));
      expect(f?.verdict).not.toBe("NOT_AFFECTED");
    },
    TIMEOUT,
  );

  it(
    "A-MUT-3 (loader monkey-patch in non-call position) -> NOT_AFFECTED must disappear",
    async () => {
      const r = await run({
        ...soleScaffold(),
        "src/index.js":
          "const Module = require('module');\n" +
          "Module._extensions['.js'] = Module._extensions['.js'];\n" +
          "module.exports.main = () => 'x';\n",
      });
      const f = r.findings[0];
      console.log("A-MUT-3 loader patch:", describe1(f));
      expect(f?.verdict).not.toBe("NOT_AFFECTED");
    },
    TIMEOUT,
  );

  it(
    "A-MUT-4 (syntax error in a loaded file) -> NOT_AFFECTED must disappear",
    async () => {
      const r = await run({
        ...soleScaffold(),
        "src/index.js":
          "require('./broken.js');\nmodule.exports.main = () => 'x';\n",
        "src/broken.js": "function ( { this is not javascript !!!\n",
      });
      const f = r.findings[0];
      console.log("A-MUT-4 syntax error:", describe1(f));
      expect(f?.verdict).not.toBe("NOT_AFFECTED");
    },
    TIMEOUT,
  );

  it(
    "A-MUT-5 (dynamic import) -> NOT_AFFECTED must disappear",
    async () => {
      const r = await run({
        ...soleScaffold(),
        "src/index.js":
          "module.exports.main = async () => (await import(process.env.M)).x;\n",
      });
      const f = r.findings[0];
      console.log("A-MUT-5 dynamic import:", describe1(f));
      expect(f?.verdict).not.toBe("NOT_AFFECTED");
    },
    TIMEOUT,
  );
});

describe("PART D -- PackageInstance twin matrix", () => {
  it(
    "TWIN-1: nested instance genuinely called; top-level twin unused",
    async () => {
      // Entry uses `consumer`, which requires ITS OWN nested vlib and calls
      // the vulnerable export. The top-level vlib install is never loaded.
      const r = await run({
        ...twinScaffold(),
        "src/index.js":
          "const c = require('consumer');\nmodule.exports.main = () => c.callVuln();\n",
      });
      for (const f of r.findings) {
        console.log(
          "TWIN-1 finding:",
          describe1(f),
          "proofInstance=",
          instanceOf(f),
        );
      }
      // The instance whose code genuinely runs must NEVER be NOT_AFFECTED.
      const bad = r.findings.filter(
        (f) => f.verdict === "NOT_AFFECTED" && instanceOf(f).includes("consumer"),
      );
      expect(bad).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "TWIN-2: top-level instance called directly; nested twin unused",
    async () => {
      const r = await run({
        ...twinScaffold(),
        "src/index.js":
          "const v = require('vlib');\nmodule.exports.main = () => v.vulnerable();\n",
      });
      for (const f of r.findings) {
        console.log(
          "TWIN-2 finding:",
          describe1(f),
          "proofInstance=",
          instanceOf(f),
        );
      }
      // No proof may name the top-level instance, which is genuinely called.
      const bad = r.findings.filter(
        (f) =>
          f.verdict === "NOT_AFFECTED" &&
          instanceOf(f) !== "(none)" &&
          !instanceOf(f).includes("consumer"),
      );
      expect(bad).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "TWIN-3 (VT-307e reproduction shape): re-export chain reaches the nested twin",
    async () => {
      // `consumer` re-exports the nested vlib via an ESM re-export
      // DECLARATION, which the call graph's discovery does not follow as an
      // edge. The entry ALSO imports the top-level install directly, so the
      // graph discovers that one. The nested twin is genuinely loaded+called.
      const files = twinScaffold();
      const r = await run({
        ...files,
        "node_modules/consumer/package.json": JSON.stringify({
          name: "consumer",
          version: "1.0.0",
          type: "module",
          main: "index.mjs",
        }),
        "node_modules/consumer/index.mjs": "export * from 'vlib';\n",
        "node_modules/consumer/node_modules/vlib/package.json": JSON.stringify(
          { name: "vlib", version: "1.0.0", type: "module", main: "index.mjs" },
        ),
        "node_modules/consumer/node_modules/vlib/index.mjs":
          "export function vulnerable(){return 'boom';}\n" +
          "export function safe(){return 'ok';}\n",
        "src/index.mjs":
          "import { safe } from 'vlib';\n" +
          "import { vulnerable } from 'consumer';\n" +
          "export const main = () => { safe(); return vulnerable(); };\n",
      }, "src/index.mjs");
      for (const f of r.findings) {
        console.log(
          "TWIN-3 finding:",
          describe1(f),
          "proofInstance=",
          instanceOf(f),
        );
      }
      const bad = r.findings.filter(
        (f) => f.verdict === "NOT_AFFECTED" && instanceOf(f).includes("consumer"),
      );
      expect(bad).toEqual([]);
    },
    TIMEOUT,
  );
});
