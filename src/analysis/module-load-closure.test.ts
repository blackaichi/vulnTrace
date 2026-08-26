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
import { buildCallGraph } from "../code-intelligence/call-graph.js";
import { createModuleResolver } from "../code-intelligence/module-resolver.js";
import { loadTsProject } from "../code-intelligence/ts-project.js";
import type { DependencyNode } from "../domain/dependency.js";
import type { Entrypoint } from "../domain/entrypoint.js";
import {
  buildKnownPackageRoots,
  canonicalizePackageInstancePath,
  type KnownPackageRoots,
} from "../domain/resolved-target.js";
import {
  buildGateEligibleModuleLoadClosure,
  buildModuleLoadClosure,
  closureContainsFile,
  closureContainsPackageInstance,
  type ClosureIncompletenessReason,
  type ModuleLoadClosure,
} from "./module-load-closure.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vulntrace-closure-"));
  tempDirs.push(dir);
  return dir;
}

function write(root: string, relativePath: string, content: string): string {
  const filePath = path.join(root, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

function entrypoint(filePath: string, symbol?: string): Entrypoint {
  return {
    filePath,
    source: "configured",
    reason: "test",
    ...(symbol === undefined ? {} : { symbol }),
  };
}

/** A minimal synthetic DependencyNode, for building a test's own KnownPackageRoots (VT-307c-fix-4b). */
function dependencyNode(name: string, location: string): DependencyNode {
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

/**
 * Builds the closure with a real resolver, exactly as a caller would.
 *
 * Takes no call graph: since VT-307c-fix-3 the closure classifies loader
 * constructs itself, and depends on no other traversal's coverage.
 */
async function closureFor(
  root: string,
  entryFiles: readonly string[],
  options: {
    maxFiles?: number;
    symbol?: string;
    knownPackageRoots?: KnownPackageRoots;
  } = {},
): Promise<ModuleLoadClosure> {
  const project = loadTsProject(root);
  const resolver = createModuleResolver(project);
  return buildModuleLoadClosure({
    entrypoints: entryFiles.map((f) => entrypoint(f, options.symbol)),
    resolver,
    knownPackageRoots: options.knownPackageRoots,
    ...(options.maxFiles === undefined ? {} : { maxFiles: options.maxFiles }),
  });
}

function reasonsOf(closure: ModuleLoadClosure): ClosureIncompletenessReason[] {
  return [...new Set(closure.incompleteness.map((i) => i.reason))];
}

describe("ModuleLoadClosure: membership is module loading, not call binding (VT-307c)", () => {
  it("(1) leaves an installed but never-imported package OUT of the closure", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/never-imported/package.json",
      JSON.stringify({ name: "never-imported", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/never-imported/index.js",
      "module.exports = {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "function main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.loadedFiles).toEqual([entry]);
    expect(
      closure.loadedPackageInstances.some((i) => i.includes("never-imported")),
    ).toBe(false);
    expect(closure.complete).toBe(true);
  });

  it("(2) includes a package loaded by a static CJS require", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/pkg/package.json",
      JSON.stringify({ name: "pkg", version: "1.0.0" }),
    );
    const pkgEntry = write(
      root,
      "node_modules/pkg/index.js",
      "module.exports = { thing(){ return 1; } };\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "const pkg = require('pkg');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, pkgEntry)).toBe(true);
    expect(
      closureContainsPackageInstance(
        closure,
        path.join(root, "node_modules/pkg"),
      ),
    ).toBe(true);
    expect(closure.complete).toBe(true);
  });

  it("(3) includes a package loaded by an ESM side-effect import", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "node_modules/pkg/package.json",
      JSON.stringify({ name: "pkg", version: "1.0.0", type: "module" }),
    );
    const pkgEntry = write(
      root,
      "node_modules/pkg/index.js",
      "export const loaded = true;\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "import 'pkg';\nexport function main(){ return 1; }\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, pkgEntry)).toBe(true);
  });

  it("(4) includes a package loaded by a named or default import whose binding is never called (M)", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "node_modules/pkg/package.json",
      JSON.stringify({ name: "pkg", version: "1.0.0", type: "module" }),
    );
    const pkgEntry = write(
      root,
      "node_modules/pkg/index.js",
      "export function vulnerable(){ return 'v'; }\n",
    );
    const entry = write(
      root,
      "src/index.js",
      // `vulnerable` is imported and NEVER called -- the whole point of M:
      // module-load membership must not depend on call binding.
      "import { vulnerable } from 'pkg';\nexport function main(){ return 'never calls it'; }\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, pkgEntry)).toBe(true);
    expect(closure.complete).toBe(true);
  });

  it("(5) includes transitively loaded modules a -> b -> c", async () => {
    const root = tempProject();
    for (const [name, dep] of [
      ["a", "b"],
      ["b", "c"],
    ] as const) {
      write(
        root,
        `node_modules/${name}/package.json`,
        JSON.stringify({ name, version: "1.0.0" }),
      );
      write(
        root,
        `node_modules/${name}/index.js`,
        `const next = require('${dep}');\nmodule.exports = { use(){ return next; } };\n`,
      );
    }
    write(
      root,
      "node_modules/c/package.json",
      JSON.stringify({ name: "c", version: "1.0.0" }),
    );
    const cEntry = write(
      root,
      "node_modules/c/index.js",
      "module.exports = { deep(){ return 1; } };\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "const a = require('a');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, cEntry)).toBe(true);
    for (const name of ["a", "b", "c"]) {
      expect(
        closureContainsPackageInstance(
          closure,
          path.join(root, `node_modules/${name}`),
        ),
      ).toBe(true);
    }
    expect(closure.complete).toBe(true);
  });

  it("(6) treats a Node builtin as resolved, contributing no local file and no package instance", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const fs = require('fs');\nfunction main(){ return fs; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.loadedFiles).toEqual([entry]);
    expect(closure.loadedPackageInstances).toEqual([]);
    // A builtin is known, not an uncertainty -- it must not make the
    // closure incomplete (VT-305).
    expect(closure.complete).toBe(true);
  });

  it("(15) tracks sibling package instances by exact install location, never by shared package name", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "2.0.0" }),
    );
    write(
      root,
      "node_modules/foo/index.js",
      "module.exports = { v(){ return 2; } };\n",
    );
    write(
      root,
      "node_modules/bar/package.json",
      JSON.stringify({ name: "bar", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/bar/index.js",
      "const foo = require('foo');\nmodule.exports = { use(){ return foo; } };\n",
    );
    write(
      root,
      "node_modules/bar/node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/bar/node_modules/foo/index.js",
      "module.exports = { v(){ return 1; } };\n",
    );
    // Only `bar` is imported -- so only bar's OWN nested foo loads. The
    // top-level foo@2.0.0 is installed but never loaded by anything.
    const entry = write(
      root,
      "src/index.js",
      "const bar = require('bar');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(
      closureContainsPackageInstance(
        closure,
        path.join(root, "node_modules/bar/node_modules/foo"),
      ),
    ).toBe(true);
    expect(
      closureContainsPackageInstance(
        closure,
        path.join(root, "node_modules/foo"),
      ),
    ).toBe(false);
  });
});

describe("ModuleLoadClosure: entrypoint roots are FILES, never narrowed by symbol (VT-307c Part 2)", () => {
  it("roots at the whole file for a {file, symbol} entrypoint, so top-level imports still load", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "node_modules/pkg/package.json",
      JSON.stringify({ name: "pkg", version: "1.0.0", type: "module" }),
    );
    const pkgEntry = write(
      root,
      "node_modules/pkg/index.js",
      "export function unused(){ return 1; }\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "import { unused } from 'pkg';\n" +
        "export function main(){ return 'main'; }\n" +
        "export function other(){ return unused(); }\n",
    );

    // `main` is the configured symbol; `other` (the only caller of the
    // imported binding) is NOT a call-reachability source. The module is
    // loaded regardless.
    const closure = await closureFor(root, [entry], { symbol: "main" });

    expect(closure.rootFiles).toEqual([entry]);
    expect(closureContainsFile(closure, pkgEntry)).toBe(true);
  });

  it("produces an identical closure with and without a configured symbol", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "node_modules/pkg/package.json",
      JSON.stringify({ name: "pkg", version: "1.0.0", type: "module" }),
    );
    write(root, "node_modules/pkg/index.js", "export const x = 1;\n");
    const entry = write(
      root,
      "src/index.js",
      "import 'pkg';\nexport function main(){ return 1; }\nexport function other(){ return 2; }\n",
    );

    const withSymbol = await closureFor(root, [entry], { symbol: "main" });
    const withoutSymbol = await closureFor(root, [entry]);

    expect([...withSymbol.loadedFiles].sort()).toEqual(
      [...withoutSymbol.loadedFiles].sort(),
    );
  });
});

describe("ModuleLoadClosure: completeness is explicit (VT-307c Parts 5-7)", () => {
  it("(7) is incomplete for an unresolved module specifier, recording the specifier", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const missing = require('definitely-not-installed');\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(closure.incompleteness).toContainEqual(
      expect.objectContaining({
        reason: "unresolved_module",
        importer: entry,
        specifier: "definitely-not-installed",
      }),
    );
  });

  it("(8) is incomplete for a declaration-only resolution", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/types-only/package.json",
      JSON.stringify({ name: "types-only", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/types-only/index.d.ts",
      "export declare function vulnerable(x: string): string;\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      "import { vulnerable } from 'types-only';\nexport function main(){ return vulnerable('x'); }\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("declaration_only_resolution");
  });

  it.each([
    [
      "(9) dynamic require",
      "dynamic_require",
      "const n = process.env.P;\nfunction main(){ require(n); }\nmodule.exports = { main };\n",
    ],
    [
      "(10) aliased require",
      "aliased_require",
      "const r = require;\nconst n = process.env.P;\nfunction main(){ r(n); }\nmodule.exports = { main };\n",
    ],
    [
      "(11) createRequire loader",
      "create_require",
      "const { createRequire } = require('module');\nconst r = createRequire(__filename);\nconst n = process.env.P;\nfunction main(){ r(n); }\nmodule.exports = { main };\n",
    ],
    [
      "(12) Function constructor",
      "function_constructor",
      "function main(){ return new Function('return 1')(); }\nmodule.exports = { main };\n",
    ],
    [
      "(13) aliased eval",
      "aliased_eval",
      "const e = eval;\nfunction main(){ e('1'); }\nmodule.exports = { main };\n",
    ],
    [
      "(13b) globalThis.eval",
      "aliased_eval",
      "function main(){ globalThis.eval('1'); }\nmodule.exports = { main };\n",
    ],
    [
      "(14) module.require",
      "module_require",
      "const n = process.env.P;\nfunction main(){ module.require(n); }\nmodule.exports = { main };\n",
    ],
  ])("%s makes the closure incomplete", async (_label, reason, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain(reason);
  });

  it.each([
    [
      "(AC) vm.runInThisContext",
      "vm_execution",
      "const vm = require('vm');\nfunction main(){ vm.runInThisContext(process.env.C); }\nmodule.exports = { main };\n",
    ],
    [
      "(AD) vm.runInNewContext",
      "vm_execution",
      "const vm = require('vm');\nfunction main(){ vm.runInNewContext(process.env.C); }\nmodule.exports = { main };\n",
    ],
    [
      "(AE) vm.runInContext",
      "vm_execution",
      "const vm = require('vm');\nfunction main(){ vm.runInContext(process.env.C, {}); }\nmodule.exports = { main };\n",
    ],
    [
      "(AF) vm.compileFunction",
      "vm_execution",
      "const vm = require('vm');\nfunction main(){ vm.compileFunction(process.env.C); }\nmodule.exports = { main };\n",
    ],
    [
      "(AG) new vm.Script(...).runInThisContext()",
      "vm_execution",
      "const vm = require('vm');\nfunction main(){ new vm.Script(process.env.C).runInThisContext(); }\nmodule.exports = { main };\n",
    ],
    [
      "(AH) require('module').createRequire(...)(name) inline whole-module form",
      "create_require",
      "function main(){ const r = require('module').createRequire(__filename); r(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "(AI) require.main.require(name)",
      "module_require",
      "function main(){ require.main.require(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "(AJ) authoritative Module._load(name)",
      "module_internal_load",
      "const Module = require('module');\nfunction main(){ Module._load(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "(AK) Node Worker",
      "worker_execution",
      "const { Worker } = require('worker_threads');\nfunction main(){ new Worker(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "(AL) child_process.fork",
      "child_process_execution",
      "const cp = require('child_process');\nfunction main(){ cp.fork(process.env.P); }\nmodule.exports = { main };\n",
    ],
  ])(
    "%s makes the closure incomplete (VT-307c-fix-5)",
    async (_label, reason, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toContain(reason);
    },
  );

  it("(AG control) constructing a vm.Script alone, with no execution method ever called, does not make the closure incomplete", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const vm = require('vm');\nfunction main(){ return new vm.Script(process.env.C); }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    // Compiling doesn't execute anything until a run method is called --
    // see loader-constructs.ts's own doc comment on `BUILTIN_MEMBER_REASONS`
    // deliberately excluding vm's `Script` export.
    expect(closure.complete).toBe(true);
    expect(closure.incompleteness).toEqual([]);
  });

  it.each([
    [
      "a user-defined object named vm with its own runInThisContext method (precision control 1)",
      "vm_execution",
      "const vm = { runInThisContext(){ return 1; } };\nfunction main(){ vm.runInThisContext(process.env.C); }\nmodule.exports = { main };\n",
    ],
    [
      "a user-defined object with its own _load method (precision control 2)",
      "module_internal_load",
      "const Module = { _load(){ return 1; } };\nfunction main(){ Module._load(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "a user-defined function named fork (precision control 3)",
      "child_process_execution",
      "function fork(x){ return x; }\nfunction main(){ fork(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "a user-defined class named Worker (precision control 4)",
      "worker_execution",
      "class Worker { constructor(x){ this.x = x; } }\nfunction main(){ new Worker(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "a user-defined object named createRequire with no Node module relationship (precision control 5)",
      "create_require",
      "const module_ = { createRequire(){ return () => {}; } };\nfunction main(){ const r = module_.createRequire(__filename); r(process.env.P); }\nmodule.exports = { main };\n",
    ],
  ])(
    "stays complete for %s -- no import binding to the real Node builtin (VT-307c-fix-5 Part 16)",
    async (_label, reason, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(reasonsOf(closure)).not.toContain(reason);
    },
  );

  it("stays complete for an ordinary non-widening unsupported construct (precision control)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "function main(token){ return token.trim(); }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    // token.trim() cannot introduce a module, so it must not make the
    // closure incomplete -- otherwise every real project would be
    // permanently incomplete and the closure would carry no information.
    expect(closure.complete).toBe(true);
    expect(closure.incompleteness).toEqual([]);
  });

  it("(V) is incomplete when a closure member cannot be parsed/indexed", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/broken/package.json",
      JSON.stringify({ name: "broken", version: "1.0.0" }),
    );
    // A real file that exists and genuinely loads at runtime, but that
    // this analyzer cannot index -- so its own imports are unknown.
    const brokenEntry = path.join(root, "node_modules/broken/index.js");
    mkdirSync(path.dirname(brokenEntry), { recursive: true });
    rmSync(brokenEntry, { force: true });
    mkdirSync(brokenEntry); // a directory where a file is expected -> unreadable

    const entry = write(
      root,
      "src/index.js",
      "const broken = require('broken');\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    // Either the specifier fails to resolve to a readable file, or it
    // resolves and then fails to index -- both are honest incompleteness,
    // never silent success.
    expect(
      reasonsOf(closure).some(
        (r) => r === "parse_failure" || r === "unresolved_module",
      ),
    ).toBe(true);
  });

  it("(V) is incomplete when a closure member is present but syntactically unindexable", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/weird/package.json",
      JSON.stringify({ name: "weird", version: "1.0.0" }),
    );
    write(root, "node_modules/weird/index.js", "module.exports = {};\n");
    const entry = write(
      root,
      "src/index.js",
      "const weird = require('weird');\nmodule.exports = {};\n",
    );
    // Replace the resolved file with an unreadable directory AFTER
    // resolution would have succeeded, so traversal reaches the indexing
    // step and fails there specifically.
    const weirdEntry = path.join(root, "node_modules/weird/index.js");
    rmSync(weirdEntry, { force: true });
    mkdirSync(weirdEntry);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
  });

  it("(U) is incomplete when traversal hits the configured file limit", async () => {
    const root = tempProject();
    for (const [name, dep] of [
      ["a", "b"],
      ["b", "c"],
    ] as const) {
      write(
        root,
        `node_modules/${name}/package.json`,
        JSON.stringify({ name, version: "1.0.0" }),
      );
      write(
        root,
        `node_modules/${name}/index.js`,
        `const next = require('${dep}');\nmodule.exports = { next };\n`,
      );
    }
    write(
      root,
      "node_modules/c/package.json",
      JSON.stringify({ name: "c", version: "1.0.0" }),
    );
    write(root, "node_modules/c/index.js", "module.exports = {};\n");
    const entry = write(
      root,
      "src/index.js",
      "const a = require('a');\nmodule.exports = { a };\n",
    );

    const unbounded = await closureFor(root, [entry]);
    expect(unbounded.complete).toBe(true);
    expect(unbounded.loadedFiles.length).toBe(4);

    const truncated = await closureFor(root, [entry], { maxFiles: 2 });

    expect(truncated.complete).toBe(false);
    expect(reasonsOf(truncated)).toContain("traversal_truncated");
    expect(truncated.loadedFiles.length).toBeLessThan(4);
  });
});

