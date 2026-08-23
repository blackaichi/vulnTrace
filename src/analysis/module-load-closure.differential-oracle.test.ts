import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { DependencyNode } from "../domain/dependency.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
} from "../domain/resolved-target.js";
import { buildGateEligibleModuleLoadClosure } from "./module-load-closure.js";

/**
 * The differential Node oracle (VT-307c-capability-floor Part 20/21): the
 * PRIMARY soundness regression oracle for `ModuleLoadClosure`'s negative-
 * absence proof, recommended by the final VT-307d architecture review as
 * strictly more powerful than hand-hunting individual API names.
 *
 * Every named `DynamicCallReason` this classifier can ever produce (fixes
 * 5 through 11, and now the VT-307c-capability-floor fallback) exists
 * because SOMEONE reproduced, by hand, a case where a genuinely-installed
 * package executed under real Node while `ModuleLoadClosure` reported
 * `complete: true` with that package OUT of `loadedPackageInstances`. That
 * process finds known unknowns one at a time. This oracle instead tests
 * the INVARIANT those individual fixes are each instances of, directly
 * and automatically, so a REGRESSION in this invariant -- introduced by
 * any future change to this classifier, in any construct family, known or
 * not yet discovered -- fails a test immediately, without anyone having
 * to think of the specific construct first:
 *
 *   For a hermetic synthetic program: execute it with real Node, and
 *   record which genuinely-installed package's own top-level module body
 *   actually ran (via a `console.log` marker only that package's own
 *   `index.js` prints). Separately, build a GATE-ELIGIBLE
 *   `ModuleLoadClosure` for the same program (`knownPackageRoots`
 *   supplied, non-empty entrypoints). IF that closure exists AND reports
 *   `complete: true`, THEN every package whose marker actually printed
 *   MUST be present in `loadedPackageInstances` -- `complete: true` with
 *   an executed package OUT is exactly the false "this is safe to call
 *   absent" signal a negative-absence-proof gate must never be able to
 *   observe.
 *
 * Deliberately NOT the inverse: an incomplete/ineligible closure for a
 * case that DID execute the package is not a violation -- conservative
 * (`UNKNOWN`-shaped) behavior is always acceptable; only `complete: true`
 * co-existing with a real, unaccounted-for execution is a soundness bug.
 */

const MARKER = "OUT-INSTANCE-EXECUTED";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vt-oracle-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

function markerPackage(root: string, relativeDir: string): void {
  write(
    root,
    `${relativeDir}/package.json`,
    JSON.stringify({ name: "vuln", version: "1.0.0", main: "index.js" }),
  );
  write(
    root,
    `${relativeDir}/index.js`,
    `console.log("${MARKER}");\nmodule.exports = {};\n`,
  );
}

interface OracleCase {
  readonly label: string;
  /** Sets up the project on disk under `root`; returns the entrypoint file. */
  readonly setup: (root: string) => string;
  /** Every installed instance's root, relative to `root`, that this case's marker package occupies. */
  readonly vulnInstanceRelPath: string;
}

function dependencyNodeFor(name: string, location: string): DependencyNode {
  return {
    id: `${name}@0`,
    name,
    version: "0.0.0",
    ecosystem: "npm",
    direct: true,
    locations: [location],
    dependencyPaths: [],
  };
}

async function runOracleCase(oracleCase: OracleCase): Promise<void> {
  const root = tempProject();
  write(root, "package.json", JSON.stringify({ name: "app" }));
  const entry = oracleCase.setup(root);

  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [entry], {
      cwd: root,
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    stdout = String((error as { stdout?: string }).stdout ?? "");
  }
  const actuallyExecuted = stdout.includes(MARKER);

  const project = loadTsProject(root);
  const resolver = createModuleResolver(project);
  const knownPackageRoots = buildKnownPackageRoots(
    [dependencyNodeFor("vuln", oracleCase.vulnInstanceRelPath)],
    root,
  );
  const closure = await buildGateEligibleModuleLoadClosure({
    entrypoints: [{ filePath: entry, source: "configured", reason: "oracle" }],
    resolver,
    knownPackageRoots,
  });

  if (closure === undefined || closure.complete !== true) {
    // Conservative (ineligible or incomplete) is always an acceptable
    // outcome, regardless of whether the package actually executed.
    return;
  }

  const target = canonicalizePackageInstancePath(
    path.join(root, oracleCase.vulnInstanceRelPath),
  );
  const instanceIn = closure.loadedPackageInstances.some(
    (instance) => canonicalizePackageInstancePath(instance) === target,
  );

  if (actuallyExecuted) {
    expect(
      instanceIn,
      `SOUNDNESS VIOLATION: "${oracleCase.label}" -- the marker package genuinely executed under real Node, but the gate-eligible closure reported complete=true with it OUT of loadedPackageInstances.`,
    ).toBe(true);
  }
}

