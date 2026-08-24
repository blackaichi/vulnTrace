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
      // VT-307c-capability-flow Part 17: deliberately uses
      // `_preloadModules(['vuln'])` -- a loader primitive whose arguments
      // contain NO authoritative capability -- rather than `_load('vuln',
      // module, false)`. The `module` second argument `_load` legitimately
      // takes is ITSELF a capability, so an oracle case built on `_load`
      // gets flagged for that argument regardless of whether the
      // parameter-escape container shape under test is actually detected;
      // this masked five real violations in the prior task's own
      // round-trip check. `_preloadModules` genuinely isolates the
      // container/escape shape being tested.
      label: "Module passed as a parameter, callee loads vuln via it",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nfunction configure(x){ x._preloadModules(['vuln']); }\nconfigure(Module);\n",
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
          "const Module = require('module');\nconst registry = {};\nregistry.loader = Module;\nregistry.loader._preloadModules(['vuln']);\n",
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
          "const m = require('./holder.js');\nm.loader._preloadModules(['vuln']);\nmodule.exports = {};\n",
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

    // ---------------------------------------------------------------
    // VALUE-POSITION capability-flow grammar (VT-307c-capability-flow
    // Part 18) -- every case uses Module._preloadModules(['vuln']), a
    // loader primitive whose arguments contain NO authoritative
    // capability, so the container/escape shape under test is genuinely
    // isolated rather than incidentally masked by an argument (Part 17).
    // ---------------------------------------------------------------
    {
      label: "1. object literal Module: registry.loader._preloadModules([...])",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nconst registry = { loader: Module };\nregistry.loader._preloadModules(['vuln']);\n",
        );
      },
    },
    {
      label: "2. nested object literal Module",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nconst cfg = { deep: { loader: Module } };\ncfg.deep.loader._preloadModules(['vuln']);\n",
        );
      },
    },
    {
      label: "3. array literal Module: arr[0]._preloadModules([...])",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nconst arr = [Module];\narr[0]._preloadModules(['vuln']);\n",
        );
      },
    },
    {
      label: "4. concise arrow returning Module: get()._preloadModules([...])",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nconst get = () => Module;\nget()._preloadModules(['vuln']);\n",
        );
      },
    },
    {
      label:
        "5. default parameter Module: function f(x = Module){ x._preloadModules([...]) }",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nfunction f(x = Module){ x._preloadModules(['vuln']); }\nf();\n",
        );
      },
    },
    {
      label: "6. throw Module, caught and used to load vuln",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nfunction f(){ throw Module; }\ntry { f(); } catch (e) { e._preloadModules(['vuln']); }\n",
        );
      },
    },
    {
      label:
        "7. CJS object export containing Module, consumer loads vuln via it",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        write(
          root,
          "src/holder.js",
          "const Module = require('module');\nmodule.exports = { loader: Module };\n",
        );
        write(
          root,
          "src/consumer.js",
          "const h = require('./holder.js');\nh.loader._preloadModules(['vuln']);\nmodule.exports = {};\n",
        );
        return write(
          root,
          "src/index.js",
          "require('./holder.js');\nrequire('./consumer.js');\n",
        );
      },
    },
    {
      label: "8. object literal require: h.r('vuln')",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const h = { r: require };\nh.r('vuln');\n",
        );
      },
    },
    {
      label: "9. array literal require: a[0]('vuln')",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const a = [require];\na[0]('vuln');\n",
        );
      },
    },
    {
      label: "10. concise arrow returning require: get()('vuln')",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const get = () => require;\nget()('vuln');\n",
        );
      },
    },
    {
      label:
        "11. Module.prototype.constructor loader use (reflexive identity, real execution)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nModule.prototype.constructor._preloadModules(['vuln']);\n",
        );
      },
    },
    {
      label:
        "12. unknown member through Module.prototype.constructor (real, unmodeled, non-loading API -- no execution expected)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        // _readPackage is a REAL Node internal (pure read, no loading
        // effect on its own) that this classifier does NOT model as a
        // call-form member (only as an assignment target) -- calling it
        // through the reflexive Module.prototype.constructor chain must
        // still fail closed via the generic fallback, while genuinely not
        // executing vuln (a pure read cannot execute anything), so this
        // case exercises "closure incomplete, no real violation possible"
        // rather than a reproducible exploit.
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nconst dir = require('path').join(__dirname, 'node_modules', 'vuln');\nif (Module.prototype.constructor._readPackage) { Module.prototype.constructor._readPackage(dir); }\n",
        );
      },
    },
    {
      label: "13. direct safe require stays precise (no false positive)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(root, "src/index.js", "require('vuln');\n");
      },
    },
    {
      label: "14. safe const-alias chain stays precise (no false positive)",
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          "const Module = require('module');\nconst A = Module;\nconst B = A;\nB._preloadModules(['vuln']);\n",
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

/**
 * VT-307c-value-flow-closure's redesign of the oracle's CASE SELECTION
 * (this task's Parts 16-19).
 *
 * The invariant asserted by `runOracleCase` was never the problem, and is
 * unchanged. The problem was how cases got INTO the suite: they were
 * hand-written, one per defect someone had already thought of. That makes
 * the oracle structurally incapable of catching the one failure mode this
 * classifier keeps producing -- a value container nobody enumerated --
 * and it showed: the final go/no-go review found the suite reporting
 * 35/35 green while SEVEN live end-to-end violations sat in exactly that
 * blind spot, because not one of the missing container families
 * (destructuring defaults, class fields, logical operators) had a case.
 *
 * So the cases below are not written, they are DERIVED: a small
 * declarative grammar of the two things that actually vary --
 *
 *   capability SEED   x   value CONTAINER form
 *
 * -- with the suite being their cross product. Adding a container form
 * to the table adds it for every seed at once, and a container form the
 * table is missing is a visible, reviewable hole in a 30-row list rather
 * than an invisible absence among hundreds of lines of bespoke setup
 * functions. Every one of this task's twenty reproduced blockers is a
 * row here, and so are the shapes that already worked -- the point is to
 * pin the CLOSURE of the abstraction, not to accumulate spellings.
 *
 * Each generated program is exactly three parts: the seed's preamble, one
 * container form storing the capability, and the seed's own loader sink
 * applied to the expression that retrieves it back. The sink is always
 * capability-FREE (`_preloadModules(['vuln'])` takes an array of string
 * literals; `heldRequire('vuln')` takes one string literal), so the
 * container form under test is the only widening signal in the program --
 * the self-masking lesson from VT-307c-capability-flow, where cases built
 * on `_load('vuln', module, false)` were silently proving nothing because
 * that call's own `module` argument tripped the argument-escape check
 * regardless of the container being tested.
 */
interface CapabilitySeed {
  readonly name: string;
  /** Lines establishing the capability, if it is not already ambient. */
  readonly preamble: string;
  /** The expression text denoting the capability itself. */
  readonly capability: string;
  /** A capability-FREE loader call on the retrieved value. */
  readonly sink: (retrieved: string) => string;
}

const CAPABILITY_SEEDS: readonly CapabilitySeed[] = [
  {
    name: "Module",
    preamble: "const Module = require('module');\n",
    capability: "Module",
    sink: (retrieved) => `${retrieved}._preloadModules(['vuln']);\n`,
  },
  {
    name: "require",
    preamble: "",
    capability: "require",
    sink: (retrieved) => `${retrieved}('vuln');\n`,
  },
];

interface ContainerForm {
  readonly name: string;
  /** Source that puts `capability` into this container. */
  readonly store: (capability: string) => string;
  /** Expression text that retrieves the capability back at runtime. */
  readonly retrieve: string;
}

/**
 * The value-container grammar. Every row is a way JavaScript can carry a
 * value from one place to another; the classifier must not lose the
 * capability through any of them.
 */
const CONTAINER_FORMS: readonly ContainerForm[] = [
  {
    name: "direct const alias",
    store: (c) => `const held = ${c};\n`,
    retrieve: "held",
  },
  { name: "let binding", store: (c) => `let held = ${c};\n`, retrieve: "held" },
  { name: "var binding", store: (c) => `var held = ${c};\n`, retrieve: "held" },
  {
    name: "object property",
    store: (c) => `const box = { l: ${c} };\n`,
    retrieve: "box.l",
  },
  {
    name: "nested object property",
    store: (c) => `const box = { a: { l: ${c} } };\n`,
    retrieve: "box.a.l",
  },
  {
    name: "array element",
    store: (c) => `const box = [${c}];\n`,
    retrieve: "box[0]",
  },
  {
    name: "object spread of composite",
    store: (c) => `const inner = { l: ${c} };\nconst box = { ...inner };\n`,
    retrieve: "box.l",
  },
  {
    name: "array spread of composite",
    store: (c) => `const inner = [${c}];\nconst box = [...inner];\n`,
    retrieve: "box[0]",
  },
  {
    name: "conditional",
    store: (c) => `const held = process.env.VT_NEVER_SET ? null : ${c};\n`,
    retrieve: "held",
  },
  {
    name: "logical OR",
    store: (c) => `const held = process.env.VT_NEVER_SET || ${c};\n`,
    retrieve: "held",
  },
  {
    name: "logical AND",
    store: (c) => `const held = 1 && ${c};\n`,
    retrieve: "held",
  },
  {
    name: "nullish coalescing",
    store: (c) => `const held = process.env.VT_NEVER_SET ?? ${c};\n`,
    retrieve: "held",
  },
  {
    name: "logical assignment",
    store: (c) => `let held;\nheld ||= ${c};\n`,
    retrieve: "held",
  },
  {
    name: "sequence expression",
    store: (c) => `const held = (0, ${c});\n`,
    retrieve: "held",
  },
  {
    name: "nested logical + conditional + array",
    store: (c) =>
      `const box = process.env.VT_NEVER_SET || [process.env.VT_NEVER_SET ? null : ${c}];\n`,
    retrieve: "box[0]",
  },
  {
    name: "concise arrow return",
    store: (c) => `const get = () => ${c};\n`,
    retrieve: "get()",
  },
  {
    name: "explicit function return",
    store: (c) => `function get() { return ${c}; }\n`,
    retrieve: "get()",
  },
  {
    name: "object destructuring default",
    store: (c) => `const { l = ${c} } = {};\n`,
    retrieve: "l",
  },
  {
    name: "array destructuring default",
    store: (c) => `const [ l = ${c} ] = [];\n`,
    retrieve: "l",
  },
  {
    name: "nested destructuring default",
    store: (c) => `const { a: { l = ${c} } = {} } = {};\n`,
    retrieve: "l",
  },
  {
    name: "function parameter default",
    store: (c) => `function get(x = ${c}) { return x; }\n`,
    retrieve: "get()",
  },
  {
    name: "parameter destructuring default",
    store: (c) => `function get({ l = ${c} } = {}) { return l; }\n`,
    retrieve: "get()",
  },
  {
    name: "class instance field",
    store: (c) => `class Holder { l = ${c}; }\n`,
    retrieve: "new Holder().l",
  },
  {
    name: "class static field",
    store: (c) => `class Holder { static l = ${c}; }\n`,
    retrieve: "Holder.l",
  },
  {
    name: "computed-name class field",
    store: (c) => `const k = 'l';\nclass Holder { [k] = ${c}; }\n`,
    retrieve: "new Holder().l",
  },
  {
    name: "class field holding composite",
    store: (c) => `class Holder { l = { m: ${c} }; }\n`,
    retrieve: "new Holder().l.m",
  },
  {
    name: "Set literal",
    store: (c) => `const box = new Set([${c}]);\n`,
    retrieve: "[...box][0]",
  },
  {
    name: "Map literal",
    store: (c) => `const box = new Map([['k', ${c}]]);\n`,
    retrieve: "box.get('k')",
  },
  {
    name: "throw / catch",
    store: (c) =>
      `function raise() { throw ${c}; }\nlet held;\ntry { raise(); } catch (e) { held = e; }\n`,
    retrieve: "held",
  },
  {
    name: "generator yield",
    store: (c) => `function* gen() { yield ${c}; }\n`,
    retrieve: "gen().next().value",
  },
  {
    name: "for-of over array literal",
    store: (c) => `let held;\nfor (const m of [${c}]) { held = m; }\n`,
    retrieve: "held",
  },
  {
    name: "tagged template substitution",
    store: (c) =>
      `function tag(strings, value) { return value; }\nconst held = tag\`\${${c}}\`;\n`,
    retrieve: "held",
  },
  {
    name: "CommonJS composite export property",
    store: (c) => `exports.box = { l: ${c} };\n`,
    retrieve: "exports.box.l",
  },
];

describe("ModuleLoadClosure differential Node oracle: value-container grammar (VT-307c-value-flow-closure)", () => {
  const generated: OracleCase[] = CAPABILITY_SEEDS.flatMap((seed) =>
    CONTAINER_FORMS.map((form) => ({
      label: `${seed.name} via ${form.name}`,
      vulnInstanceRelPath: "node_modules/vuln",
      setup: (root: string) => {
        markerPackage(root, "node_modules/vuln");
        return write(
          root,
          "src/index.js",
          seed.preamble +
            form.store(seed.capability) +
            seed.sink(form.retrieve),
        );
      },
    })),
  );

  it.each(generated.map((c) => [c.label, c] as const))(
    "%s: complete=true never coexists with a real, unaccounted-for execution",
    async (_label, oracleCase) => {
      await runOracleCase(oracleCase);
    },
    20000,
  );
});