describe("ModuleLoadClosure: independence from call binding (VT-307c Parts 3, 11)", () => {
  it("(T) includes a package reached only through an export-resolution gap the call graph cannot bind", async () => {
    const root = tempProject();
    // `ms`-shaped: `inner` is loaded by `outer`'s own top-level require and
    // re-exported as a whole-module value. The rule-relevant export can't
    // be attributed through that cross-package re-export (RWF-004), so the
    // call graph never binds a call into `inner` -- but `inner` genuinely
    // loads, and must be in the closure.
    write(
      root,
      "node_modules/inner/package.json",
      JSON.stringify({ name: "inner", version: "1.0.0" }),
    );
    const innerEntry = write(
      root,
      "node_modules/inner/index.js",
      "module.exports = function humanize(x){ return x; };\n",
    );
    write(
      root,
      "node_modules/outer/package.json",
      JSON.stringify({ name: "outer", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/outer/index.js",
      "exports.humanize = require('inner');\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "const outer = require('outer');\n" +
        "function main(d){ return outer.humanize(d); }\n" +
        "module.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, innerEntry)).toBe(true);
    expect(
      closureContainsPackageInstance(
        closure,
        path.join(root, "node_modules/inner"),
      ),
    ).toBe(true);
  });

  it("marks the closure incomplete for a dynamic loader at a transitively-loaded module's TOP LEVEL", async () => {
    const root = tempProject();
    write(
      root,
      "src/consumer.js",
      "const n = process.env.P;\nrequire(n);\nmodule.exports = { useIt(){ return 1; } };\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "const c = require('./consumer.js');\nfunction main(){ return c.useIt(); }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(closure.incompleteness).toContainEqual(
      expect.objectContaining({
        reason: "dynamic_require",
        importer: path.join(root, "src/consumer.js"),
      }),
    );
  });
});

describe("ModuleLoadClosure: recovered-but-invalid syntax must not read as a complete closure (VT-307c-fix-2, Regression Z)", () => {
  it("(Z1) an unterminated block comment that swallows a require() marks the closure incomplete with parse_failure", async () => {
    const root = tempProject();
    const brokenEntry = write(
      root,
      "src/broken.js",
      "/* unterminated comment\nrequire('target')\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('./broken.js');\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    // The broken module really does load at runtime -- it must stay IN
    // loadedFiles even though this analyzer cannot soundly parse it.
    expect(closure.loadedFiles).toContain(brokenEntry);
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("parse_failure");
  });

  it("(Z2) an unterminated template literal that swallows a require() marks the closure incomplete with parse_failure", async () => {
    const root = tempProject();
    const brokenEntry = write(
      root,
      "src/broken.js",
      "const x = `unterminated template\nrequire('target')\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('./broken.js');\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.loadedFiles).toContain(brokenEntry);
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("parse_failure");
  });

  it("(Z3, control) a syntax error that leaves an earlier require() intact in the recovered AST still marks the closure incomplete", async () => {
    const root = tempProject();
    // TypeScript's recovered AST for this file still contains the FIRST
    // require() call intact -- the syntax error is further down. Naively
    // trusting "imports extracted from the AST" would make this file look
    // completely understood; the parse failure itself must be the
    // authoritative signal regardless of what the partial AST contains.
    const brokenEntry = write(
      root,
      "src/broken.js",
      "require('target');\nfunction broken( {\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('./broken.js');\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.loadedFiles).toContain(brokenEntry);
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("parse_failure");
  });
});

describe("ModuleLoadClosure: parse_failure precision -- syntax errors only, never semantic ones (VT-307c-fix-2 Part 8)", () => {
  it("stays complete for valid-but-unusual JS syntax the parser fully supports", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "class Foo { #x = 1; static count = 0; static { Foo.count++; } getX(){ return this.#x; } }\n" +
        "function main(){ return new Foo().getX(); }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(true);
    expect(closure.incompleteness).toEqual([]);
  });

  it("stays complete for syntactically valid but type-invalid TypeScript (no parse_failure from type errors)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "const x: number = 'not a number';\nexport function main(){ return x; }\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(true);
    expect(closure.incompleteness).toEqual([]);
  });
});

describe("ModuleLoadClosure: completeness is independent of call-graph coverage (VT-307c-fix-3, Regressions AA/AB)", () => {
  const MID_DYNAMIC =
    "const n = process.env.P;\nrequire(n);\nmodule.exports = { use(){ return 1; } };\n";
  const MID_CLEAN =
    "function helper(){ return 1; }\nmodule.exports = { use(){ return helper(); } };\n";
  const ENTRY =
    "const mid = require('./mid.js');\nfunction main(){ return mid.use(); }\nmodule.exports = { main };\n";

  /**
   * Builds a call graph truncated to `maxFiles`, purely to demonstrate
   * that the closure's own answer does not move when it changes. The
   * graph is deliberately NOT handed to the closure -- it cannot be, since
   * VT-307c-fix-3 -- so this only establishes how little the call graph
   * saw.
   */
  async function graphWalkedFiles(
    root: string,
    entry: string,
    maxFiles: number,
  ): Promise<string[]> {
    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    const graph = await buildCallGraph({
      entryFiles: [entry],
      resolver,
      project,
      maxFiles,
    });
    return [...new Set(graph.nodes.map((n) => n.module))];
  }

  it("(AA) stays incomplete for a transitively-loaded file's top-level dynamic require even when the call graph never walked it", async () => {
    const root = tempProject();
    const mid = write(root, "src/mid.js", MID_DYNAMIC);
    const entry = write(root, "src/index.js", ENTRY);

    // Establish that a truncated call graph really does miss `mid`
    // entirely -- this is the precondition that used to make the closure
    // silently complete (the VT-307d review's Blocker 3).
    expect(await graphWalkedFiles(root, entry, 1)).not.toContain(mid);

    const closure = await closureFor(root, [entry]);

    expect(closure.loadedFiles).toContain(mid);
    expect(closure.complete).toBe(false);
    expect(closure.incompleteness).toContainEqual(
      expect.objectContaining({ reason: "dynamic_require", importer: mid }),
    );
  });

  it("(AB) classifies a closure-loaded file the call graph never walked, rather than assuming it clean", async () => {
    const root = tempProject();
    // `mid` is loaded for side effects only, so NOTHING in it is ever
    // call-reachable and no call graph, truncated or not, has any reason
    // to walk into it -- yet its top-level eval can load anything.
    const mid = write(
      root,
      "src/mid.js",
      "eval(process.env.CODE);\nmodule.exports = {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('./mid.js');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.loadedFiles).toContain(mid);
    expect(closure.complete).toBe(false);
    expect(closure.incompleteness).toContainEqual(
      expect.objectContaining({ reason: "eval", importer: mid }),
    );
  });

  it("(AB) finds a loader inside a function of a loaded file that no entrypoint ever calls", async () => {
    const root = tempProject();
    // `neverCalled` is unreachable from the entrypoint, so the call graph
    // never classifies its `require(n)`. Deciding it can't run is a CALL
    // reachability question the closure deliberately does not answer, so
    // the honest answer here is "unknown", not "clean".
    const mid = write(
      root,
      "src/mid.js",
      "const n = process.env.P;\n" +
        "function neverCalled(){ return require(n); }\n" +
        "module.exports = { use(){ return 1; } };\n",
    );
    const entry = write(root, "src/index.js", ENTRY);

    const closure = await closureFor(root, [entry]);

    expect(closure.loadedFiles).toContain(mid);
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("dynamic_require");
  });

  it("(control) stays COMPLETE for a clean transitively-loaded file, however little of it the call graph walked", async () => {
    const root = tempProject();
    const mid = write(root, "src/mid.js", MID_CLEAN);
    const entry = write(root, "src/index.js", ENTRY);

    expect(await graphWalkedFiles(root, entry, 1)).not.toContain(mid);

    const closure = await closureFor(root, [entry]);

    // The closure read `mid` itself and found no loader in it. Call
    // reachability was truncated to nothing, and that must NOT cost the
    // closure its completeness -- otherwise the fix would trade one
    // unsound answer for a useless one.
    expect(closure.loadedFiles).toContain(mid);
    expect(closure.complete).toBe(true);
    expect(closure.incompleteness).toEqual([]);
  });

  it("(control) a dynamic loader in an installed but NEVER-LOADED file does not affect the closure", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/never-imported/package.json",
      JSON.stringify({ name: "never-imported", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/never-imported/index.js",
      "const n = process.env.P;\nrequire(n);\nmodule.exports = {};\n",
    );
    const entry = write(root, "src/index.js", MID_CLEAN);

    const closure = await closureFor(root, [entry]);

    // Scoping is still by closure MEMBERSHIP: a loader in code no
    // entrypoint ever loads says nothing about this closure.
    expect(closure.complete).toBe(true);
    expect(closure.incompleteness).toEqual([]);
  });
});

describe("ModuleLoadClosure: agrees with VT-307a module_load edges (VT-307c Part 13)", () => {
  it("every resolved module_load edge target is a closure member, and every non-root closure member is a module_load target", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/pkg/package.json",
      JSON.stringify({ name: "pkg", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/pkg/index.js",
      "const dep = require('dep');\nmodule.exports = { use(){ return dep; } };\n",
    );
    write(
      root,
      "node_modules/dep/package.json",
      JSON.stringify({ name: "dep", version: "1.0.0" }),
    );
    write(root, "node_modules/dep/index.js", "module.exports = { d: 1 };\n");
    write(
      root,
      "src/local.js",
      "module.exports = { helper(){ return 1; } };\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "const pkg = require('pkg');\n" +
        "const local = require('./local.js');\n" +
        "function main(){ return local.helper(); }\n" +
        "module.exports = { main };\n",
    );

    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    const graph = await buildCallGraph({
      entryFiles: [entry],
      resolver,
      project,
    });
    const closure = await buildModuleLoadClosure({
      entrypoints: [entrypoint(entry)],
      resolver,
    });

    const moduleByNodeId = new Map(graph.nodes.map((n) => [n.id, n.module]));
    const moduleLoadTargets = new Set<string>();
    for (const edge of graph.edges) {
      if (edge.type !== "module_load" || edge.resolution.kind !== "resolved") {
        continue;
      }
      const target = moduleByNodeId.get(edge.resolution.target);
      if (target) {
        moduleLoadTargets.add(target);
      }
    }

    // Direction 1: nothing the graph says is loaded is missing from the closure.
    for (const target of moduleLoadTargets) {
      expect(closureContainsFile(closure, target)).toBe(true);
    }
    // Direction 2: nothing the closure says is loaded is missing from the graph.
    for (const file of closure.loadedFiles) {
      if (closure.rootFiles.includes(file)) {
        continue;
      }
      expect(moduleLoadTargets.has(file)).toBe(true);
    }
  });
});

describe("ModuleLoadClosure: package-instance identity survives symlinked installs (VT-307c-fix-4/4b, VT-307d review Blocker A)", () => {
  it("(pnpm-style) closureContainsPackageInstance recognizes a package reached through a pnpm-store symlink, keyed by the canonicalized LOGICAL location", async () => {
    const root = tempProject();
    const real = "node_modules/.pnpm/foo@1.0.0/node_modules/foo";
    write(
      root,
      `${real}/package.json`,
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      `${real}/index.js`,
      "module.exports = { vulnerable(){ return 1; } };\n",
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, real),
      path.join(root, "node_modules/foo"),
      "dir",
    );
    const entry = write(
      root,
      "src/index.js",
      "const foo = require('foo');\nfunction main(){ return foo.vulnerable(); }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    // The finding side's own authority (VT-212, canonicalized VT-307c-fix-4
    // the same way `cli/scan.ts` does): the LOGICAL, lockfile-derived
    // install location -- never the closure's own already-physical path.
    const findingInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo"),
    );

    expect(closure.complete).toBe(true);
    expect(closureContainsPackageInstance(closure, findingInstance)).toBe(true);
  });

  it("(workspace/external symlink) closureContainsPackageInstance recognizes a package whose physical target lives outside node_modules entirely", async () => {
    const workspaceRoot = tempProject();
    const projectRoot = path.join(workspaceRoot, "app");
    write(
      workspaceRoot,
      "packages/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      workspaceRoot,
      "packages/foo/index.js",
      "module.exports = { vulnerable(){ return 1; } };\n",
    );
    mkdirSync(path.join(projectRoot, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(workspaceRoot, "packages/foo"),
      path.join(projectRoot, "node_modules/foo"),
      "dir",
    );
    const entry = write(
      projectRoot,
      "src/index.js",
      "const foo = require('foo');\nfunction main(){ return foo.vulnerable(); }\nmodule.exports = { main };\n",
    );

    // The scan's own dependency-provenance registry (VT-307c-fix-4b): the
    // dependency graph names `node_modules/foo` as foo's install location,
    // exactly as cli/scan.ts's own DependencyNode.locations would.
    const knownPackageRoots = buildKnownPackageRoots(
      [dependencyNode("foo", "node_modules/foo")],
      projectRoot,
    );
    const closure = await closureFor(projectRoot, [entry], {
      knownPackageRoots,
    });

    const findingInstance = canonicalizePackageInstancePath(
      path.join(projectRoot, "node_modules/foo"),
    );

    expect(closure.complete).toBe(true);
    expect(closureContainsPackageInstance(closure, findingInstance)).toBe(true);
  });

  it("(in-tree workspace, scanned AT the monorepo root -- VT-307c-fix-4b Blocker A) closureContainsPackageInstance recognizes a linked package whose physical target lives INSIDE projectRoot", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "monorepo", workspaces: ["packages/*"] }),
    );
    write(
      root,
      "packages/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "packages/foo/index.js",
      "module.exports = { vulnerable(){ return 1; } };\n",
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "packages/foo"),
      path.join(root, "node_modules/foo"),
      "dir",
    );
    const entry = write(
      root,
      "src/index.js",
      "const foo = require('foo');\nfunction main(){ return foo.vulnerable(); }\nmodule.exports = { main };\n",
    );

    // This is exactly VT-307c-fix-4's own blind spot: the physical target
    // (packages/foo) is INSIDE projectRoot, which fix-4's `projectRoot`-
    // escape check silently refused to attribute. Provenance -- foo being
    // a real dependency-graph location -- must not depend on containment.
    const knownPackageRoots = buildKnownPackageRoots(
      [dependencyNode("foo", "node_modules/foo")],
      root,
    );
    const closure = await closureFor(root, [entry], { knownPackageRoots });

    const findingInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo"),
    );

    expect(closure.complete).toBe(true);
    expect(closureContainsPackageInstance(closure, findingInstance)).toBe(true);
  });

  it("(own-project negative control) never attributes the scanned project's own root package to a PackageInstance, even though it has its own package.json", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    const entry = write(
      root,
      "src/lib.js",
      "function main(){ return 1; }\nmodule.exports = { main };\n",
    );

    // Empty registry: the scanned project's own package.json is never a
    // DependencyNode location, so it can never appear here.
    const knownPackageRoots = buildKnownPackageRoots([], root);
    const closure = await closureFor(root, [entry], { knownPackageRoots });

    expect(closure.complete).toBe(true);
    expect(closure.loadedPackageInstances).toEqual([]);
  });

  it("(unknown in-tree package.json negative control) an in-tree directory with its own package.json that is NOT a known dependency location gets no PackageInstance", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    write(
      root,
      "internal/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "internal/foo/index.js",
      "module.exports = { vulnerable(){ return 1; } };\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "const foo = require('../internal/foo');\nfunction main(){ return foo.vulnerable(); }\nmodule.exports = { main };\n",
    );

    // `internal/foo` is a real, package.json-bearing, in-tree directory --
    // but it is NOT in the dependency-provenance registry (the registry is
    // empty here), so it must not be attributed a PackageInstance merely
    // because it looks like a package. This proves provenance, not
    // "has a package.json", is the criterion (VT-307c-fix-4b Part 11).
    const knownPackageRoots = buildKnownPackageRoots([], root);
    const closure = await closureFor(root, [entry], { knownPackageRoots });

    expect(closure.complete).toBe(true);
    expect(closure.loadedPackageInstances).toEqual([]);
  });

  it("(most-specific-root wins) a source file under a nested known root resolves to that nested root, never a less-specific ancestor", async () => {
    const root = tempProject();
    write(
      root,
      "packages/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "packages/foo/index.js",
      "const bar = require('./node_modules/bar');\nmodule.exports = { use(){ return bar.vulnerable(); } };\n",
    );
    write(
      root,
      "packages/foo/node_modules/bar/package.json",
      JSON.stringify({ name: "bar", version: "1.0.0" }),
    );
    write(
      root,
      "packages/foo/node_modules/bar/index.js",
      "module.exports = { vulnerable(){ return 1; } };\n",
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "packages/foo"),
      path.join(root, "node_modules/foo"),
      "dir",
    );
    const entry = write(
      root,
      "src/index.js",
      "const foo = require('foo');\nfunction main(){ return foo.use(); }\nmodule.exports = { main };\n",
    );

    const knownPackageRoots = buildKnownPackageRoots(
      [dependencyNode("foo", "node_modules/foo")],
      root,
    );
    const closure = await closureFor(root, [entry], { knownPackageRoots });

    // bar has its own node_modules segment (packages/foo/node_modules/bar),
    // so it is identified through the ordinary node_modules-segment branch,
    // not the registry -- proving foo's own registry entry never
    // "swallows" a deeper, independently-identified nested install.
    const fooInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo"),
    );
    const barInstance = path.join(root, "packages/foo/node_modules/bar");

    expect(closure.complete).toBe(true);
    expect(closureContainsPackageInstance(closure, fooInstance)).toBe(true);
    expect(closureContainsPackageInstance(closure, barInstance)).toBe(true);
  });

  it("(prefix-collision safety) two known roots with one name a prefix of the other never collide", async () => {
    const root = tempProject();
    for (const name of ["foo", "foobar"]) {
      write(
        root,
        `packages/${name}/package.json`,
        JSON.stringify({ name, version: "1.0.0" }),
      );
      write(
        root,
        `packages/${name}/index.js`,
        `module.exports = { vulnerable(){ return '${name}'; } };\n`,
      );
    }
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "packages/foobar"),
      path.join(root, "node_modules/foobar"),
      "dir",
    );
    const entry = write(
      root,
      "src/index.js",
      "const foobar = require('foobar');\nfunction main(){ return foobar.vulnerable(); }\nmodule.exports = { main };\n",
    );

    const knownPackageRoots = buildKnownPackageRoots(
      [
        dependencyNode("foo", "node_modules/foo"),
        dependencyNode("foobar", "node_modules/foobar"),
      ],
      root,
    );
    const closure = await closureFor(root, [entry], { knownPackageRoots });

    const fooInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo"),
    );
    const foobarInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foobar"),
    );

    expect(closure.complete).toBe(true);
    expect(closureContainsPackageInstance(closure, foobarInstance)).toBe(true);
    expect(closureContainsPackageInstance(closure, fooInstance)).toBe(false);
  });

  it("(negative control) an installed but never-imported symlinked package stays OUT of the closure", async () => {
    const root = tempProject();
    const real = "node_modules/.pnpm/foo@1.0.0/node_modules/foo";
    write(
      root,
      `${real}/package.json`,
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(root, `${real}/index.js`, "module.exports = {};\n");
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, real),
      path.join(root, "node_modules/foo"),
      "dir",
    );
    const entry = write(
      root,
      "src/index.js",
      "function main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    const findingInstance = canonicalizePackageInstancePath(
      path.join(root, "node_modules/foo"),
    );

    expect(closure.complete).toBe(true);
    expect(closureContainsPackageInstance(closure, findingInstance)).toBe(
      false,
    );
  });
});

describe("ModuleLoadClosure: Node Module-constructor loading primitives and child_process API coverage (VT-307c-fix-6)", () => {
  it.each([
    [
      "(A) Module.prototype.require.call(module, name)",
      "const Module = require('module');\nfunction main(){ Module.prototype.require.call(module, process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "(B) module.constructor._load(name)",
      "function main(){ module.constructor._load(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "(C) require('module').Module._load(name)",
      "function main(){ require('module').Module._load(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "(D) new M.Module('x').load(name)",
      "const M = require('module');\nfunction main(){ new M.Module('x').load(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "(E) M.Module.prototype.load.call(modObj, name)",
      "const M = require('node:module');\nconst modObj = new M.Module('y');\nfunction main(){ M.Module.prototype.load.call(modObj, process.env.P); }\nmodule.exports = { main };\n",
    ],
  ])(
    "%s makes the closure incomplete (module_internal_load)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toContain("module_internal_load");
    },
  );

  it.each([
    [
      "1 UserModule.prototype.require.call(...) -- no Node Module provenance",
      "class UserModule { require(x){ return x; } }\nfunction main(){ UserModule.prototype.require.call({}, process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "2 obj.constructor._load(...) -- root is not the ambient `module`",
      "const obj = {};\nfunction main(){ obj.constructor._load(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "3 user.Module._load(...) -- `user` is not module-builtin-bound",
      "const user = { Module: { _load(){} } };\nfunction main(){ user.Module._load(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "4 new UserModule().load(...) -- UserModule is not Node's Module",
      "class UserModule { load(x){ return x; } }\nfunction main(){ new UserModule().load(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "5 user.Module.prototype.load.call(...) -- no Node Module provenance",
      "const user = { Module: { prototype: { load(){} } } };\nfunction main(){ user.Module.prototype.load.call({}, process.env.P); }\nmodule.exports = { main };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-fix-6 Part 8 precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(reasonsOf(closure)).not.toContain("module_internal_load");
    },
  );

  it.each([
    ["exec", "cp.exec(process.env.P);"],
    ["execSync", "cp.execSync(process.env.P);"],
    ["execFile", "cp.execFile(process.env.P);"],
    ["execFileSync", "cp.execFileSync(process.env.P);"],
    ["spawn", "cp.spawn(process.env.P);"],
    ["spawnSync", "cp.spawnSync(process.env.P);"],
    ["fork", "cp.fork(process.env.P);"],
  ])(
    "(child_process policy) cp.%s(...) makes the closure incomplete (VT-307c-fix-6 Part 9)",
    async (_label, statement) => {
      const root = tempProject();
      const entry = write(
        root,
        "src/index.js",
        `const cp = require('child_process');\nfunction main(){ ${statement} }\nmodule.exports = { main };\n`,
      );

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toContain("child_process_execution");
    },
  );

  it("(child_process policy) a user-defined function coincidentally named exec/spawn is never flagged (precision control)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "function exec(x){ return x; }\nconst spawn = (x) => x;\nfunction main(){ exec(process.env.P); spawn(process.env.P); }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(true);
    expect(closure.incompleteness).toEqual([]);
  });
});