describe("ModuleLoadClosure differential Node oracle (VT-307c-capability-floor)", () => {
  const cases: OracleCase[] = [
    // ---------------------------------------------------------------
    // STATIC load grammar
    // ---------------------------------------------------------------
    {
      label: "static require('vuln')",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(root, "src/index.js", "require('vuln');\n");
      },
    },
    {
      label: "static ESM import 'vuln'",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        write(
          root,
          "package.json",
          JSON.stringify({ name: "app", type: "module" }),
        );
        write(
          root,
          "node_modules/vuln/package.json",
          JSON.stringify({
            name: "vuln",
            version: "1.0.0",
            main: "index.js",
            type: "module",
          }),
        );
        write(
          root,
          "node_modules/vuln/index.js",
          `console.log("${MARKER}");\nexport const x = 1;\n`,
        );
        return write(root, "src/index.mjs", "import 'vuln';\n");
      },
    },
    {
      label: "re-export-only chain (export * from 'vuln')",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        write(
          root,
          "package.json",
          JSON.stringify({ name: "app", type: "module" }),
        );
        write(
          root,
          "node_modules/vuln/package.json",
          JSON.stringify({
            name: "vuln",
            version: "1.0.0",
            main: "index.js",
            type: "module",
          }),
        );
        write(
          root,
          "node_modules/vuln/index.js",
          `console.log("${MARKER}");\nexport const x = 1;\n`,
        );
        write(root, "src/mid.js", "export * from 'vuln';\n");
        return write(root, "src/index.mjs", "export * from './mid.js';\n");
      },
    },
    {
      label: "nested package (holder requires vuln as its own dependency)",
      vulnInstanceRelPath: "node_modules/holder/node_modules/vuln",
      setup: (root) => {
        write(
          root,
          "node_modules/holder/package.json",
          JSON.stringify({
            name: "holder",
            version: "1.0.0",
            main: "index.js",
          }),
        );
        write(
          root,
          "node_modules/holder/index.js",
          "require('vuln');\nmodule.exports = {};\n",
        );
        markerPackage(root, "node_modules/holder/node_modules/vuln");
        return write(root, "src/index.js", "require('holder');\n");
      },
    },
    {
      label:
        "workspace member (file: symlink, no node_modules segment of its own)",
      vulnInstanceRelPath: "packages/vuln",
      setup: (root) => {
        write(
          root,
          "package.json",
          JSON.stringify({ name: "app", workspaces: ["packages/*"] }),
        );
        markerPackage(root, "packages/vuln");
        mkdirSync(path.join(root, "node_modules"), { recursive: true });
        try {
          symlinkSync(
            path.join(root, "packages/vuln"),
            path.join(root, "node_modules/vuln"),
            "dir",
          );
        } catch {
          // symlinks unavailable in this environment -- skip gracefully,
          // the ground-truth exec below will simply fail to resolve.
        }
        return write(root, "src/index.js", "require('vuln');\n");
      },
    },

    // ---------------------------------------------------------------
    // CAPABILITY interaction grammar
    // ---------------------------------------------------------------
    {
      label: "direct Module loader call: Module._load('vuln', module, false)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nModule._load('vuln', module, false);\n",
        );
      },
    },
    {
      label:
        "known mutation: Module._pathCache poisoning redirects a resolvable require",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        write(
          root,
          "node_modules/safe/package.json",
          JSON.stringify({ name: "safe", version: "1.0.0", main: "index.js" }),
        );
        write(root, "node_modules/safe/index.js", "module.exports = {};\n");
        return write(
          root,
          "src/index.js",
          "const path = require('path');\nconst Module = require('module');\nconst target = path.join(__dirname, '..', 'node_modules', 'vuln', 'index.js');\nconst paths = Module._resolveLookupPaths('safe', module);\nconst key = 'safe\\x00' + (paths ? paths.join('\\x00') : '');\nModule._pathCache[key] = target;\nrequire('safe');\n",
        );
      },
    },
    {
      label:
        "unknown member call: Module._preloadModules(['vuln']) direct-load primitive",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nModule._preloadModules(['vuln']);\n",
        );
      },
    },
    {
      label: "Module passed as a parameter, callee loads vuln via it",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nfunction configure(x){ x._load('vuln', module, false); }\nconfigure(Module);\n",
        );
      },
    },
    {
      label: "Module stored in a property, later used to load vuln",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nconst registry = {};\nregistry.loader = Module;\nregistry.loader._load('vuln', module, false);\n",
        );
      },
    },
    {
      label:
        "Module exported across a file boundary, consumer loads vuln via it",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        write(
          root,
          "src/holder.js",
          "const Module = require('module');\nmodule.exports.loader = Module;\n",
        );
        write(
          root,
          "src/consumer.js",
          "const m = require('./holder.js');\nm.loader._load('vuln', module, false);\nmodule.exports = {};\n",
        );
        return write(
          root,
          "src/index.js",
          "require('./holder.js');\nrequire('./consumer.js');\n",
        );
      },
    },
    {
      label: "ambient require passed as a parameter, callee loads vuln via it",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "function run(r){ r('vuln'); }\nrun(require);\n",
        );
      },
    },
    {
      label: "createRequire(...) result used directly to load vuln",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const { createRequire } = require('module');\nconst r = createRequire(__filename);\nr('vuln');\n",
        );
      },
    },
    {
      label:
        "process.mainModule.constructor._load('vuln', ...) (ambient alias form)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "process.mainModule.constructor._load('vuln', module, false);\n",
        );
      },
    },
    {
      label: "Module.registerHooks resolve-hook redirects a resolvable require",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        write(
          root,
          "node_modules/safe/package.json",
          JSON.stringify({ name: "safe", version: "1.0.0", main: "index.js" }),
        );
        write(root, "node_modules/safe/index.js", "module.exports = {};\n");
        return write(
          root,
          "src/index.js",
          "const path = require('path');\nconst Module = require('module');\nModule.registerHooks({ resolveSync(spec, ctx, next){ if (spec === 'safe') { return { url: 'file://' + path.join(__dirname, '..', 'node_modules', 'vuln', 'index.js'), format: 'commonjs', shortCircuit: true }; } return next(spec, ctx); } });\nrequire('safe');\n",
        );
      },
    },
    {
      label:
        "Module._readPackage reassignment redirects a resolvable require (historical fix-11 blocker)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        write(
          root,
          "node_modules/safe/package.json",
          JSON.stringify({ name: "safe", version: "1.0.0", main: "index.js" }),
        );
        write(root, "node_modules/safe/index.js", "module.exports = {};\n");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nconst realRead = Module._readPackage;\nModule._readPackage = function(p,b){ const r = realRead.call(this,p,b); if (r && r.name === 'safe') { return Object.assign({}, r, { main: '../vuln/index.js' }); } return r; };\nrequire('safe');\n",
        );
      },
    },
    {
      label:
        "Object.assign(Module, {_resolveFilename}) reflection mutation redirects a resolvable require",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        write(
          root,
          "node_modules/safe/package.json",
          JSON.stringify({ name: "safe", version: "1.0.0", main: "index.js" }),
        );
        write(root, "node_modules/safe/index.js", "module.exports = {};\n");
        return write(
          root,
          "src/index.js",
          "const path = require('path');\nconst Module = require('module');\nconst target = path.join(__dirname, '..', 'node_modules', 'vuln', 'index.js');\nObject.assign(Module, { _resolveFilename: function(){ return target; } });\nrequire('safe');\n",
        );
      },
    },
    {
      label:
        "deep const-alias chain to Module._load stays precise (no regression)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nconst A = Module;\nconst B = A;\nconst C = B;\nC._load('vuln', module, false);\n",
        );
      },
    },
    {
      label:
        "vm.runInThisContext executing a require of vuln (historical fix-5 blocker)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const vm = require('vm');\nvm.runInThisContext(\"require('\" + __dirname + \"/../node_modules/vuln')\")\n",
        );
      },
    },
    {
      label:
        "Module.wrapper[0] mutation injects a require of vuln into every subsequent module (historical fix-10 blocker)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        write(root, "src/target.js", "module.exports = {};\n");
        return write(
          root,
          "src/index.js",
          "const path = require('path');\nconst Module = require('module');\nModule.wrapper[0] = Module.wrapper[0] + \"require(" +
            "'\" + path.join(__dirname, '..', 'node_modules', 'vuln') + \"');\";\nrequire('./target.js');\n",
        );
      },
    },
    {
      label:
        "module.paths.unshift shadows a subsequent bare require (historical fix-9 blocker)",
      vulnInstanceRelPath: "shadow/vuln",
      setup: (root) => {
        markerPackage(root, "shadow/vuln");
        return write(
          root,
          "src/index.js",
          "const path = require('path');\nmodule.paths.unshift(path.join(__dirname, '..', 'shadow'));\nrequire('vuln');\n",
        );
      },
    },
  ];

  it.each(cases.map((c) => [c.label, c] as const))(
    "%s: complete=true never coexists with a real, unaccounted-for execution",
    async (_label, oracleCase) => {
      await runOracleCase(oracleCase);
    },
    20000,
  );
});
