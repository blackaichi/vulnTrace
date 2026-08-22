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