describe("ModuleLoadClosure: require.extensions loader-hook mutation (VT-307c-fix-6 Part 11)", () => {
  it.each([
    [
      "require.extensions['.js'] = hook (element access)",
      "require.extensions['.js'] = function(m, f){ return m; };\nmodule.exports = {};\n",
    ],
    [
      "require.extensions.js = hook (property access)",
      "require.extensions.js = function(m, f){ return m; };\nmodule.exports = {};\n",
    ],
  ])(
    "%s makes the closure incomplete (loader_hook_mutation)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toContain("loader_hook_mutation");
    },
  );

  it("(transitive dependency) a require.extensions mutation in a loaded dependency's own module scope still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/foo/index.js",
      "require.extensions['.js'] = function(m, f){ return m; };\nmodule.exports = {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('foo');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it("(precision control) obj.extensions['.js'] = hook is NOT classified -- obj is not the ambient require", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const obj = {};\nobj.extensions['.js'] = function(m, f){ return m; };\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(true);
    expect(reasonsOf(closure)).not.toContain("loader_hook_mutation");
  });
});

describe("ModuleLoadClosure: remaining same-realm Node loader/execution spellings (VT-307c-fix-7)", () => {
  it.each([
    [
      "(A) module._compile(code, filename)",
      "function main(){ module._compile(process.env.P, __filename); }\nmodule.exports = { main };\n",
      "vm_execution",
    ],
    [
      "(B) module._compile.call(module, code, filename)",
      "function main(){ module._compile.call(module, process.env.P, __filename); }\nmodule.exports = { main };\n",
      "vm_execution",
    ],
    [
      "(C) new M.Module('x')._compile(code, filename)",
      "const M = require('module');\nfunction main(){ new M.Module('x')._compile(process.env.P, __filename); }\nmodule.exports = { main };\n",
      "vm_execution",
    ],
    [
      "(D) M.Module.prototype._compile.call(instance, code, filename)",
      "const M = require('node:module');\nconst modObj = new M.Module('y');\nfunction main(){ M.Module.prototype._compile.call(modObj, process.env.P, __filename); }\nmodule.exports = { main };\n",
      "vm_execution",
    ],
    [
      "(E) M._extensions['.js'] = hook (M = require('module'))",
      "const M = require('module');\nM._extensions['.js'] = function(m, f){ return m; };\nmodule.exports = {};\n",
      "loader_hook_mutation",
    ],
    [
      "(F) module.constructor._extensions['.js'] = hook",
      "module.constructor._extensions['.js'] = function(m, f){ return m; };\nmodule.exports = {};\n",
      "loader_hook_mutation",
    ],
    [
      "(G) require('module').Module._extensions['.js'] = hook",
      "require('module').Module._extensions['.js'] = function(m, f){ return m; };\nmodule.exports = {};\n",
      "loader_hook_mutation",
    ],
    [
      "(H) M.register(hookSpecifier) (M = require('module'))",
      "const M = require('module');\nfunction main(){ M.register(process.env.P); }\nmodule.exports = { main };\n",
      "loader_hook_mutation",
    ],
    [
      "(I) const { register } = require('module'); register(hookSpecifier)",
      "const { register } = require('module');\nfunction main(){ register(process.env.P); }\nmodule.exports = { main };\n",
      "loader_hook_mutation",
    ],
    [
      "(J) module.constructor.createRequire(filename)(name)",
      "function main(){ module.constructor.createRequire(__filename)(process.env.P); }\nmodule.exports = { main };\n",
      "create_require",
    ],
    [
      "(K) const r = module.constructor.createRequire(filename); r(name);",
      "const r = module.constructor.createRequire(__filename);\nfunction main(){ r(process.env.P); }\nmodule.exports = { main };\n",
      "create_require",
    ],
    [
      "(L) require.main.constructor._load(name)",
      "function main(){ require.main.constructor._load(process.env.P); }\nmodule.exports = { main };\n",
      "module_internal_load",
    ],
    [
      "(M) new vm.SourceTextModule(code).evaluate()",
      "const vm = require('vm');\nasync function main(){ await new vm.SourceTextModule(process.env.P).evaluate(); }\nmodule.exports = { main };\n",
      "vm_execution",
    ],
    [
      "(N) const mod = new vm.SourceTextModule(code); mod.evaluate();",
      "const vm = require('vm');\nconst mod = new vm.SourceTextModule(process.env.P);\nasync function main(){ await mod.evaluate(); }\nmodule.exports = { main };\n",
      "vm_execution",
    ],
  ])("%s makes the closure incomplete (%s)", async (_label, source, reason) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain(reason as ClosureIncompletenessReason);
  });

  it.each([
    [
      "1 UserModule._compile(...) -- no Node Module provenance",
      "class UserModule { _compile(c,f){ return c; } }\nfunction main(){ new UserModule()._compile(process.env.P, 'x'); }\nmodule.exports = { main };\n",
    ],
    [
      "2 obj._extensions[...] = hook -- obj is not the Module constructor",
      "const obj = { _extensions: {} };\nobj._extensions['.js'] = function(m, f){ return m; };\nmodule.exports = {};\n",
    ],
    [
      "3 user.register(...) -- user is not module-builtin-bound",
      "const user = { register(x){ return x; } };\nfunction main(){ user.register(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "4 obj.constructor.createRequire(...) -- obj is not an ambient module instance",
      "const obj = {};\nfunction main(){ obj.constructor.createRequire('x')(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "5 obj.main.constructor._load(...) -- obj is not the ambient `require`",
      "const obj = { main: {} };\nfunction main(){ obj.main.constructor._load(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "6 new vm.SourceTextModule(code) alone, never evaluated -- construction is not itself execution",
      "const vm = require('vm');\nfunction main(){ return new vm.SourceTextModule(process.env.P); }\nmodule.exports = { main };\n",
    ],
    [
      "7 new SourceTextModule(code).evaluate() -- SourceTextModule is not Node's vm.SourceTextModule",
      "class SourceTextModule { evaluate(){} }\nfunction main(){ new SourceTextModule(process.env.P).evaluate(); }\nmodule.exports = { main };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-fix-7 precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("(Part 8 decision) mod.link(...) alone, without .evaluate(), is NOT independently classified as widening", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const vm = require('vm');\nconst mod = new vm.SourceTextModule(process.env.P);\nfunction main(){ mod.link(function(){}); }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(true);
    expect(closure.incompleteness).toEqual([]);
  });

  it("(transitive dependency) a module._compile(...) call in a loaded dependency's own module scope still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/foo/index.js",
      "module._compile('module.exports = {};', __filename);\nmodule.exports = {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('foo');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("vm_execution");
  });
});

/**
 * VT-307c-fix-8. The final VT-307d readiness review found that a re-export
 * declaration with a source specifier (`export * from "pkg"`, `export { x }
 * from "pkg"`, ...) is a static, unconditional module load exactly like
 * `import "pkg"` -- Node really does load and execute `pkg`'s top-level
 * code, whether or not any re-exported name is ever itself imported
 * downstream -- but ModuleLoadClosure only ever traversed `model.imports`,
 * so a genuinely-loaded re-exported package instance could be entirely
 * OUT of `loadedPackageInstances` while `complete` stayed `true`. The same
 * review found TypeScript's `import x = require("pkg")` indexed nowhere at
 * all. Both are now first-class static loads, dispatched through the exact
 * same resolver/incompleteness handling as an ordinary import.
 */
describe("ModuleLoadClosure: re-export and TS import-equals static loads (VT-307c-fix-8)", () => {
  it.each([
    ["(A) export * from package", 'export * from "pkg";\n'],
    ["(B) export { thing } from package", 'export { thing } from "pkg";\n'],
    [
      "(C) export { thing as renamed } from package",
      'export { thing as renamed } from "pkg";\n',
    ],
    ["(D) export * as ns from package", 'export * as ns from "pkg";\n'],
    ["(E) export { default } from package", 'export { default } from "pkg";\n'],
  ])("%s puts the package IN the closure", async (_label, source) => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "node_modules/pkg/package.json",
      JSON.stringify({ name: "pkg", version: "1.0.0", type: "module" }),
    );
    const pkgEntry = write(
      root,
      "node_modules/pkg/index.js",
      "export function thing(){ return 1; }\nexport default thing;\n",
    );
    const entry = write(root, "src/index.mjs", source);

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, pkgEntry)).toBe(true);
    expect(
      closureContainsPackageInstance(
        closure,
        path.join(root, "node_modules/pkg"),
      ),
    ).toBe(true);
    expect(closure.complete).toBe(true);
  });

  it("(F) a relative re-export makes the closure visit the re-exported FILE", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    const hidden = write(root, "src/hidden.mjs", "export const x = 1;\n");
    const entry = write(
      root,
      "src/index.mjs",
      'export * from "./hidden.mjs";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, hidden)).toBe(true);
    expect(closure.complete).toBe(true);
  });

  it("(G) a widening construct in a file reached ONLY through a re-export still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "src/hidden.mjs",
      "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const x = req(process.env.ANYTHING);\n",
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export * from "./hidden.mjs";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("create_require");
  });

  it('(H) TypeScript `import lib = require("pkg")` puts the package IN the closure', async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/pkg/package.json",
      JSON.stringify({ name: "pkg", version: "1.0.0" }),
    );
    const pkgEntry = write(
      root,
      "node_modules/pkg/index.js",
      "module.exports.thing = function(){ return 1; };\n",
    );
    const entry = write(
      root,
      "src/index.ts",
      'import lib = require("pkg");\nexport function main(){ return lib.thing(); }\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, pkgEntry)).toBe(true);
    expect(
      closureContainsPackageInstance(
        closure,
        path.join(root, "node_modules/pkg"),
      ),
    ).toBe(true);
    expect(closure.complete).toBe(true);
  });

  it('(I) TypeScript `import lib = require("unresolved-pkg")` makes the closure incomplete', async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      'import lib = require("unresolved-pkg");\nexport function main(){ return lib.thing(); }\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("unresolved_module");
  });

  it("(J) TypeScript `import q = A.B;` (non-external, no ExternalModuleReference) is NOT a module load", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.ts",
      "namespace A { export const B = { x: 1 }; }\nimport q = A.B;\nexport function main(){ return q.x; }\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.loadedFiles).toEqual([entry]);
    expect(closure.complete).toBe(true);
  });

  it("(K) a re-export of a Node builtin is handled without local traversal, and the closure stays complete", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export { readFileSync } from "node:fs";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.loadedFiles).toEqual([entry]);
    expect(closure.complete).toBe(true);
  });

  it("(L) a re-export that resolves only to a TypeScript declaration file makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "node_modules/types-only/package.json",
      JSON.stringify({
        name: "types-only",
        version: "1.0.0",
        types: "index.d.ts",
      }),
    );
    write(
      root,
      "node_modules/types-only/index.d.ts",
      "export declare function f(): void;\n",
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export { f } from "types-only";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("declaration_only_resolution");
  });

  it("an unresolved re-export specifier makes the closure incomplete (Part 8's dispatch-D sibling)", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export { f } from "totally-does-not-exist";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("unresolved_module");
  });

  it("(Part 9) a workspace-linked package reached ONLY through a re-export still resolves to its correct canonical PackageInstance", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({
        name: "app",
        type: "module",
        workspaces: ["packages/*"],
      }),
    );
    const libRoot = write(
      root,
      "packages/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", type: "module" }),
    );
    write(
      root,
      "packages/vuln-lib/index.js",
      "export function dangerousOp(){ return 1; }\n",
    );
    mkdirSync(path.join(root, "node_modules"), { recursive: true });
    symlinkSync(
      path.join(root, "packages/vuln-lib"),
      path.join(root, "node_modules/vuln-lib"),
      "dir",
    );
    const entry = write(root, "src/index.mjs", 'export * from "vuln-lib";\n');
    const knownPackageRoots = buildKnownPackageRoots(
      [dependencyNode("vuln-lib", path.dirname(libRoot))],
      root,
    );

    const closure = await closureFor(root, [entry], { knownPackageRoots });

    expect(
      closureContainsPackageInstance(
        closure,
        canonicalizePackageInstancePath(path.dirname(libRoot)),
      ),
    ).toBe(true);
  });

  it("(Part 10) a top-level re-export loads even when the configured {file, symbol} entrypoint symbol doesn't reference it", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0", type: "module" }),
    );
    write(
      root,
      "node_modules/vuln-lib/index.js",
      "export function dangerousOp(){ return 1; }\n",
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export * from "vuln-lib";\nexport function unrelated(){ return 42; }\n',
    );

    const closure = await closureFor(root, [entry], { symbol: "unrelated" });

    expect(
      closureContainsPackageInstance(
        closure,
        path.join(root, "node_modules/vuln-lib"),
      ),
    ).toBe(true);
  });

  it("does not resolve the same specifier twice when a file both imports and re-exports it", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "node_modules/pkg/package.json",
      JSON.stringify({ name: "pkg", version: "1.0.0", type: "module" }),
    );
    const pkgEntry = write(
      root,
      "node_modules/pkg/index.js",
      "export function thing(){ return 1; }\n",
    );
    const entry = write(
      root,
      "src/index.mjs",
      'import { thing } from "pkg";\nexport { thing } from "pkg";\nexport function main(){ return thing(); }\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, pkgEntry)).toBe(true);
    expect(closure.loadedFiles.filter((f) => f === pkgEntry)).toHaveLength(1);
    expect(closure.complete).toBe(true);
  });
});

/**
 * VT-307c-fix-9. The final VT-307d safety audit reproduced four families of
 * in-source Node module-loader/resolution MUTATION end-to-end, each one
 * leaving a genuinely-executed vulnerable package instance OUT of
 * loadedPackageInstances while complete stayed true: reassigning
 * Module._resolveFilename/Module._load (redirects require()'s own
 * resolution for every subsequent load), reassigning
 * Module.prototype.require (changes what loading any subsequently
 * constructed module instance does), and mutating module.paths/
 * require.main.paths (shadows an already-resolvable specifier with an
 * attacker-chosen directory). A follow-up nearby-mutation audit (Part 16)
 * found the same hazard for Module.wrap (the source-wrapping function
 * every _compile call passes through) and require.cache/Module._cache
 * (pre-populating an entry redirects the NEXT require() of that resolved
 * file to a planted module object without ever loading the real one). All
 * reuse the existing loader_hook_mutation reason -- no new DynamicCallReason
 * value was needed.
 */
describe("ModuleLoadClosure: Node module-loader/resolution mutation (VT-307c-fix-9)", () => {
  it.each([
    [
      "(A) Module._resolveFilename = fn",
      "const Module = require('module');\nModule._resolveFilename = function(r,p){ return r; };\nmodule.exports = {};\n",
    ],
    [
      "(A2) require('module')._resolveFilename = fn (inline whole-module form)",
      "require('module')._resolveFilename = function(r,p){ return r; };\nmodule.exports = {};\n",
    ],
    [
      "(A3) module.constructor._resolveFilename = fn (ambient .constructor form)",
      "module.constructor._resolveFilename = function(r,p){ return r; };\nmodule.exports = {};\n",
    ],
    [
      "(C) Module._load = fn (assignment, distinct from the already-covered call form)",
      "const Module = require('module');\nModule._load = function(r,p,m){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "(3-Part3) Module._findPath = fn",
      "const Module = require('module');\nModule._findPath = function(r,p){ return r; };\nmodule.exports = {};\n",
    ],
    [
      "(3-Part3) Module._resolveLookupPaths = fn",
      "const Module = require('module');\nModule._resolveLookupPaths = function(r,p){ return []; };\nmodule.exports = {};\n",
    ],
    [
      "(B) Module.prototype.require = fn",
      "const Module = require('module');\nModule.prototype.require = function(r){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "(Part4) Module.prototype.load = fn",
      "const Module = require('module');\nModule.prototype.load = function(f){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "(Part4) Module.prototype._compile = fn",
      "const Module = require('module');\nModule.prototype._compile = function(c,f){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "(Part4) require.main.constructor.prototype.require = fn",
      "require.main.constructor.prototype.require = function(r){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "(Part5) Module._extensions = newRegistry (whole-object replacement)",
      "const Module = require('module');\nModule._extensions = {};\nmodule.exports = {};\n",
    ],
    [
      "(D) module.paths = [...] (whole-array replacement)",
      "module.paths = [process.env.X];\nmodule.exports = {};\n",
    ],
    [
      "(E) require.main.paths = [...] (whole-array replacement)",
      "require.main.paths = [process.env.X];\nmodule.exports = {};\n",
    ],
    [
      "(D-call) module.paths.unshift(dir)",
      "module.paths.unshift(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "(E-call) require.main.paths.push(dir)",
      "require.main.paths.push(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "(Part7) module.paths.splice(0, 0, dir)",
      "module.paths.splice(0, 0, process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "(Part7) module.paths.pop()",
      "module.paths.pop();\nmodule.exports = {};\n",
    ],
    [
      "(Part7) module.paths.shift()",
      "module.paths.shift();\nmodule.exports = {};\n",
    ],
    [
      "(Part7) module.paths.sort()",
      "module.paths.sort();\nmodule.exports = {};\n",
    ],
    [
      "(Part7) module.paths.reverse()",
      "module.paths.reverse();\nmodule.exports = {};\n",
    ],
    [
      "(Part7) module.paths.copyWithin(0, 1)",
      "module.paths.copyWithin(0, 1);\nmodule.exports = {};\n",
    ],
    [
      "(Part7) module.paths.fill(process.env.X)",
      "module.paths.fill(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "(Part16) Module.wrap = fn",
      "const Module = require('module');\nModule.wrap = function(s){ return s; };\nmodule.exports = {};\n",
    ],
    [
      "(Part16) module.constructor.wrap = fn (ambient .constructor form)",
      "module.constructor.wrap = function(s){ return s; };\nmodule.exports = {};\n",
    ],
    [
      "(Part16) require.cache[x] = fakeModule (element mutation)",
      "require.cache[require.resolve('./index.js')] = { exports: {} };\nmodule.exports = {};\n",
    ],
    [
      "(Part16) require.cache = {} (whole-object replacement)",
      "require.cache = {};\nmodule.exports = {};\n",
    ],
    [
      "(Part16) Module._cache[x] = fakeModule (element mutation)",
      "const Module = require('module');\nModule._cache[require.resolve('./index.js')] = { exports: {} };\nmodule.exports = {};\n",
    ],
    [
      "(Part16) Module._cache = {} (whole-object replacement)",
      "const Module = require('module');\nModule._cache = {};\nmodule.exports = {};\n",
    ],
  ])("%s makes the closure incomplete", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it.each([
    [
      "1 UserModule._resolveFilename = fn -- no Node Module provenance",
      "class UserModule {}\nUserModule._resolveFilename = function(r){ return r; };\nmodule.exports = {};\n",
    ],
    [
      "2 UserModule._load = fn -- no Node Module provenance",
      "class UserModule {}\nUserModule._load = function(){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "3 UserModule.prototype.require = fn -- no Node Module provenance",
      "class UserModule {}\nUserModule.prototype.require = function(){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "4 obj.paths.unshift(x) -- obj is not the ambient module/require.main",
      "const obj = { paths: [] };\nobj.paths.unshift(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "5 obj.main.paths.unshift(x) -- obj is not the ambient require",
      "const obj = { main: { paths: [] } };\nobj.main.paths.unshift(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "6 user.Module._extensions = ... -- user is not module-builtin-bound",
      "const user = { Module: {} };\nuser.Module._extensions = {};\nmodule.exports = {};\n",
    ],
    [
      "7 obj.paths = [...] -- obj is not the ambient module/require.main",
      "const obj = { paths: [] };\nobj.paths = [process.env.X];\nmodule.exports = {};\n",
    ],
    [
      "8 UserModule.wrap = fn -- no Node Module provenance",
      "class UserModule {}\nUserModule.wrap = function(s){ return s; };\nmodule.exports = {};\n",
    ],
    [
      "9 user.cache[x] = ... -- user is not the ambient require",
      "const user = { cache: {} };\nuser.cache['x'] = {};\nmodule.exports = {};\n",
    ],
    [
      "10 obj._cache[x] = ... -- obj is not Node's Module constructor",
      "const obj = { _cache: {} };\nobj._cache['x'] = {};\nmodule.exports = {};\n",
    ],
    [
      "11 read-only module.paths.slice()/includes() -- non-mutating array methods must never flag",
      "const copy = module.paths.slice();\nconst has = module.paths.includes('x');\nmodule.exports = { copy, has };\n",
    ],
    [
      "12 read-only require.cache['literal'] access -- reading an entry is not mutation",
      "const m = require.cache['/some/resolved/path.js'];\nvoid m;\n",
    ],
  ])(
    "stays complete for %s (VT-307c-fix-9 precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("(Part 13) a Module._resolveFilename mutation in a file reached ONLY through a re-export still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "src/hidden.js",
      "const Module = require('module');\nModule._resolveFilename = function(r){ return r; };\nmodule.exports.x = 1;\n",
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export * from "./hidden.js";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, path.join(root, "src/hidden.js"))).toBe(
      true,
    );
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it("(transitive dependency) a module.paths.unshift(...) call in a loaded dependency's own module scope still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/foo/index.js",
      "module.paths.unshift(process.env.X);\nmodule.exports = {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('foo');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });
});

/**
 * VT-307c-fix-10. The final VT-307d go/no-go audit reproduced two remaining
 * ambient-Module gaps: process.mainModule (a third literal ambient reference
 * to a real Node Module instance, alongside module and require.main) was not
 * recognized by the shared isAmbientModuleInstance provenance helper, so
 * mutating process.mainModule.constructor.* or process.mainModule.paths went
 * undetected even though the equivalent module.constructor.* / module.paths
 * and require.main.constructor.* / require.main.paths forms were already
 * covered by fix-9. Separately, Module.wrapper (the two-element
 * source-wrapping array every _compile call consults, distinct from the
 * already-covered Module.wrap function) was not recognized as one of the
 * module system's own mutable registry objects. Both gaps are closed by
 * generalizing existing shared helpers -- isAmbientModuleInstance gained a
 * process.mainModule branch, and isLoaderHookRegistryObject gained a
 * Module.wrapper branch via the new isModuleWrapperObject predicate -- so no
 * new mutation-detection logic was needed beyond the two provenance
 * generalizations. Both reuse the existing loader_hook_mutation reason.
 */
describe("ModuleLoadClosure: process.mainModule and Module.wrapper mutation (VT-307c-fix-10)", () => {
  it.each([
    [
      "process.mainModule.constructor._resolveFilename = fn",
      "process.mainModule.constructor._resolveFilename = function(r){ return r; };\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.constructor._load = fn",
      "process.mainModule.constructor._load = function(r){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.constructor._findPath = fn",
      "process.mainModule.constructor._findPath = function(r){ return r; };\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.constructor._resolveLookupPaths = fn",
      "process.mainModule.constructor._resolveLookupPaths = function(r){ return []; };\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.constructor.prototype.require = fn",
      "process.mainModule.constructor.prototype.require = function(r){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.paths = [...] (whole-array replacement)",
      "process.mainModule.paths = [process.env.X];\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.paths.push(dir)",
      "process.mainModule.paths.push(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.paths.unshift(dir)",
      "process.mainModule.paths.unshift(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.paths.sort()",
      "process.mainModule.paths.sort();\nmodule.exports = {};\n",
    ],
    [
      "Module.wrapper[0] = injected (element mutation)",
      "const Module = require('module');\nModule.wrapper[0] = Module.wrapper[0] + process.env.X;\nmodule.exports = {};\n",
    ],
    [
      "Module.wrapper = [...] (whole-array replacement)",
      "const Module = require('module');\nModule.wrapper = [process.env.X, process.env.Y];\nmodule.exports = {};\n",
    ],
    [
      "require('module').wrapper[0] = ... (inline whole-module form)",
      "require('module').wrapper[0] = process.env.X;\nmodule.exports = {};\n",
    ],
    [
      "module.constructor.wrapper = [...] (ambient .constructor form)",
      "module.constructor.wrapper = [process.env.X, process.env.Y];\nmodule.exports = {};\n",
    ],
    [
      "require.main.constructor.wrapper[1] = ...",
      "require.main.constructor.wrapper[1] = process.env.X;\nmodule.exports = {};\n",
    ],
  ])("%s makes the closure incomplete", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it.each([
    [
      "obj.mainModule.paths.unshift(x) -- obj is not the ambient process",
      "const obj = { mainModule: { paths: [] } };\nobj.mainModule.paths.unshift(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "obj.mainModule.constructor._load = fn -- obj is not the ambient process",
      "const obj = { mainModule: {} };\nobj.mainModule.constructor = { _load(){} };\nobj.mainModule.constructor._load = function(){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "processLike.mainModule.paths.unshift(x) -- processLike is not the ambient process",
      "const processLike = { mainModule: { paths: [] } };\nprocessLike.mainModule.paths.unshift(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "user.Module.wrapper[0] = ... -- user is not module-builtin-bound",
      "const user = { Module: { wrapper: [] } };\nuser.Module.wrapper[0] = process.env.X;\nmodule.exports = {};\n",
    ],
    [
      "obj.wrapper[0] = ... -- obj is not Node's Module constructor",
      "const obj = { wrapper: [] };\nobj.wrapper[0] = process.env.X;\nmodule.exports = {};\n",
    ],
    [
      "obj.wrapper = [...] -- obj is not Node's Module constructor",
      "const obj = { wrapper: [] };\nobj.wrapper = [process.env.X, process.env.Y];\nmodule.exports = {};\n",
    ],
    [
      "obj.mainModule.constructor._resolveFilename -- fabricated provenance, no ambient process reference at all",
      "const obj = {};\nobj.mainModule = {};\nobj.mainModule.constructor = { _resolveFilename(){} };\nobj.mainModule.constructor._resolveFilename = function(r){ return r; };\nmodule.exports = {};\n",
    ],
  ])(
    "stays complete for %s (VT-307c-fix-10 precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("a process.mainModule.paths.unshift(...) call in a never-called function still makes the closure incomplete", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "function neverCalled(){ process.mainModule.paths.unshift(process.env.X); }\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it("a Module.wrapper[0] mutation in a file reached ONLY through a re-export still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "src/hidden.js",
      "const Module = require('module');\nModule.wrapper[0] = Module.wrapper[0] + process.env.X;\nmodule.exports.x = 1;\n",
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export * from "./hidden.js";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, path.join(root, "src/hidden.js"))).toBe(
      true,
    );
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it("a process.mainModule.constructor._load mutation in a loaded dependency's own module scope still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/foo/index.js",
      "process.mainModule.constructor._load = function(r){ return {}; };\nmodule.exports = {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('foo');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });
});

/**
 * VT-307c-fix-10 (Part 9/14). buildGateEligibleModuleLoadClosure is
 * preparation for VT-307d's future gate-eligibility rule: a closure built
 * from zero entrypoints has rootFiles.length === 0 by construction, so
 * "this package instance was never observed in the closure" carries no
 * evidentiary weight -- there was no traversal for it to have been observed
 * in. This function must never hand back such a closure to a caller that
 * would treat it as positive absence proof. It has no verdict-facing caller
 * yet; this test only exercises the function itself.
 */
describe("buildGateEligibleModuleLoadClosure: zero-entrypoint eligibility (VT-307c-fix-10)", () => {
  it("returns undefined when entrypoints is empty, even though the project has a genuinely vulnerable dependency present", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/vuln-lib/package.json",
      JSON.stringify({ name: "vuln-lib", version: "1.0.0" }),
    );
    write(root, "node_modules/vuln-lib/index.js", "module.exports = {};\n");
    write(root, "package.json", JSON.stringify({ name: "app" }));

    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    const knownPackageRoots = buildKnownPackageRoots(
      [dependencyNode("vuln-lib", path.join(root, "node_modules/vuln-lib"))],
      root,
    );

    const closure = await buildGateEligibleModuleLoadClosure({
      entrypoints: [],
      resolver,
      knownPackageRoots,
    });

    expect(closure).toBeUndefined();
  });

  it("returns the closure unchanged when entrypoints is non-empty and rootFiles ends up non-empty", async () => {
    const root = tempProject();
    write(root, "package.json", JSON.stringify({ name: "app" }));
    const entry = write(
      root,
      "src/index.js",
      "function main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const project = loadTsProject(root);
    const resolver = createModuleResolver(project);
    const knownPackageRoots = buildKnownPackageRoots([], root);

    const closure = await buildGateEligibleModuleLoadClosure({
      entrypoints: [entrypoint(entry)],
      resolver,
      knownPackageRoots,
    });

    expect(closure).toBeDefined();
    expect(closure?.rootFiles).toEqual([entry]);
    expect(closure?.complete).toBe(true);
  });
});

/**
 * VT-307c-fix-11. The final VT-307d go/no-go audit reproduced four more
 * concrete in-source escapes end-to-end, each leaving a genuinely-executed
 * vulnerable package instance OUT of a gate-eligible closure's
 * loadedPackageInstances while complete stayed true: mutating
 * Module._pathCache (Node's resolved-PATH memoization cache, distinct from
 * Module._cache's module-INSTANCE cache) redirects the next resolution of
 * an otherwise ordinary, statically-resolvable specifier to a planted
 * file; Module.registerHooks(...) is register(...)'s synchronous,
 * in-realm sibling (stable since Node 22.15) -- a resolve hook can
 * short-circuit one specific specifier to a different installed package;
 * Module._preloadModules([...]) is a direct module-loading primitive,
 * distinct from every mutation-shaped construct above it; and
 * Module._readPackage reassignment can rewrite the "main" field Node
 * resolves for an otherwise perfectly ordinary require() of a real
 * installed package. All four reuse existing reasons
 * (loader_hook_mutation for the first three, module_internal_load for
 * _preloadModules, matching _load's own call-shaped reason) -- no new
 * DynamicCallReason value was needed. Module._stat was also considered
 * (the previous audit suggested it defensively) but is deliberately NOT
 * covered: reproduced directly, even an aggressive _stat override that
 * unconditionally claims every probed path exists could not redirect
 * resolution to a different real file -- _stat reports only a boolean
 * existence code for a candidate path the resolver itself already
 * constructed, never supplies or redirects to a different path.
 */
describe("ModuleLoadClosure: Module._pathCache/registerHooks/_preloadModules/_readPackage (VT-307c-fix-11)", () => {
  it.each([
    [
      "Module._pathCache[key] = plantedPath (element mutation)",
      "const Module = require('module');\nModule._pathCache[process.env.K] = process.env.V;\nmodule.exports = {};\n",
    ],
    [
      "Module._pathCache = {} (whole-object replacement)",
      "const Module = require('module');\nModule._pathCache = {};\nmodule.exports = {};\n",
    ],
    [
      "require('module')._pathCache[key] = ... (inline whole-module form)",
      "require('module')._pathCache[process.env.K] = process.env.V;\nmodule.exports = {};\n",
    ],
    [
      "module.constructor._pathCache = {} (ambient .constructor form)",
      "module.constructor._pathCache = {};\nmodule.exports = {};\n",
    ],
    [
      "require.main.constructor._pathCache[key] = ...",
      "require.main.constructor._pathCache[process.env.K] = process.env.V;\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.constructor._pathCache = {}",
      "process.mainModule.constructor._pathCache = {};\nmodule.exports = {};\n",
    ],
    [
      "Module.registerHooks({ resolve(...) {...} })",
      "const Module = require('module');\nModule.registerHooks({ resolve(s,c,n){ return n(s,c); } });\nmodule.exports = {};\n",
    ],
    [
      "require('module').registerHooks({...}) (inline whole-module form)",
      "require('module').registerHooks({ resolve(s,c,n){ return n(s,c); } });\nmodule.exports = {};\n",
    ],
    [
      "require('node:module').registerHooks({...})",
      "require('node:module').registerHooks({ resolve(s,c,n){ return n(s,c); } });\nmodule.exports = {};\n",
    ],
    [
      "const { registerHooks } = require('module'); registerHooks({...}) (CJS destructuring)",
      "const { registerHooks } = require('module');\nregisterHooks({ resolve(s,c,n){ return n(s,c); } });\nmodule.exports = {};\n",
    ],
    [
      "Module._readPackage = fn",
      "const Module = require('module');\nModule._readPackage = function(p,b){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "module.constructor._readPackage = fn (ambient .constructor form)",
      "module.constructor._readPackage = function(p,b){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "require.main.constructor._readPackage = fn",
      "require.main.constructor._readPackage = function(p,b){ return {}; };\nmodule.exports = {};\n",
    ],
    [
      "process.mainModule.constructor._readPackage = fn",
      "process.mainModule.constructor._readPackage = function(p,b){ return {}; };\nmodule.exports = {};\n",
    ],
  ])("%s makes the closure incomplete", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it.each([
    [
      "Module._preloadModules(['vuln-lib']) -- module_internal_load, not loader_hook_mutation",
      "const Module = require('module');\nModule._preloadModules(['vuln-lib']);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
    [
      "module.constructor._preloadModules(['vuln-lib']) (ambient .constructor form)",
      "module.constructor._preloadModules(['vuln-lib']);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
    [
      "require.main.constructor._preloadModules(['vuln-lib'])",
      "require.main.constructor._preloadModules(['vuln-lib']);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
    [
      "process.mainModule.constructor._preloadModules(['vuln-lib'])",
      "process.mainModule.constructor._preloadModules(['vuln-lib']);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
  ])(
    "%s produces the correct specific reason",
    async (_label, source, expectedReason) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toEqual([expectedReason]);
    },
  );

  it.each([
    [
      "1 user.Module._pathCache -- user is not module-builtin-bound",
      "const user = { Module: { _pathCache: {} } };\nuser.Module._pathCache[process.env.K] = process.env.V;\nmodule.exports = {};\n",
    ],
    [
      "2 obj._pathCache -- obj is not Node's Module constructor",
      "const obj = { _pathCache: {} };\nobj._pathCache[process.env.K] = process.env.V;\nmodule.exports = {};\n",
    ],
    [
      "3 user._pathCache (no Module at all) -- no provenance",
      "const user = {};\nuser._pathCache = {};\nuser._pathCache[process.env.K] = process.env.V;\nmodule.exports = {};\n",
    ],
    [
      "4 user.registerHooks() -- user is not the module/node:module builtin",
      "const user = { registerHooks(){} };\nuser.registerHooks({ resolve(){} });\nmodule.exports = {};\n",
    ],
    [
      "5 user.Module.registerHooks() -- user.Module is not module-builtin-bound",
      "const user = { Module: { registerHooks(){} } };\nuser.Module.registerHooks({ resolve(){} });\nmodule.exports = {};\n",
    ],
    [
      "6 user.Module._preloadModules() -- user.Module is not module-builtin-bound",
      "const user = { Module: { _preloadModules(){} } };\nuser.Module._preloadModules(['x']);\nmodule.exports = {};\n",
    ],
    [
      "7 obj.constructor._preloadModules() -- obj is not a real Module instance",
      "class Foo { static _preloadModules(){} }\nconst obj = new Foo();\nobj.constructor._preloadModules(['x']);\nmodule.exports = {};\n",
    ],
    [
      "8 user.Module._readPackage -- user.Module is not module-builtin-bound",
      "const user = { Module: { _readPackage(){} } };\nuser.Module._readPackage = function(){ return {}; };\nmodule.exports = {};\n",
    ],
  ])(
    "stays complete for %s (VT-307c-fix-11 precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("a Module._pathCache poisoning in a never-called function still makes the closure incomplete", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "function neverCalled(){ const Module = require('module'); Module._pathCache[process.env.K] = process.env.V; }\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it("a Module.registerHooks(...) call in a file reached ONLY through a re-export still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "src/hidden.js",
      "const Module = require('module');\nModule.registerHooks({ resolve(s,c,n){ return n(s,c); } });\nmodule.exports.x = 1;\n",
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export * from "./hidden.js";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, path.join(root, "src/hidden.js"))).toBe(
      true,
    );
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it("a Module._preloadModules([...]) call in a loaded dependency's own module scope still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/foo/index.js",
      "const Module = require('module');\nModule._preloadModules(['vuln-lib']);\nmodule.exports = {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('foo');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("module_internal_load");
  });

  it("a Module._readPackage reassignment at entrypoint top-level makes the closure incomplete", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nModule._readPackage = function(p,b){ return {}; };\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });
});

/**
 * VT-307c-capability-floor. The final VT-307d architecture review found
 * that fixes 5-11's named reasons, however thorough, are still an
 * enumeration: an unrecognized member on an authoritative loader
 * capability, or the capability itself escaping into a position this
 * classifier cannot re-derive provenance from, both silently preserved
 * `complete: true` -- reproduced end-to-end with NO unknown API name at
 * all (`registry.loader = Module; registry.loader._load(...)` executed a
 * genuinely-installed OUT package through members every earlier fix
 * already modeled). `loader_capability_escape` is the resulting
 * soundness-floor reason, consulted only as a LAST RESORT after every
 * precise, named classification above has already had its chance to
 * match.
 */
describe("ModuleLoadClosure: authoritative loader-capability escape fallback (VT-307c-capability-floor)", () => {
  it.each([
    // --- Part 15: unknown-member regressions ---
    [
      "Module.someFutureLoader(...) -- unknown static call",
      "const Module = require('module');\nModule.someFutureLoader(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "Module.someFutureLoader = fn -- unknown static write",
      "const Module = require('module');\nModule.someFutureLoader = function(){};\nmodule.exports = {};\n",
    ],
    [
      "Module.prototype.someFutureLoader = fn -- unknown prototype write",
      "const Module = require('module');\nModule.prototype.someFutureLoader = function(){};\nmodule.exports = {};\n",
    ],
    [
      "Module.prototype.someFutureLoader(...) -- unknown prototype call",
      "const Module = require('module');\nModule.prototype.someFutureLoader(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "module.constructor.someFutureLoader(...) -- ambient .constructor form",
      "module.constructor.someFutureLoader(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "module.someFutureThing(...) -- unknown call directly on ambient module instance",
      "module.someFutureThing(process.env.X);\nmodule.exports = {};\n",
    ],
    // --- Part 5: reflection-API / delete mutation fallback ---
    [
      "Object.assign(Module, {...}) -- reflection-API mutation of the capability itself",
      "const Module = require('module');\nObject.assign(Module, { someFutureLoader: function(){} });\nmodule.exports = {};\n",
    ],
    [
      "Object.defineProperty(Module, 'x', {...})",
      "const Module = require('module');\nObject.defineProperty(Module, 'someFutureLoader', { value: function(){} });\nmodule.exports = {};\n",
    ],
    [
      "Reflect.set(Module, 'x', fn)",
      "const Module = require('module');\nReflect.set(Module, 'someFutureLoader', function(){});\nmodule.exports = {};\n",
    ],
    [
      "delete Module.someProp",
      "const Module = require('module');\ndelete Module.someProp;\nmodule.exports = {};\n",
    ],
    // --- Part 10: property-store blocker (the exact architecture-review regression) ---
    [
      "registry.loader = Module; registry.loader._load(...) -- property-store escape",
      "const Module = require('module');\nconst registry = {};\nregistry.loader = Module;\nregistry.loader._load(process.env.X, module, false);\nmodule.exports = {};\n",
    ],
    // --- Part 11: parameter escape blocker ---
    [
      "function configure(x){ x._load(...); } configure(Module) -- argument escape",
      "const Module = require('module');\nfunction configure(x){ x._load(process.env.X, module, false); }\nconfigure(Module);\nmodule.exports = {};\n",
    ],
    // --- Part 13: require escape ---
    [
      "function run(r){ r('vuln'); } run(require) -- ambient require escapes as argument",
      "function run(r){ r(process.env.X); }\nrun(require);\nmodule.exports = {};\n",
    ],
    [
      "obj.r = require -- ambient require stored on a property",
      "const obj = {};\nobj.r = require;\nmodule.exports = { obj };\n",
    ],
    // --- Part 7C: collection escape ---
    [
      "arr.push(Module) -- capability into a collection",
      "const Module = require('module');\nconst arr = [];\narr.push(Module);\nmodule.exports = { arr };\n",
    ],
    // --- Part 7D: return escape ---
    [
      "function getLoader(){ return Module; } -- capability returned",
      "const Module = require('module');\nfunction getLoader(){ return Module; }\nmodule.exports = { getLoader };\n",
    ],
    // --- Part 7E: export escape ---
    [
      "module.exports.loader = Module -- capability escapes via CJS export",
      "const Module = require('module');\nmodule.exports.loader = Module;\n",
    ],
  ])("%s makes the closure incomplete", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("export default Module -- capability escapes via ESM default export", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    const entry = write(
      root,
      "src/index.mjs",
      "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\nconst Module = require('module');\nexport default Module;\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("export { Module } -- capability escapes via ESM named export of a local binding", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    const entry = write(
      root,
      "src/index.mjs",
      "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\nconst Module = require('module');\nexport { Module };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("cross-file export blocker (Part 12): capability escapes at the EXPORT site, independent of how the consumer uses it", async () => {
    const root = tempProject();
    write(
      root,
      "src/holder.js",
      "const Module = require('module');\nmodule.exports.loader = Module;\n",
    );
    write(
      root,
      "src/cfg.js",
      "const m = require('./holder.js');\nm.loader._load(process.env.X, module, false);\nmodule.exports = {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('./holder.js');\nrequire('./cfg.js');\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, path.join(root, "src/holder.js"))).toBe(
      true,
    );
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("createRequire-result escape remains incomplete (Part 14): escaping its returned loader cannot restore completeness", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const { createRequire } = require('module');\nfunction configure(r){ return r; }\nconfigure(createRequire(__filename));\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    // Already widening via create_require at the createRequire(...) call
    // itself; the escape fallback must not somehow "undo" or replace that.
    expect(reasonsOf(closure)).toContain("create_require");
  });

  it.each([
    // --- Part 15: precision controls -- provenance remains mandatory ---
    [
      "user.Module.someFutureLoader(...) -- user.Module is not module-builtin-bound",
      "const user = { Module: { someFutureLoader(){} } };\nuser.Module.someFutureLoader(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "obj.constructor.someFutureLoader(...) -- obj is not a real Module instance",
      "class Foo { static someFutureLoader(){} }\nconst obj = new Foo();\nobj.constructor.someFutureLoader(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "user.Module.someFutureLoader = fn -- user.Module is not module-builtin-bound",
      "const user = { Module: {} };\nuser.Module.someFutureLoader = function(){};\nmodule.exports = {};\n",
    ],
    // --- Part 16: safe-interaction controls ---
    [
      "module.exports = {...} object literal",
      "module.exports = { a: 1, b: 2 };\nvoid 0;\n",
    ],
    [
      "module.exports.foo = fn -- ordinary CJS export write",
      "module.exports.foo = function(){ return 1; };\nvoid 0;\n",
    ],
    [
      "module.exports.someArray[0] = x -- own exported array element write",
      "module.exports = { someArray: [] };\nmodule.exports.someArray[0] = process.env.X;\nvoid 0;\n",
    ],
    [
      "Object.assign(module.exports, {...}) -- own exports, not the capability",
      "Object.assign(module.exports, { a: 1 });\nvoid 0;\n",
    ],
    [
      "delete module.exports.foo -- own exports, not the capability",
      "module.exports = { foo: 1 };\ndelete module.exports.foo;\nvoid 0;\n",
    ],
    [
      "registry.push(plugin) -- ordinary local object, not a capability",
      "const registry = [];\nconst plugin = { name: 'x' };\nregistry.push(plugin);\nmodule.exports = { registry };\n",
    ],
    [
      "return { a: 1 } -- ordinary function return",
      "function make(){ return { a: 1 }; }\nmodule.exports = { make };\n",
    ],
    [
      "Module.isBuiltin('fs') -- explicit safe-call allowlist",
      "const Module = require('module');\nconst b = Module.isBuiltin('fs');\nmodule.exports = { b };\n",
    ],
    [
      "Module.builtinModules.includes('fs') -- explicit safe-call allowlist, read-only property",
      "const Module = require('module');\nconst b = Module.builtinModules.includes('fs');\nmodule.exports = { b };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-capability-floor precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("a Module._pathCache poisoning known-mutation stays classified as loader_hook_mutation, not the generic fallback (precedence, Part 17)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nModule._pathCache[process.env.K] = process.env.V;\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(["loader_hook_mutation"]);
  });

  it("Module.registerHooks(...) stays classified as loader_hook_mutation, not the generic fallback (precedence, Part 17)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nModule.registerHooks({ resolve(s,c,n){ return n(s,c); } });\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(["loader_hook_mutation"]);
  });

  it("a capability escape in a never-called function still makes the closure incomplete (whole-file semantics, Part 18)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nfunction neverCalled(){ const registry = {}; registry.loader = Module; }\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("a capability escape in a loaded dependency's own module scope still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/foo/index.js",
      "const Module = require('module');\nconst registry = {};\nregistry.loader = Module;\nmodule.exports = {};\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('foo');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("a capability escape in a file reached ONLY through a re-export still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "src/hidden.js",
      "const Module = require('module');\nconst registry = {};\nregistry.loader = Module;\nmodule.exports.x = 1;\n",
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export * from "./hidden.js";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, path.join(root, "src/hidden.js"))).toBe(
      true,
    );
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("preserves the local const-alias chain as precise, not an escape (Part 8): unbounded-depth chain still resolves to the specific reason", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nconst A = Module;\nconst B = A;\nconst C = B;\nC._load(process.env.X, module, false);\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(["module_internal_load"]);
  });
});

/**
 * VT-307c-capability-flow. The final invariant review found that
 * VT-307c-capability-floor's own escape detection was still an
 * ENUMERATION OF SYNTACTIC POSITIONS (call argument, assignment RHS,
 * return, export) rather than a genuine value-flow analysis -- so a
 * capability wrapped in an object literal, an array literal, a concise
 * arrow body, a default parameter, or a `throw` sailed through every one
 * of those checks untouched, reproduced end-to-end (real Node execution +
 * a gate-eligible, complete closure + the exact package OUT) with NO
 * unknown API name involved anywhere. This adds a generic value-container
 * walker (`containsEscapingLoaderCapabilityValue`) consulted at every
 * value-flowing anchor point, plus one receiver-provenance closure step
 * (`Module.prototype.constructor` IS `Module`, by JS's own invariant).
 */
describe("ModuleLoadClosure: value-oriented loader-capability escape analysis (VT-307c-capability-flow)", () => {
  it.each([
    // --- Part 4: object literal escape ---
    [
      "object literal property: const registry = { loader: Module }",
      "const Module = require('module');\nconst registry = { loader: Module };\nmodule.exports = { registry };\n",
    ],
    // --- Part 4: nested object literal escape ---
    [
      "nested object literal: const cfg = { deep: { loader: Module } }",
      "const Module = require('module');\nconst cfg = { deep: { loader: Module } };\nmodule.exports = { cfg };\n",
    ],
    // --- Part 5: array/container escape ---
    [
      "array literal: const arr = [Module]",
      "const Module = require('module');\nconst arr = [Module];\nmodule.exports = { arr };\n",
    ],
    [
      "new Set([Module])",
      "const Module = require('module');\nconst s = new Set([Module]);\nmodule.exports = { s };\n",
    ],
    [
      "new Map([['loader', Module]])",
      "const Module = require('module');\nconst m = new Map([['loader', Module]]);\nmodule.exports = { m };\n",
    ],
    // --- Part 6: concise-return / function-body escape ---
    [
      "concise arrow returning Module: const get = () => Module",
      "const Module = require('module');\nconst get = () => Module;\nmodule.exports = { get };\n",
    ],
    // --- Part 7: default parameter escape ---
    [
      "default parameter: function f(x = Module)",
      "const Module = require('module');\nfunction f(x = Module){ return x; }\nmodule.exports = { f };\n",
    ],
    // --- Part 8: throw escape ---
    [
      "throw Module",
      "const Module = require('module');\nfunction f(){ throw Module; }\nmodule.exports = { f };\n",
    ],
    // --- Part 9: CJS composite export escape ---
    [
      "module.exports = { loader: Module } (CJS composite export)",
      "const Module = require('module');\nmodule.exports = { loader: Module };\n",
    ],
    ["exports.x = { loader: require }", "exports.x = { loader: require };\n"],
    // --- Part 10: spread/destructuring composite value ---
    [
      "object spread: const o = { ...base, loader: Module }",
      "const Module = require('module');\nconst o = { ...{}, loader: Module };\nmodule.exports = { o };\n",
    ],
    [
      "array spread: const arr = [...[], Module]",
      "const Module = require('module');\nconst arr = [...[], Module];\nmodule.exports = { arr };\n",
    ],
    // --- Part 14: require container escapes ---
    [
      "object literal containing require: const h = { r: require }",
      "const h = { r: require };\nmodule.exports = { h };\n",
    ],
    [
      "array literal containing require: const a = [require]",
      "const a = [require];\nmodule.exports = { a };\n",
    ],
    [
      "concise arrow returning require: const get = () => require",
      "const get = () => require;\nmodule.exports = { get };\n",
    ],
    // --- Part 12/13: Module.prototype.constructor provenance + unknown member ---
    [
      "Module.prototype.constructor.someFuture(...) -- unknown member via reflexive identity",
      "const Module = require('module');\nModule.prototype.constructor.someFuture(process.env.X);\nmodule.exports = {};\n",
    ],
    [
      "module.constructor.prototype.constructor.someFuture(...) -- ambient .constructor + reflexive identity",
      "module.constructor.prototype.constructor.someFuture(process.env.X);\nmodule.exports = {};\n",
    ],
  ])("%s makes the closure incomplete", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it.each([
    [
      "Module.prototype.constructor._load(...) -- reflexive identity resolves to the SPECIFIC reason",
      "const Module = require('module');\nModule.prototype.constructor._load(process.env.X, module, false);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
    [
      "Module.prototype.constructor._preloadModules([...]) -- reflexive identity, specific reason",
      "const Module = require('module');\nModule.prototype.constructor._preloadModules(['vuln-lib']);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
    [
      "module.constructor.prototype.constructor._load(...) -- ambient .constructor + reflexive identity",
      "module.constructor.prototype.constructor._load(process.env.X, module, false);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
    [
      "require.main.constructor.prototype.constructor._load(...)",
      "require.main.constructor.prototype.constructor._load(process.env.X, module, false);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
  ])(
    "%s produces the correct specific reason, not the generic fallback",
    async (_label, source, expectedReason) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toEqual([expectedReason]);
    },
  );

  it.each([
    // --- Precision: ordinary, capability-free composite values ---
    [
      "object literal with ordinary values",
      "const o = { a: 1, b: 'x', c: [1, 2, 3] };\nmodule.exports = { o };\n",
    ],
    [
      "nested object literal with ordinary values",
      "const o = { deep: { a: 1 } };\nmodule.exports = { o };\n",
    ],
    [
      "array literal with ordinary values",
      "const arr = [1, 'x', { a: 1 }];\nmodule.exports = { arr };\n",
    ],
    [
      "concise arrow returning an ordinary value",
      "const get = () => ({ a: 1 });\nmodule.exports = { get };\n",
    ],
    [
      "default parameter with an ordinary object literal",
      "function f(x = { a: 1 }){ return x; }\nmodule.exports = { f };\n",
    ],
    [
      "throw an ordinary Error",
      "function f(){ throw new Error('x'); }\nmodule.exports = { f };\n",
    ],
    [
      "new Set([1,2,3]) / new Map([['a',1]]) with ordinary values",
      "const s = new Set([1, 2, 3]);\nconst m = new Map([['a', 1]]);\nmodule.exports = { s, m };\n",
    ],
    [
      "object spread of an ordinary object",
      "const a = { x: 1 };\nconst b = { ...a, y: 2 };\nmodule.exports = { b };\n",
    ],
    [
      "own exports array element write -- module.exports.someArray[k] = value",
      "module.exports = { someArray: [] };\nmodule.exports.someArray[process.env.K] = process.env.V;\nvoid 0;\n",
    ],
    [
      "destructuring an ordinary object",
      "const { a, b } = { a: 1, b: 2 };\nmodule.exports = { a, b };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-capability-flow precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("Module.prototype.constructor stays IDENTICAL to Module -- an unbounded-depth const alias off it remains precise", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nconst A = Module.prototype.constructor;\nconst B = A;\nB._load(process.env.X, module, false);\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(["module_internal_load"]);
  });

  it("an object-literal escape in a never-called function still makes the closure incomplete (whole-file semantics)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nfunction neverCalled(){ const registry = { loader: Module }; return registry; }\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("an object-literal escape in a loaded dependency's own module scope still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/foo/package.json",
      JSON.stringify({ name: "foo", version: "1.0.0" }),
    );
    write(
      root,
      "node_modules/foo/index.js",
      "const Module = require('module');\nconst registry = { loader: Module };\nmodule.exports = { registry };\n",
    );
    const entry = write(
      root,
      "src/index.js",
      "require('foo');\nfunction main(){ return 1; }\nmodule.exports = { main };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("a default-parameter escape in a file reached ONLY through a re-export still makes the closure incomplete", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(
      root,
      "src/hidden.js",
      "const Module = require('module');\nfunction f(x = Module){ return x; }\nmodule.exports.f = f;\n",
    );
    const entry = write(
      root,
      "src/index.mjs",
      'export * from "./hidden.js";\n',
    );

    const closure = await closureFor(root, [entry]);

    expect(closureContainsFile(closure, path.join(root, "src/hidden.js"))).toBe(
      true,
    );
    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });
});

/**
 * VT-307c-value-flow-closure. The final go/no-go invariant review found
 * that VT-307c-capability-flow's value walker, while genuinely
 * value-oriented, was itself still an ENUMERATION -- this time of
 * container NODE KINDS -- so any value-producing form missing from its
 * list failed open. Seven end-to-end violations were reproduced from
 * that single structural fact (real Node execution + a gate-eligible
 * closure + `complete: true` + the exact installed package OUT + an
 * EMPTY `incompleteness` array), and this task's own pre-implementation
 * sweep found thirteen more of the same family.
 *
 * The traversal is now CLOSED BY DEFAULT: `valueFlowOperandsOf` names the
 * value-OPAQUE forms (member access, call results, primitive-result
 * operators, function/class values) and recurses into everything else,
 * including node kinds it has never heard of. These tests therefore have
 * two jobs, and the second matters as much as the first: prove the
 * twenty reproduced blockers converge through that ONE generic
 * mechanism, and prove the exclusions still hold so ordinary code stays
 * complete.
 */
describe("ModuleLoadClosure: closed-by-default value-flow traversal (VT-307c-value-flow-closure)", () => {
  it.each([
    // --- The seven blockers the go/no-go review reproduced ---
    [
      "1. object destructuring default: const { l = Module } = {}",
      "const Module = require('module');\nconst { l = Module } = {};\nmodule.exports = { l };\n",
    ],
    [
      "2. array destructuring default: const [ l = Module ] = []",
      "const Module = require('module');\nconst [ l = Module ] = [];\nmodule.exports = { l };\n",
    ],
    [
      "3. sequence expression: const x = (0, Module)",
      "const Module = require('module');\nconst x = (0, Module);\nmodule.exports = { x };\n",
    ],
    [
      "4. class instance field: class H { loader = Module }",
      "const Module = require('module');\nclass H { loader = Module; }\nmodule.exports = { H };\n",
    ],
    [
      "5. class static field: class H { static loader = Module }",
      "const Module = require('module');\nclass H { static loader = Module; }\nmodule.exports = { H };\n",
    ],
    [
      "6. logical OR: const x = a || Module",
      "const Module = require('module');\nconst x = process.env.NOPE || Module;\nmodule.exports = { x };\n",
    ],
    [
      "7. nullish coalescing: const x = a ?? Module",
      "const Module = require('module');\nconst x = process.env.NOPE ?? Module;\nmodule.exports = { x };\n",
    ],
    // --- The thirteen more this task's own sweep reproduced ---
    [
      "8. logical AND: const x = a && Module",
      "const Module = require('module');\nconst x = 1 && Module;\nmodule.exports = { x };\n",
    ],
    [
      "9. logical assignment: x ||= Module",
      "const Module = require('module');\nlet x;\nx ||= Module;\nmodule.exports = { x };\n",
    ],
    [
      "10. await of a capability: const x = await Module",
      "const Module = require('module');\nasync function f(){ const x = await Module; return x; }\nmodule.exports = { f };\n",
    ],
    [
      "11. let binding (not a followable alias): let x = Module",
      "const Module = require('module');\nlet x = Module;\nmodule.exports = { x };\n",
    ],
    [
      "12. var binding (not a followable alias): var x = Module",
      "const Module = require('module');\nvar x = Module;\nmodule.exports = { x };\n",
    ],
    [
      "13. destructuring default holding a composite: const { l = { m: Module } } = {}",
      "const Module = require('module');\nconst { l = { m: Module } } = {};\nmodule.exports = { l };\n",
    ],
    [
      "14. nested destructuring default: const { a: { b = Module } = {} } = {}",
      "const Module = require('module');\nconst { a: { b = Module } = {} } = {};\nmodule.exports = { b };\n",
    ],
    [
      "15. parameter destructuring default: function f({ l = Module })",
      "const Module = require('module');\nfunction f({ l = Module }){ return l; }\nmodule.exports = { f };\n",
    ],
    [
      "16. array-pattern parameter default: function f([ l = Module ])",
      "const Module = require('module');\nfunction f([ l = Module ]){ return l; }\nmodule.exports = { f };\n",
    ],
    [
      "17. class field holding a composite: class H { loader = { m: Module } }",
      "const Module = require('module');\nclass H { loader = { m: Module }; }\nmodule.exports = { H };\n",
    ],
    [
      "18. computed-name class field: class H { [k] = Module }",
      "const Module = require('module');\nconst k = 'l';\nclass H { [k] = Module; }\nmodule.exports = { H };\n",
    ],
    [
      "19. static field holding an array of require: class H { static r = [require] }",
      "class H { static r = [require]; }\nmodule.exports = { H };\n",
    ],
    [
      "20. for-of over a capability-bearing iterable",
      "const Module = require('module');\nlet held;\nfor (const m of [Module]) { held = m; }\nmodule.exports = { held };\n",
    ],
    [
      "21. generator yield of a capability",
      "const Module = require('module');\nfunction* gen(){ yield Module; }\nmodule.exports = { gen };\n",
    ],
    [
      "22. generator yield of a composite containing a capability",
      "const Module = require('module');\nfunction* gen(){ yield { l: Module }; }\nmodule.exports = { gen };\n",
    ],
    [
      "23. tagged template substitution",
      "const Module = require('module');\nfunction tag(s, v){ return v; }\nconst held = tag`${Module}`;\nmodule.exports = { held };\n",
    ],
    // --- Composed forms: closure of the abstraction, not spelling count ---
    [
      "composed: a || (b ? [Module] : c)",
      "const Module = require('module');\nconst x = process.env.NOPE || (process.env.Q ? [Module] : null);\nmodule.exports = { x };\n",
    ],
    [
      "composed: class field holding new Set([Module])",
      "const Module = require('module');\nclass H { s = new Set([Module]); }\nmodule.exports = { H };\n",
    ],
    [
      "composed: destructuring default holding a concise arrow returning require",
      "const { get = () => require } = {};\nmodule.exports = { get };\n",
    ],
    [
      "composed: (a, b) sequence inside an object inside a class static field",
      "const Module = require('module');\nclass H { static box = { l: (0, Module) }; }\nmodule.exports = { H };\n",
    ],
    [
      "composed: spread of a composite reached through a logical default",
      "const Module = require('module');\nconst inner = { l: Module };\nconst box = process.env.NOPE || { ...inner };\nmodule.exports = { box };\n",
    ],
    [
      "composed: TS-style parenthesized + non-null wrapping of a logical default",
      "const Module = require('module');\nconst x = (process.env.NOPE || Module);\nmodule.exports = { x };\n",
    ],
  ])("goes incomplete for %s", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it.each([
    // Exclusion 1: member access -- `module.exports` is in every CJS file.
    [
      "module.exports read and write",
      "const x = module.exports;\nmodule.exports = { x, y: 1 };\n",
    ],
    [
      "require.main === module entrypoint guard",
      "if (require.main === module) { console.log('main'); }\nmodule.exports = {};\n",
    ],
    // Exclusion 2: call results.
    [
      "const ok = Module.isBuiltin('fs') (allowlisted read-only call)",
      "const Module = require('module');\nconst ok = Module.isBuiltin('fs');\nmodule.exports = { ok };\n",
    ],
    // Exclusion 3: primitive-result operators.
    [
      "typeof module guard",
      "const isCjs = typeof module === 'object';\nmodule.exports = { isCjs };\n",
    ],
    [
      "template literal over a capability's member",
      "const id = `${module.id}`;\nmodule.exports = { id };\n",
    ],
    [
      "comparison against a capability",
      "const Module = require('module');\nconst ok = Module === undefined;\nmodule.exports = { ok };\n",
    ],
    // The same value shapes as the blockers above, WITHOUT a capability.
    [
      "logical OR of ordinary values",
      "const x = process.env.Q || { b: 1 };\nmodule.exports = { x };\n",
    ],
    [
      "logical AND of ordinary values",
      "const x = 1 && { b: 1 };\nmodule.exports = { x };\n",
    ],
    [
      "nullish coalescing of ordinary values",
      "const x = process.env.Q ?? 'fallback';\nmodule.exports = { x };\n",
    ],
    [
      "sequence expression of ordinary values",
      "const x = (0, 42);\nmodule.exports = { x };\n",
    ],
    [
      "object destructuring default of an ordinary value",
      "const { l = 42 } = {};\nmodule.exports = { l };\n",
    ],
    [
      "array destructuring default of an ordinary value",
      "const [ l = 42 ] = [];\nmodule.exports = { l };\n",
    ],
    [
      "class instance and static fields of ordinary values",
      "class H { l = 42; static m = 'x'; }\nmodule.exports = { H };\n",
    ],
    [
      "logical assignment of an ordinary value",
      "let x;\nx ||= 42;\nmodule.exports = { x };\n",
    ],
    [
      "for-of over an ordinary iterable",
      "let held;\nfor (const m of [1, 2, 3]) { held = m; }\nmodule.exports = { held };\n",
    ],
    [
      "generator yielding an ordinary value",
      "function* gen(){ yield 42; }\nmodule.exports = { gen };\n",
    ],
    [
      "tagged template over ordinary values",
      "function tag(s, v){ return v; }\nconst held = tag`${42}`;\nmodule.exports = { held };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-value-flow-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("keeps the followable const-alias exemption -- const A = Module; const B = A; stays precise", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nconst A = Module;\nconst B = A;\nconst C = B;\nC._load(process.env.X, module, false);\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(["module_internal_load"]);
  });

  it.each([
    [
      "Module._preloadModules(['x'])",
      "const Module = require('module');\nModule._preloadModules(['x']);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
    [
      "Module._load(x, module, false)",
      "const Module = require('module');\nModule._load(process.env.X, module, false);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
    [
      "Module.registerHooks(hooks)",
      "const Module = require('module');\nModule.registerHooks({ resolve(s, c, n){ return n(s, c); } });\nmodule.exports = {};\n",
      "loader_hook_mutation",
    ],
    [
      "Module.prototype.constructor._preloadModules(['x'])",
      "const Module = require('module');\nModule.prototype.constructor._preloadModules(['x']);\nmodule.exports = {};\n",
      "module_internal_load",
    ],
    [
      "Module._resolveFilename ||= hook (logical-assignment mutation)",
      "const Module = require('module');\nModule._resolveFilename ||= function(){ return 'x'; };\nmodule.exports = {};\n",
      "loader_hook_mutation",
    ],
  ])(
    "does not degrade %s into the generic fallback (precise reason still wins)",
    async (_label, source, expectedReason) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toEqual([expectedReason]);
    },
  );

  it("finds a value-flow escape in a never-called function of a transitively loaded dependency", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/dep/package.json",
      JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/dep/index.js",
      "const Module = require('module');\nfunction neverCalled({ loader = Module } = {}){ return loader; }\nmodule.exports = { neverCalled };\n",
    );
    const entry = write(root, "src/index.js", "require('dep');\n");

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });
});

/**
 * VT-307c-provenance-closure. The final invariant certification found
 * that the value-flow layer VT-307c-value-flow-closure had already made
 * fail-closed by construction was undermined by a SEPARATE, one-layer-up
 * defect: the ALIAS-EXEMPTION relation (which decides "does this
 * `const <id> = <capability-expr>` declaration escape at all") was
 * BROADER than what every USE-SITE resolver could actually resolve `<id>`
 * back to later -- so a capability could be exempted at its declaration
 * and then never recognized again where it was actually used, vanishing
 * in both directions at once. Twelve end-to-end reproductions
 * (real Node execution + a gate-eligible, complete closure + the exact
 * installed package OUT + an EMPTY incompleteness array) came out of that
 * one property, across four families:
 *
 * - Family A: ESM named/namespace bindings of the self-referential
 *   `Module` export (`import { Module } from 'module'`, ...);
 * - Family B: `<X>.Module` self-reference resolved non-recursively while
 *   its own `.constructor` sibling resolved recursively;
 * - Family C: `Module.prototype` held in a `const` -- neither a
 *   recognized capability VALUE nor a resolvable RECEIVER before this
 *   task, so it fell between both layers;
 * - Family D: `require`-alias chains beyond one hop, and Module-
 *   constructor MEMBER values (`createRequire`, `_preloadModules`)
 *   stored in a `const` and used elsewhere.
 *
 * The fix (`resolveLoaderCapability` in loader-constructs.ts) is a SINGLE
 * relation every receiver/value/callee check in that file now consults,
 * so the exemption is the exact inverse of resolution BY CONSTRUCTION.
 * These tests prove all twelve close through that one mechanism, prove
 * the controls that already worked keep working, and prove the analyzer
 * no longer crashes on a cyclic alias (a separate, pre-existing latent
 * bug this task's own widened recursion made far more reachable).
 */
describe("ModuleLoadClosure: shared loader-capability provenance relation (VT-307c-provenance-closure)", () => {
  it.each([
    // --- Family A: ESM named/namespace bindings of `Module` ---
    [
      "A1. ESM named import: import { Module } from 'module'",
      "import { Module } from 'module';\nModule._preloadModules(['vuln']);\n",
      "src/index.mjs",
      true,
    ],
    [
      "A2. ESM named+aliased import: import { Module as M } from 'node:module'",
      "import { Module as M } from 'node:module';\nM._preloadModules(['vuln']);\n",
      "src/index.mjs",
      true,
    ],
    [
      "A3. ESM namespace .default: import * as M from 'module'; M.default",
      "import * as M from 'module';\nM.default._preloadModules(['vuln']);\n",
      "src/index.mjs",
      true,
    ],
    [
      "A4. CJS destructure: const { Module } = require('module')",
      "const { Module } = require('module');\nModule._preloadModules(['vuln']);\n",
      "src/index.js",
      false,
    ],
    [
      "A5. CJS destructure aliased: const { Module: M } = require('module')",
      "const { Module: M } = require('module');\nM._preloadModules(['vuln']);\n",
      "src/index.js",
      false,
    ],
    // --- Family B: recursive `.Module` self-reference ---
    [
      "B1. Module.Module.Module",
      "const Module = require('module');\nModule.Module.Module._preloadModules(['vuln']);\n",
      "src/index.js",
      false,
    ],
    [
      "B2. require('module').Module.prototype.constructor.Module",
      "require('module').Module.prototype.constructor.Module._preloadModules(['vuln']);\n",
      "src/index.js",
      false,
    ],
    // --- Family C: Module.prototype held in a const ---
    [
      "C1. const proto = Module.prototype; proto.constructor._preloadModules(...)",
      "const Module = require('module');\nconst proto = Module.prototype;\nproto.constructor._preloadModules(['vuln']);\n",
      "src/index.js",
      false,
    ],
    // C2 (the prototype-member WRITE form) is covered separately below,
    // since it needs a `require('safe')` sink rather than `_preloadModules`.
    // --- Family D: alias depth and stored member values ---
    [
      "D1. require alias depth 2: const r1 = require; const r2 = r1; r2('vuln')",
      "const r1 = require;\nconst r2 = r1;\nr2('vuln');\n",
      "src/index.js",
      false,
    ],
    [
      "D2. require alias depth 3",
      "const r1 = require;\nconst r2 = r1;\nconst r3 = r2;\nr3('vuln');\n",
      "src/index.js",
      false,
    ],
    [
      "D3. stored createRequire value: const cr = require('module').createRequire",
      "const cr = require('module').createRequire;\nconst r = cr(__filename);\nr('vuln');\n",
      "src/index.js",
      false,
    ],
    [
      "D4. stored createRequire value via Module: const cr = Module.createRequire",
      "const Module = require('module');\nconst cr = Module.createRequire;\nconst r = cr(__filename);\nr('vuln');\n",
      "src/index.js",
      false,
    ],
    [
      "D5. stored _preloadModules value: const pre = Module._preloadModules",
      "const Module = require('module');\nconst pre = Module._preloadModules;\npre(['vuln']);\n",
      "src/index.js",
      false,
    ],
  ])("goes incomplete for %s", async (_label, source, entryRel, esm) => {
    const root = tempProject();
    if (esm) {
      write(
        root,
        "package.json",
        JSON.stringify({ name: "app", type: "module" }),
      );
    }
    write(
      root,
      "node_modules/vuln/package.json",
      JSON.stringify({ name: "vuln", version: "1.0.0", main: "index.js" }),
    );
    write(root, "node_modules/vuln/index.js", "module.exports = {};\n");
    const entry = write(root, entryRel, source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure).length).toBeGreaterThan(0);
  });

  it("C2. Module.prototype held in a const, then a prototype-member WRITE redirects require()", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/safe/package.json",
      JSON.stringify({ name: "safe", version: "1.0.0", main: "index.js" }),
    );
    write(root, "node_modules/safe/index.js", "module.exports = {};\n");
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nconst proto = Module.prototype;\nconst orig = proto.require;\nproto.require = function(id){ return orig.call(this, id === 'safe' ? 'vuln' : id); };\nrequire('safe');\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it("keeps the followable const-alias exemption at unbounded depth -- controls that already worked still work", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nconst A = Module;\nconst B = A;\nconst C = B;\nC._load(process.env.X, module, false);\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(["module_internal_load"]);
  });

  it("keeps a depth-5 legitimate alias chain fully resolvable (the cycle-protection budget never truncates real chains)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nconst A=Module;\nconst B=A;\nconst C=B;\nconst D=C;\nconst E=D;\nE._preloadModules(['vuln']);\nmodule.exports={};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(["module_internal_load"]);
  });

  it.each([
    [
      "Module.prototype.constructor.prototype.constructor",
      "const Module = require('module');\nModule.prototype.constructor.prototype.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "Module.registerHooks({...}) stays loader_hook_mutation",
      "const Module = require('module');\nif(Module.registerHooks){Module.registerHooks({resolve(s,c,n){return n(s,c);}});}\nmodule.exports={};\n",
      "loader_hook_mutation",
    ],
    [
      "Module.someFutureThing(x) stays the generic fallback, not a specific reason",
      "const Module = require('module');\nif(Module.someFutureThing){Module.someFutureThing(1);}\nmodule.exports={};\n",
      "loader_capability_escape",
    ],
  ])(
    "precise-reason precedence holds for %s",
    async (_label, source, expectedReason) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toEqual([expectedReason]);
    },
  );

  it("Module.prototype.require = hook (direct, no alias) stays loader_hook_mutation for the WRITE, and separately module_internal_load for the saved-original alias's own genuine require call", async () => {
    // Two DISTINCT, both-correct classifications coexist here: the
    // `Module.prototype.require = hook` WRITE is `loader_hook_mutation`
    // (unchanged from before this task); `orig` -- the alias saving the
    // ORIGINAL implementation before overwriting it -- resolves via
    // VT-307c-provenance-closure's shared relation to the SAME
    // `module_prototype_member{member:"require"}` capability a direct
    // `Module.prototype.require(...)` call would, so `orig.call(this, id)`
    // (genuinely invoking Node's real require implementation) correctly
    // also reports `module_internal_load` -- it IS that primitive, calling
    // through a saved alias rather than the property access spelling
    // doesn't change what actually executes.
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nconst orig=Module.prototype.require;\nModule.prototype.require=function(id){return orig.call(this,id);};\nmodule.exports={};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(
      expect.arrayContaining(["loader_hook_mutation", "module_internal_load"]),
    );
  });

  it.each([
    [
      "cyclic const alias: const a = b; const b = a;",
      "const a = b;\nconst b = a;\nmodule.exports = {};\n",
    ],
    [
      "3-cycle: const a = b; const b = c; const c = a;",
      "const a = b;\nconst b = c;\nconst c = a;\nmodule.exports = {};\n",
    ],
    ["self-cycle: const a = a;", "const a = a;\nmodule.exports = {};\n"],
  ])(
    "never crashes on %s (VT-307c-provenance-closure Part 7 -- previously a RangeError in resolveWholeModuleBuiltin)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      // The invariant under test is simply that this resolves at all --
      // a pre-fix run throws RangeError: Maximum call stack size
      // exceeded before ever reaching an assertion.
      const closure = await closureFor(root, [entry]);

      expect(closure).toBeDefined();
      expect(closure.complete).toBe(true);
    },
  );

  it("a cyclic alias used as a call TARGET fails closed (ambiguous resolution is treated as a capability, not silently ignored)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const a = b;\nconst b = a;\na._preloadModules(['vuln']);\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it("eval used bare as a callee is still classified as eval, unchanged", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "eval('1');\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(["eval"]);
  });

  it.each([
    [
      "const mod = module; mod.exports = {...} stays exempt (aliased ambient-instance safe write)",
      "const mod = module;\nmod.exports = { a: 1 };\n",
    ],
    [
      "ordinary property access chain unrelated to any capability",
      "const cfg = { a: { b: { c: 1 } } };\nconst x = cfg.a.b.c;\nmodule.exports = { x };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-provenance-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("aliased eval callee resolves at unbounded depth (const e1 = eval; const e2 = e1; e2(...))", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const e1 = eval;\nconst e2 = e1;\ne2('1');\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("aliased_eval");
  });

  it("finds a Family-A ESM named-import escape in a never-called function of a transitively loaded dependency (whole-file semantics)", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/dep/package.json",
      JSON.stringify({
        name: "dep",
        version: "1.0.0",
        main: "index.mjs",
        type: "module",
      }),
    );
    write(
      root,
      "node_modules/dep/index.mjs",
      "import { Module } from 'module';\nfunction neverCalled(){ Module._preloadModules(['vuln']); }\nexport { neverCalled };\n",
    );
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    const entry = write(root, "src/index.mjs", "import 'dep';\n");

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure).length).toBeGreaterThan(0);
  });

  it("finds a Family-C escape inside a class definition (whole-file semantics)", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nclass Holder {\n  static proto = Module.prototype;\n  static go(){ this.proto.constructor._preloadModules(['vuln']); }\n}\nmodule.exports = { Holder };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure).length).toBeGreaterThan(0);
  });
});

/**
 * VT-307c-builtin-closure. VT-307c-provenance-closure built ONE shared
 * provenance relation and routed the `module`-family resolvers through
 * it -- but left a SECOND relation standing beside it:
 * `referencesBuiltinExport` was never folded in, kept its own one-hop,
 * identifier-only alias logic, and served every `BUILTIN_MEMBER_REASONS`
 * entry. Because the shared relation modeled only the `module` builtin,
 * the other three modeled builtins (`vm`, `child_process`,
 * `worker_threads`) fell through BOTH relations. The certification
 * reproduced eight end-to-end violations from that, in three families --
 * every one satisfying the full bar (real Node execution + a
 * gate-eligible closure + `complete: true` + the exact installed package
 * OUT + an EMPTY `incompleteness` array):
 *
 * - Family E: a stored MEMBER value of a non-`module` builtin
 *   (`const fk = cp.fork; fk(child)`) -- the very same defect
 *   VT-307c-provenance-closure closed for `Module._preloadModules`,
 *   surviving untouched for three builtins. Controls proved the hazard
 *   was already modeled: the DIRECT and NAMED-IMPORT spellings both
 *   correctly produced `child_process_execution`.
 * - Family F: a `globalThis.`-prefixed ambient chain
 *   (`globalThis.process.mainModule.constructor`), semantically
 *   identical to the unprefixed spelling the ambient checks matched.
 * - Family G: a cross-file ESM re-export of a builtin binding
 *   (`export { Module } from "module"`) -- with BOTH files loaded and
 *   whole-file scanned, and neither flagging.
 *
 * The fix generalizes the shared relation to all four modeled builtins
 * (`builtin_namespace`/`builtin_member`/`vm_instance` kinds) and makes
 * `referencesBuiltinExport` and `isVmConstructedInstance` thin wrappers
 * over it, so there is now genuinely one relation rather than two.
 */
describe("ModuleLoadClosure: shared provenance across all modeled builtins (VT-307c-builtin-closure)", () => {
  const CHILD_REQUIRES_VULN = "require('vuln');\n";

  function projectWithChild(): { root: string; childArg: string } {
    const root = tempProject();
    write(
      root,
      "node_modules/vuln/package.json",
      JSON.stringify({ name: "vuln", version: "1.0.0", main: "index.js" }),
    );
    write(root, "node_modules/vuln/index.js", "module.exports = {};\n");
    write(root, "src/child.js", CHILD_REQUIRES_VULN);
    return { root, childArg: "require('path').join(__dirname,'child.js')" };
  }

  it.each([
    // --- Family E: stored member values of non-`module` builtins ---
    [
      "E1 const fk = cp.fork; fk(child)",
      "const cp = require('child_process');\nconst fk = cp.fork;\nfk(CHILD);\n",
      "child_process_execution",
    ],
    [
      "E2 const sp = cp.spawn; sp(...)",
      "const cp = require('child_process');\nconst sp = cp.spawn;\nsp(process.execPath, [CHILD]);\n",
      "child_process_execution",
    ],
    [
      "E3 const es = cp.execSync; es(...)",
      "const cp = require('child_process');\nconst es = cp.execSync;\nes(process.execPath + ' ' + CHILD);\n",
      "child_process_execution",
    ],
    [
      "E4 const W = wt.Worker; new W(child)",
      "const wt = require('worker_threads');\nconst W = wt.Worker;\nnew W(CHILD);\n",
      "worker_execution",
    ],
    [
      "E5 depth-2 alias of cp.fork",
      "const cp = require('child_process');\nconst a = cp.fork;\nconst b = a;\nb(CHILD);\n",
      "child_process_execution",
    ],
    [
      "E6 depth-4 alias of cp.fork",
      "const cp = require('child_process');\nconst a=cp.fork;const b=a;const c=b;const d=c;\nd(CHILD);\n",
      "child_process_execution",
    ],
    [
      "E7 namespace alias then member: const c2 = cp; const f = c2.fork",
      "const cp = require('child_process');\nconst c2 = cp;\nconst f = c2.fork;\nf(CHILD);\n",
      "child_process_execution",
    ],
    [
      "E8 node:-prefixed stored member",
      "const cp = require('node:child_process');\nconst f = cp.fork;\nf(CHILD);\n",
      "child_process_execution",
    ],
    [
      "E9 destructured then re-aliased: const { fork } = require('cp'); const f2 = fork",
      "const { fork } = require('child_process');\nconst f2 = fork;\nf2(CHILD);\n",
      "child_process_execution",
    ],
    [
      "E10 vm.Script alias, then a run method on the instance",
      "const vm = require('vm');\nconst S = vm.Script;\nconst s = new S('1');\ns.runInThisContext();\n",
      "vm_execution",
    ],
    // --- controls: the DIRECT and NAMED-IMPORT spellings always worked ---
    [
      "E-CONTROL direct cp.fork(child)",
      "const cp = require('child_process');\ncp.fork(CHILD);\n",
      "child_process_execution",
    ],
    [
      "E-CONTROL const { fork } = require('child_process'); fork(child)",
      "const { fork } = require('child_process');\nfork(CHILD);\n",
      "child_process_execution",
    ],
  ])("%s -> %s", async (_label, source, expectedReason) => {
    const { root, childArg } = projectWithChild();
    const entry = write(
      root,
      "src/index.js",
      source.replace(/CHILD/g, childArg),
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain(expectedReason);
  });

  it.each([
    [
      "F1 globalThis.process.mainModule.constructor._preloadModules(...)",
      "globalThis.process.mainModule.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "F2 globalThis.process.mainModule.require(...)",
      "globalThis.process.mainModule.require('vuln');\nmodule.exports={};\n",
      "loader_capability_escape",
    ],
    [
      "F-CONTROL unprefixed process.mainModule.constructor",
      "process.mainModule.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
  ])(
    "%s -> %s (globalThis-prefixed ambient chains)",
    async (_label, source, expectedReason) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toContain(expectedReason);
    },
  );

  it.each([
    [
      "G1 export { Module } from 'module'",
      "export { Module } from 'module';\n",
    ],
    [
      "G2 export { createRequire } from 'node:module'",
      "export { createRequire } from 'node:module';\n",
    ],
    ["G3 export * from 'module'", "export * from 'module';\n"],
    [
      "G4 export { fork } from 'child_process'",
      "export { fork } from 'child_process';\n",
    ],
  ])(
    "%s makes the RE-EXPORTING file's own closure incomplete",
    async (_label, reexportSource) => {
      const root = tempProject();
      write(
        root,
        "package.json",
        JSON.stringify({ name: "app", type: "module" }),
      );
      write(root, "src/reexport.mjs", reexportSource);
      const entry = write(
        root,
        "src/index.mjs",
        "import './reexport.mjs';\nexport const x = 1;\n",
      );

      const closure = await closureFor(root, [entry]);

      expect(
        closureContainsFile(closure, path.join(root, "src/reexport.mjs")),
      ).toBe(true);
      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toContain("loader_capability_escape");
    },
  );

  it("a builtin re-export is caught through a MULTI-LEVEL chain (the level with the real builtin provenance flags)", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    write(root, "src/b.mjs", "export { Module } from 'module';\n");
    write(root, "src/a.mjs", "export { Module } from './b.mjs';\n");
    const entry = write(
      root,
      "src/index.mjs",
      "import { Module } from './a.mjs';\nexport const x = Module;\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it.each([
    // A non-dangerous member of a modeled builtin is resolvable but is
    // NOT a capability -- see isDangerousBuiltinMember.
    [
      "const notMain = wt.isMainThread",
      "const wt = require('worker_threads');\nconst notMain = wt.isMainThread;\nmodule.exports = { notMain };\n",
    ],
    [
      "const { isMainThread } = require('worker_threads')",
      "const { isMainThread } = require('worker_threads');\nmodule.exports = { isMainThread };\n",
    ],
    [
      "const cpc = cp.ChildProcess",
      "const cp = require('child_process');\nconst cpc = cp.ChildProcess;\nmodule.exports = { cpc };\n",
    ],
    [
      "const c = vm.constants",
      "const vm = require('vm');\nconst c = vm.constants;\nmodule.exports = { c };\n",
    ],
    [
      "new vm.Script(code) constructed but never run",
      "const vm = require('vm');\nfunction main(){ return new vm.Script(process.env.C); }\nmodule.exports = { main };\n",
    ],
    [
      "a user-defined object named cp with its own fork method",
      "const cp = { fork(){ return 1; } };\ncp.fork();\nmodule.exports = {};\n",
    ],
    [
      "destructure of a NON-builtin require",
      "const { readFile } = require('fs');\nmodule.exports = { readFile };\n",
    ],
    [
      "globalThis.JSON.parse -- an ordinary global, not an ambient capability",
      "const x = globalThis.JSON.parse('1');\nmodule.exports = { x };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-builtin-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("export { readFile } from 'fs' is not a loader re-export and stays complete", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    const entry = write(
      root,
      "src/index.mjs",
      "export { readFile } from 'fs';\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(true);
    expect(closure.incompleteness).toEqual([]);
  });

  it("const { prototype } = Module still escapes -- the destructure exemption covers only a builtin require(...) initializer", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const Module = require('module');\nconst { prototype } = Module;\nprototype.require = function(){ return 1; };\nmodule.exports = {};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });
});

/**
 * VT-307c-ambient-closure. The certification pass that followed
 * VT-307c-builtin-closure found the SAME defect class one level further
 * out again: an ambient chain's OWNER (`require` in `require.main`,
 * `process` in `process.mainModule`) was still matched by literal
 * identifier name, never RESOLVED -- so an alias of the owner, or a
 * `globalThis.`/`global.` prefix in front of it, lost the capability
 * entirely. Five spellings were reproduced end-to-end (real Node
 * execution + a gate-eligible closure + `complete: true` + the exact
 * installed package OUT + an EMPTY `incompleteness` array).
 *
 * The fix makes `process` and the global object resolvable KINDS of the
 * shared relation (`ambient_process`, `ambient_global`), so every way of
 * reaching an ambient chain composes through the ordinary recursion.
 * Both kinds are deliberately RESOLUTION-ONLY -- never escaping
 * capability VALUES -- which the precision controls below pin: bare
 * `global` is ubiquitous in real published packages' global-detection
 * preambles (lodash, url-parse) and hands out no loader capability.
 */
describe("ModuleLoadClosure: ambient-chain owners resolve rather than name-match (VT-307c-ambient-closure)", () => {
  it.each([
    [
      "const p = process; p.mainModule.constructor._preloadModules(...)",
      "const p = process;\np.mainModule.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "const r = require; r.main.constructor._preloadModules(...)",
      "const r = require;\nr.main.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "const g = globalThis; g.process.mainModule.constructor",
      "const g = globalThis;\ng.process.mainModule.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "global.process.mainModule.constructor (Node's older global alias)",
      "global.process.mainModule.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "globalThis.process.mainModule.constructor",
      "globalThis.process.mainModule.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "const m = module; m.constructor._preloadModules(...)",
      "const m = module;\nm.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "const rm = require.main; rm.constructor._preloadModules(...)",
      "const rm = require.main;\nrm.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "const pm = process.mainModule; pm.constructor._preloadModules(...)",
      "const pm = process.mainModule;\npm.constructor._preloadModules(['vuln']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "aliased owner reaching an ambient .paths mutation",
      "const p = process;\np.mainModule.paths.unshift('/tmp/x');\nmodule.exports={};\n",
      "loader_hook_mutation",
    ],
  ])("%s -> %s", async (_label, source, expectedReason) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain(expectedReason);
  });

  it.each([
    // The global object and `process` are RESOLUTION-only kinds. These
    // two shapes are taken verbatim from real published packages in the
    // validation corpus (lodash.templatesettings and url-parse); both
    // regressed when the kinds were briefly treated as escaping values.
    [
      "lodash-style global detection: typeof global == 'object' && global && ...",
      "var freeGlobal = typeof global == 'object' && global && global.Object === Object && global;\nmodule.exports = { freeGlobal };\n",
    ],
    [
      "url-parse-style global detection: else if (typeof global !== 'undefined') globalVar = global",
      "let globalVar;\nif (typeof window !== 'undefined') globalVar = window;\nelse if (typeof global !== 'undefined') globalVar = global;\nmodule.exports = { globalVar };\n",
    ],
    [
      "globalThis stored in a const and re-exported",
      "const g = globalThis;\nmodule.exports = { g };\n",
    ],
    [
      "process stored in a const and re-exported",
      "const p = process;\nmodule.exports = { p, cwd: p.cwd() };\n",
    ],
    [
      "ordinary process reads",
      "const env = process.env.NODE_ENV;\nconst v = process.version;\nmodule.exports = { env, v };\n",
    ],
    [
      "globalThis.<ordinary global> is not a capability",
      "const x = globalThis.JSON.parse('1');\nconst y = globalThis.Math.max(1, 2);\nmodule.exports = { x, y };\n",
    ],
    [
      "a same-file const named global shadows the ambient one",
      "const global = { process: { mainModule: { constructor: null } } };\nmodule.exports = { global };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-ambient-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("a same-file `const require = createRequire(...)` shadows the ambient require and resolves as the createRequire result", async () => {
    const root = tempProject();
    write(
      root,
      "package.json",
      JSON.stringify({ name: "app", type: "module" }),
    );
    const entry = write(
      root,
      "src/index.mjs",
      "import { createRequire } from 'module';\nconst require = createRequire(import.meta.url);\nconst x = require('vuln');\nexport { x };\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("create_require");
  });
});

/**
 * VT-307c-registry-closure. The certification pass following
 * VT-307c-ambient-closure found the same owner-not-resolved defect at the
 * last remaining layer: the module system's own mutable REGISTRY objects
 * (`Module._extensions`/`require.extensions`, `Module._cache`/
 * `require.cache`, `Module.wrapper`, `Module._pathCache`) were each
 * matched by six near-identical syntactic helpers that required the
 * registry to appear literally as `<owner>.<name>` at the mutation site.
 * Holding a registry in a local const and mutating through THAT was
 * reproduced end-to-end (real Node execution + a gate-eligible closure +
 * `complete: true` + the exact installed package OUT + an EMPTY
 * `incompleteness` array) -- for example a `.js` compile hook installed
 * via `const ext = Module._extensions` that redirects an ordinary,
 * statically-resolvable `require('safe')` into executing a
 * never-imported package's source.
 *
 * All six helpers are now one thin wrapper over the shared relation, so
 * every aliasing path resolves for free.
 */
describe("ModuleLoadClosure: loader registries resolve through aliases (VT-307c-registry-closure)", () => {
  it.each([
    [
      "const ext = Module._extensions; ext['.js'] = hook",
      "const M = require('module');\nconst ext = M._extensions;\next['.js'] = function(){};\nmodule.exports={};\n",
    ],
    [
      "const ext = require.extensions; ext['.js'] = hook",
      "const ext = require.extensions;\next['.js'] = function(){};\nmodule.exports={};\n",
    ],
    [
      "const cache = Module._cache; cache[k] = planted",
      "const M = require('module');\nconst cache = M._cache;\ncache[process.env.K] = {};\nmodule.exports={};\n",
    ],
    [
      "const cache = require.cache; cache[k] = planted",
      "const cache = require.cache;\ncache[process.env.K] = {};\nmodule.exports={};\n",
    ],
    [
      "const wrap = Module.wrapper; wrap[0] = injected",
      "const M = require('module');\nconst wrap = M.wrapper;\nwrap[0] = 'x';\nmodule.exports={};\n",
    ],
    [
      "const pc = Module._pathCache; pc[k] = redirect",
      "const M = require('module');\nconst pc = M._pathCache;\npc[process.env.K] = '/x';\nmodule.exports={};\n",
    ],
    [
      "alias depth 2 of a registry",
      "const M = require('module');\nconst a = M._extensions;\nconst b = a;\nb['.js'] = function(){};\nmodule.exports={};\n",
    ],
    [
      "registry reached through an aliased ambient require owner",
      "const r = require;\nconst ext = r.extensions;\next['.js'] = function(){};\nmodule.exports={};\n",
    ],
    [
      "registry reached through a globalThis-prefixed owner",
      "globalThis.require = require;\nconst ext = globalThis.require.extensions;\next['.js'] = function(){};\nmodule.exports={};\n",
    ],
    [
      "whole-registry replacement through an alias",
      "const M = require('module');\nconst holder = M;\nholder._extensions = {};\nmodule.exports={};\n",
    ],
    // controls: the direct spellings that always worked
    [
      "CONTROL direct Module._extensions['.js'] = hook",
      "const M = require('module');\nM._extensions['.js'] = function(){};\nmodule.exports={};\n",
    ],
    [
      "CONTROL direct require.cache[k] = planted",
      "require.cache[process.env.K] = {};\nmodule.exports={};\n",
    ],
    [
      "CONTROL direct Module.wrapper[0] = x",
      "const M = require('module');\nM.wrapper[0] = 'x';\nmodule.exports={};\n",
    ],
  ])("%s -> loader_hook_mutation", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_hook_mutation");
  });

  it.each([
    [
      "a user-defined object with its own extensions table",
      "const registry = { extensions: {} };\nregistry.extensions['.js'] = function(){};\nmodule.exports = { registry };\n",
    ],
    [
      "a same-file object named require with an extensions property",
      "const req = { extensions: {} };\nconst ext = req.extensions;\next['.js'] = function(){};\nmodule.exports = { req };\n",
    ],
    [
      "an ordinary cache object unrelated to the module system",
      "const cache = new Map();\ncache.set('k', 1);\nmodule.exports = { cache };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-registry-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );
});

/**
 * VT-307c-function-closure. `Function` was the last capability CALLEE
 * still matched by literal identifier text in `classifyLoaderConstruct`.
 * Six spellings were reproduced end-to-end (real Node execution + a
 * gate-eligible closure + `complete: true` + the exact installed package
 * OUT + an EMPTY `incompleteness` array), each reaching the loader from
 * generated source via `process` -- a real global, and therefore visible
 * inside a `Function` body where CommonJS `require` is not.
 *
 * Two placement defects the reproductions forced out, each a distinct way
 * the same "matched by shape, not resolved" bug hides:
 *
 * - the capability dispatch lived inside `classifyLoaderConstruct`'s
 *   IDENTIFIER-only branch, so property-access spellings
 *   (`globalThis.Function(...)`) never reached it at all;
 * - `(function(){}).constructor` has a PARENTHESIZED function expression
 *   as its receiver, which is how it is always written.
 *
 * `Function` is a RESOLUTION-ONLY capability kind, excluded from the
 * value-escape sweep exactly as `eval` is and for the same measured
 * reason -- see the precision controls below.
 */
describe("ModuleLoadClosure: Function constructor resolves through the shared relation (VT-307c-function-closure)", () => {
  const GENERATED_LOADER = String.raw`"return process.mainModule.require('vuln')"`;

  it.each([
    [
      "1. const F = Function; F(src)()",
      `const F = Function;\nF(${GENERATED_LOADER})();\n`,
    ],
    [
      "2. const F = Function; new F(src)()",
      `const F = Function;\nnew F(${GENERATED_LOADER})();\n`,
    ],
    [
      "3. alias depth 2: const A = Function; const B = A; B(src)()",
      `const A = Function;\nconst B = A;\nB(${GENERATED_LOADER})();\n`,
    ],
    [
      "4. globalThis.Function(src)()",
      `globalThis.Function(${GENERATED_LOADER})();\n`,
    ],
    [
      "5. const g = globalThis; g.Function(src)()",
      `const g = globalThis;\ng.Function(${GENERATED_LOADER})();\n`,
    ],
    [
      "6. const F = (function(){}).constructor; F(src)()",
      `const F = (function(){}).constructor;\nF(${GENERATED_LOADER})();\n`,
    ],
    // Compositions with the other closed families -- the point of a
    // shared relation is that these need no logic of their own.
    [
      "7. arrow's own .constructor: (() => {}).constructor",
      `const F = (() => {}).constructor;\nF(${GENERATED_LOADER})();\n`,
    ],
    [
      "8. global.Function (Node's older global alias)",
      `global.Function(${GENERATED_LOADER})();\n`,
    ],
    [
      "9. alias depth 4 of Function",
      `const a = Function;\nconst b = a;\nconst c = b;\nconst d = c;\nd(${GENERATED_LOADER})();\n`,
    ],
  ])("%s -> function_constructor", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("function_constructor");
  });

  it.each([
    ["CONTROL direct Function(src)()", `Function(${GENERATED_LOADER})();\n`],
    [
      "CONTROL direct new Function(src)()",
      `new Function(${GENERATED_LOADER})();\n`,
    ],
  ])("%s still classifies as function_constructor", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("function_constructor");
  });

  it("aliased eval keeps its own specific reason, not the Function one", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const e1 = eval;\nconst e2 = e1;\ne2('1');\nmodule.exports={};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual(["aliased_eval"]);
  });

  it("globalThis.require(...) upgrades from the generic escape to aliased_require", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "globalThis.require = require;\nglobalThis.require(process.env.NAME);\nmodule.exports={};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("aliased_require");
  });

  it.each([
    [
      "Module._preloadModules(...) keeps module_internal_load",
      "const M = require('module');\nM._preloadModules(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "Module.registerHooks(...) keeps loader_hook_mutation",
      "const M = require('module');\nif (M.registerHooks) { M.registerHooks({ resolve(s,c,n){ return n(s,c); } }); }\nmodule.exports={};\n",
      "loader_hook_mutation",
    ],
    [
      "child_process.fork(...) keeps child_process_execution",
      "const cp = require('child_process');\nconst f = cp.fork;\nf('./w.js');\nmodule.exports={};\n",
      "child_process_execution",
    ],
    [
      "Module.someFutureThing(...) still falls back to the generic escape",
      "const M = require('module');\nif (M.someFutureThing) { M.someFutureThing(1); }\nmodule.exports={};\n",
      "loader_capability_escape",
    ],
  ])("diagnostic precedence: %s", async (_label, source, expectedReason) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toEqual([expectedReason]);
  });

  it.each([
    // `Function` is RESOLUTION-only, never an escaping VALUE. This shape
    // is verbatim `get-intrinsic`'s INTRINSICS table -- an extremely
    // widely-depended-on real package.
    [
      "a user-defined class named Function-like, constructed and called",
      "class FunctionFactory { build(){ return 1; } }\nconst f = new FunctionFactory();\nf.build();\nmodule.exports = { FunctionFactory };\n",
    ],
    [
      "a user-defined local named Function shadowing the global",
      "const Function = function (src) { return () => src; };\nFunction('x')();\nmodule.exports = {};\n",
    ],
    [
      "a lookalike object exposing .constructor, READ but never called",
      "const fake = { constructor: function(){ return 1; } };\nconst c = fake.constructor;\nvoid c;\nmodule.exports = { fake };\n",
    ],
    [
      "an ordinary object's .constructor read",
      "const o = { a: 1 };\nconst C = o.constructor;\nmodule.exports = { C };\n",
    ],
    [
      "a class's own constructor invoked normally",
      "class Widget { constructor(){ this.x = 1; } }\nconst w = new Widget();\nmodule.exports = { w };\n",
    ],
    [
      "globalThis.JSON / globalThis.Math ordinary global reads",
      "const x = globalThis.JSON.parse('1');\nconst y = globalThis.Math.max(1,2);\nmodule.exports = { x, y };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-function-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it.each([
    [
      "eval stored in an object literal",
      "const INTRINSICS = { '%eval%': eval, '%Array%': Array };\nmodule.exports = { INTRINSICS };\n",
    ],
    [
      "Function and eval stored in an object literal (get-intrinsic's INTRINSICS table)",
      "const INTRINSICS = { '%Function%': Function, '%eval%': eval, '%Array%': Array };\nmodule.exports = { INTRINSICS };\n",
    ],
    [
      "Function re-exported inside a composite",
      "const F = Function;\nmodule.exports = { F };\n",
    ],
    [
      "Function stored in an object property, then called",
      "const box = { F: Function };\nbox.F('return 1')();\nmodule.exports = {};\n",
    ],
    [
      "Function returned from a factory, then called",
      "function getF(){ return Function; }\ngetF()('return 1')();\nmodule.exports = {};\n",
    ],
  ])(
    "%s escapes -- transport the resolver cannot follow must fail closed",
    async (_label, source) => {
      // These five REVERSE an earlier round's precision controls, and the
      // reversal is the point. VT-307c-provenance-closure and the first
      // cut of VT-307c-function-closure carved `eval` and `Function` out
      // of the value-escape sweep to keep `get-intrinsic`'s INTRINSICS
      // table complete. The differential oracle then reproduced two
      // end-to-end soundness violations straight through that carve-out
      // (`const box = { F: Function }; box.F(src)()` and a factory
      // returning `Function`), because the carve-out made the EXEMPTION
      // relation wider than the RESOLUTION relation -- the exact defect
      // class this whole series exists to eliminate. A capability stored
      // into a composite, or returned, is transport the resolver cannot
      // follow, so it must fail closed like every other capability.
      //
      // The measured real-world cost is one file, `get-intrinsic/index.js`
      // in rwb-05, and it is a TRUE positive: that module's exported
      // `GetIntrinsic(name)` reads `INTRINSICS[name]` and returns it, so
      // it genuinely hands `Function` and `eval` to arbitrary callers.
      // rwb-05 was already incomplete for an unrelated reason, so no
      // fixture changed its `complete` value.
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure).length).toBeGreaterThan(0);
    },
  );

  it.each([
    ["array literal", "[].constructor.constructor('return 1')();\n"],
    ["string literal", "''.constructor.constructor('return 1')();\n"],
    ["number literal", "(0).constructor.constructor('return 1')();\n"],
    ["object literal", "({}).constructor.constructor('return 1')();\n"],
    ["a builtin function", "JSON.parse.constructor('return 1')();\n"],
    ["a builtin constructor", "Object.constructor('return 1')();\n"],
    ["a prototype method", "Array.prototype.map.constructor('return 1')();\n"],
    [
      "a local function declaration",
      "function f(){}\nf.constructor('return 1')();\n",
    ],
    [
      "a local arrow const",
      "const f = () => {};\nf.constructor('return 1')();\n",
    ],
    [
      "a function held in an object property",
      "const o = { f: () => {} };\no.f.constructor('return 1')();\n",
    ],
    [
      "a function held in an array element",
      "const arr = [() => {}];\narr[0].constructor('return 1')();\n",
    ],
    [
      "a lookalike object's own constructor property, CALLED",
      "const fake = { constructor: function(){ return 1; } };\nfake.constructor();\nmodule.exports = { fake };\n",
    ],
  ])(
    "CALLING .constructor on %s reaches the Function constructor and fails closed",
    async (_label, source) => {
      // VT-307c-reflection-closure. `Function` is reachable from EVERY
      // value in JavaScript via `.constructor` -- eleven of these twelve
      // spellings were reproduced end-to-end (real Node execution +
      // gate-eligible closure + complete=true + the exact package OUT),
      // reaching it from an array, a string, a number, an object literal,
      // assorted builtins, and ordinary local functions. Unlike every
      // other family this series has closed, there is no provenance to
      // preserve: the channel is ambient, so no amount of resolution can
      // narrow it.
      //
      // The bound that keeps this precise is that the `.constructor` value
      // must itself be CALLED or CONSTRUCTED. Merely READING it, or
      // calling a MEMBER of it, stays complete -- which is what preserves
      // the long-standing `obj.constructor._load(...)` /
      // `obj.constructor.createRequire(...)` precision controls and the
      // real-world `qs` Buffer duck-type check
      // (`obj.constructor.isBuffer(obj)`). The last row here is the
      // acknowledged conservative edge: a lookalike object whose own
      // `constructor` property is invoked directly is indistinguishable,
      // statically, from the real channel.
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toContain("function_constructor");
    },
  );

  it.each([
    [
      "reading .constructor without calling it",
      "const o = { f: () => {} };\nconst C = o.f.constructor;\nvoid C;\nmodule.exports = {};\n",
    ],
    [
      "calling a MEMBER of .constructor (qs's Buffer duck-type check)",
      "function isBuf(obj){ return !!(obj.constructor && obj.constructor.isBuffer && obj.constructor.isBuffer(obj)); }\nmodule.exports = { isBuf };\n",
    ],
    [
      "an ordinary class instantiated normally",
      "class Widget { constructor(){ this.x = 1; } }\nconst w = new Widget();\nmodule.exports = { w };\n",
    ],
  ])(
    "stays complete for %s (VT-307c-reflection-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );

  it("finds an aliased Function construct in a never-called function of a transitively loaded dependency", async () => {
    const root = tempProject();
    write(
      root,
      "node_modules/dep/package.json",
      JSON.stringify({ name: "dep", version: "1.0.0", main: "index.js" }),
    );
    write(
      root,
      "node_modules/dep/index.js",
      "const F = Function;\nfunction neverCalled(src){ return F(src)(); }\nmodule.exports = { neverCalled };\n",
    );
    const entry = write(root, "src/index.js", "require('dep');\n");

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("function_constructor");
  });
});

/**
 * VT-307c-structural-closure. The final certification pass audited every
 * remaining literal-syntax match in the classifier and asked, of each, the
 * only question that matters: when this literal match MISSES, does the
 * construct still fail closed?
 *
 * Most remaining literals are member NAMES (`.prototype`, `.constructor`,
 * `.main`), which are literal in source by definition and whose RECEIVER
 * is resolved through the shared relation -- nothing to fix. Three were
 * precision shortcuts whose miss was supposed to fall through to a
 * fail-closed path, and two of those turned out not to:
 *
 * - `classifyLoaderConstruct`'s unknown-member fail-closed fallback was
 *   gated on `PropertyAccessExpression`, so `module['require'](name)` (an
 *   ordinary loader call) and `Module['someFutureThing'](x)` (an
 *   unrecognized member call) both slipped past it on a genuinely
 *   authoritative receiver;
 * - a `.call`/`.apply`-wearing callee was never resolved as its bare self,
 *   so `require.call(null, name)` was lost.
 *
 * `delete Module[computed]` had the same PropertyAccess-only gate. All
 * three now go through the normalized member accessor.
 */
describe("ModuleLoadClosure: every literal-match miss fails closed (VT-307c-structural-closure)", () => {
  it.each([
    // The literal `module_require` chain walk misses these; each must
    // still fail closed rather than silently stay unclassified.
    [
      "module['require'](name) -- element-access loader call",
      "module['require'](process.env.N || 'x');\nmodule.exports={};\n",
    ],
    [
      "const m = module; m.require(name) -- aliased owner",
      "const m = module;\nm.require(process.env.N || 'x');\nmodule.exports={};\n",
    ],
    [
      "globalThis.module.require(name)",
      "globalThis.module = module;\nglobalThis.module.require(process.env.N || 'x');\nmodule.exports={};\n",
    ],
    // Unknown members on an authoritative receiver, both spellings.
    [
      "Module['someFutureThing'](x) -- unknown member via element access",
      "const M = require('module');\nif (M['someFutureThing']) { M['someFutureThing'](1); }\nmodule.exports={};\n",
    ],
    [
      "Module[computed] = fn -- computed-key write",
      "const M = require('module');\nM[process.env.K || 'zz'] = function(){};\nmodule.exports={};\n",
    ],
    [
      "delete Module[computed] -- computed-key delete",
      "const M = require('module');\ndelete M[process.env.K || 'zz'];\nmodule.exports={};\n",
    ],
  ])("%s fails closed", async (_label, source) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("loader_capability_escape");
  });

  it.each([
    [
      "require.call(null, name) -- .call-wearing callee",
      "require.call(null, process.env.N || 'x');\nmodule.exports={};\n",
      "aliased_require",
    ],
    [
      "globalThis['eval'](src) -- element-access eval",
      "globalThis['eval']('1');\nmodule.exports={};\n",
      "aliased_eval",
    ],
    [
      "globalThis.eval(src) -- property-access eval",
      "globalThis.eval('1');\nmodule.exports={};\n",
      "aliased_eval",
    ],
  ])("%s resolves to %s", async (_label, source, expectedReason) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain(expectedReason);
  });

  it.each([
    // The literal shortcuts still win where they hit -- a miss must
    // degrade to the generic escape, never the reverse.
    [
      "module.require(name)",
      "module.require(process.env.N || 'x');\nmodule.exports={};\n",
      "module_require",
    ],
    [
      "require.main.require(name)",
      "require.main.require(process.env.N || 'x');\nmodule.exports={};\n",
      "module_require",
    ],
    [
      "process.mainModule.require(name)",
      "process.mainModule.require(process.env.N || 'x');\nmodule.exports={};\n",
      "module_require",
    ],
    ["direct eval(src)", "eval('1');\nmodule.exports={};\n", "eval"],
    [
      "direct require(dynamic)",
      "require(process.env.N || 'x');\nmodule.exports={};\n",
      "dynamic_require",
    ],
  ])(
    "%s keeps its specific reason %s",
    async (_label, source, expectedReason) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toContain(expectedReason);
    },
  );

  it.each([
    [
      "a user object with its own require member, element-accessed",
      "const fake = { require(){ return 1; } };\nfake['require']('x');\nmodule.exports={fake};\n",
    ],
    [
      "a user object with a someFutureThing member",
      "const fake = { someFutureThing(){ return 1; } };\nfake['someFutureThing'](1);\nmodule.exports={fake};\n",
    ],
    [
      "computed writes and deletes on an ordinary object",
      "const o = {};\no[process.env.K || 'a'] = 1;\ndelete o[process.env.K || 'a'];\nmodule.exports={o};\n",
    ],
    [
      "ordinary .call/.apply on a user function",
      "function f(a){ return a; }\nf.call(null, 1);\nf.apply(null, [2]);\nmodule.exports={f};\n",
    ],
  ])(
    "stays complete for %s (VT-307c-structural-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );
});

/**
 * VT-307c-wrapper-closure. The provenance relation resolved receivers and
 * callees WITHOUT first unwrapping the syntax that is transparent at
 * runtime -- parenthesization, TypeScript's erased type assertions, and
 * the comma operator. The value walker (`valueFlowOperandsOf`) had always
 * looked through exactly these forms; the provenance relation had not, so
 * the two disagreed, and six spellings were reproduced end-to-end:
 *
 *   (0, Module._preloadModules)([...])   -- the standard indirect-call
 *   (0, eval)(src)                          idiom for invoking something
 *   (0, Function)(src)()                    with `this` unbound
 *   (M, M._preloadModules)([...])
 *   (M as any)._preloadModules([...])    -- TS assertions, erased at
 *   (M!)._preloadModules([...])             runtime
 *
 * None involves an unknown API or a new value container: each merely
 * wraps a capability the relation already resolved in syntax it did not
 * look through. The fix unwraps all three at the top of the relation, so
 * value-side and provenance-side agree by construction.
 */
describe("ModuleLoadClosure: runtime-transparent wrappers resolve through (VT-307c-wrapper-closure)", () => {
  it.each([
    [
      "(0, M._preloadModules)([...]) -- comma indirect call",
      "const M = require('module');\n(0, M._preloadModules)(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "(M, M._preloadModules)([...]) -- comma with a capability on the left",
      "const M = require('module');\n(M, M._preloadModules)(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "(0, eval)(src) -- comma indirect eval",
      "(0, eval)('1');\nmodule.exports={};\n",
      "aliased_eval",
    ],
    [
      "(0, Function)(src)() -- comma indirect Function",
      "(0, Function)('return 1')();\nmodule.exports={};\n",
      "function_constructor",
    ],
    [
      "((M))._preloadModules([...]) -- nested parentheses",
      "const M = require('module');\n((M))._preloadModules(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "(0, (0, M._preloadModules))([...]) -- nested comma",
      "const M = require('module');\n(0, (0, M._preloadModules))(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
  ])("%s -> %s", async (_label, source, expectedReason) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain(expectedReason);
  });

  it.each([
    [
      "(M as any)._preloadModules([...])",
      "const M = require('module');\n(M as any)._preloadModules(['x']);\nexport {};\n",
    ],
    [
      "(M!)._preloadModules([...])",
      "const M = require('module');\n(M!)._preloadModules(['x']);\nexport {};\n",
    ],
    [
      "(M satisfies unknown)._preloadModules([...])",
      "const M = require('module');\n(M satisfies unknown as any)._preloadModules(['x']);\nexport {};\n",
    ],
  ])(
    "%s -> module_internal_load (TypeScript assertions are erased at runtime)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.ts", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(false);
      expect(reasonsOf(closure)).toContain("module_internal_load");
    },
  );

  it.each([
    [
      "an ordinary (0, fn)() indirect call",
      "function fn(){ return 1; }\nconst r = (0, fn)();\nmodule.exports={r};\n",
    ],
    [
      "ordinary parenthesized arithmetic and comma",
      "const a = (1 + 2);\nconst b = (1, 2);\nmodule.exports={a,b};\n",
    ],
    [
      "an ordinary optional-chaining call",
      "const o = { a: { b(){ return 1; } } };\nconst r = o?.a?.b?.();\nmodule.exports={r};\n",
    ],
    [
      "ordinary Reflect.apply and spread calls",
      "function fn(a){ return a; }\nconst r = Reflect.apply(fn, null, [1]);\nconst s = fn(...[2]);\nmodule.exports={r,s};\n",
    ],
  ])(
    "stays complete for %s (VT-307c-wrapper-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );
});

/**
 * VT-307c-selector-closure. Three more places where the value side and the
 * provenance side of the model disagreed, each reproduced end-to-end:
 *
 * - value-SELECTING operators in CALLEE position. `valueFlowOperandsOf`
 *   had always resolved `?:`, `||`, `??` and `&&` on the value side; the
 *   provenance relation had not, so `(cond ? Module._preloadModules :
 *   null)([...])`, `(x || Module._preloadModules)([...])`,
 *   `(x ?? Function)(src)()` and `(1 && eval)(src)` all lost their
 *   capability at the callee.
 * - `await`. `await X` of a non-thenable IS `X`.
 * - class heritage. `class H extends Module {}` makes every static member
 *   of the base reachable through `H`, which this model does not track, so
 *   the heritage clause now fails closed at the declaration -- the same
 *   treatment every other position that hands a capability somewhere
 *   untracked already gets.
 */
describe("ModuleLoadClosure: value-selecting operators, await and heritage (VT-307c-selector-closure)", () => {
  it.each([
    [
      "(cond ? M._preloadModules : null)([...])",
      "const M = require('module');\n(process.env.Q ? null : M._preloadModules)(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "(x || M._preloadModules)([...])",
      "const M = require('module');\n(process.env.Q || M._preloadModules)(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "(x ?? M._preloadModules)([...])",
      "const M = require('module');\n(process.env.Q ?? M._preloadModules)(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "(1 && M._preloadModules)([...])",
      "const M = require('module');\n(1 && M._preloadModules)(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "(x ?? Function)(src)()",
      "(process.env.Q ?? Function)('return 1')();\nmodule.exports={};\n",
      "function_constructor",
    ],
    [
      "(1 && eval)(src)",
      "(1 && eval)('1');\nmodule.exports={};\n",
      "aliased_eval",
    ],
    [
      "(cond ? M : null)._preloadModules([...]) -- selector in RECEIVER position",
      "const M = require('module');\n(process.env.Q ? null : M)._preloadModules(['x']);\nmodule.exports={};\n",
      "module_internal_load",
    ],
    [
      "class H extends M {} then H._preloadModules([...])",
      "const M = require('module');\nclass H extends M {}\nH._preloadModules(['x']);\nmodule.exports={H};\n",
      "loader_capability_escape",
    ],
  ])("%s -> %s", async (_label, source, expectedReason) => {
    const root = tempProject();
    const entry = write(root, "src/index.js", source);

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain(expectedReason);
  });

  it("(await M)._preloadModules([...]) resolves through await", async () => {
    const root = tempProject();
    const entry = write(
      root,
      "src/index.js",
      "const M = require('module');\nasync function go(){ (await M)._preloadModules(['x']); }\nmodule.exports={go};\n",
    );

    const closure = await closureFor(root, [entry]);

    expect(closure.complete).toBe(false);
    expect(reasonsOf(closure)).toContain("module_internal_load");
  });

  it.each([
    [
      "an ordinary conditional callee",
      "function a(){return 1;}\nfunction b(){return 2;}\nconst r = (process.env.Q ? a : b)();\nmodule.exports={r};\n",
    ],
    [
      "ordinary logical-operator callees",
      "function a(){return 1;}\nconst r = (process.env.Q || a)();\nconst s = (1 && a)();\nconst t = (process.env.Q ?? a)();\nmodule.exports={r,s,t};\n",
    ],
    [
      "an ordinary class hierarchy",
      "class Base { static s = 1; }\nclass Sub extends Base {}\nmodule.exports={v:Sub.s};\n",
    ],
    [
      "ordinary await of a non-capability",
      "async function go(){ const v = await Promise.resolve(1); return v; }\nmodule.exports={go};\n",
    ],
    [
      "ordinary try/switch/loop assignment",
      "let c;\ntry { c = 1; } finally {}\nswitch(1){case 1: c=2; break;}\nfor(let i=0;i<1;i++){c=3;}\nmodule.exports={c};\n",
    ],
  ])(
    "stays complete for %s (VT-307c-selector-closure precision control)",
    async (_label, source) => {
      const root = tempProject();
      const entry = write(root, "src/index.js", source);

      const closure = await closureFor(root, [entry]);

      expect(closure.complete).toBe(true);
      expect(closure.incompleteness).toEqual([]);
    },
  );
});
