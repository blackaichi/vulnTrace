#!/usr/bin/env node
"use strict";
/**
 * RUNTIME ORACLE for fixtures/workspaces (P1-A4).
 *
 * Asserts, under real `node` and out-of-process, what a monorepo's local
 * workspace packages really publish, which canonical package ROOT each
 * public surface really belongs to, which of two same-name/same-version
 * copies each consumer really executes, and which requests real Node
 * refuses outright. Every expectation in the P1-A4 suites is derived from
 * this, never from what the analyzer happens to say.
 *
 * The two questions this oracle exists to answer, which no amount of
 * static reasoning may assume:
 *
 * 1. Does a reference through `node_modules/<name>` and a reference
 *    through `packages/<name>` really land on ONE package at runtime?
 *    (`require.cache` identity and `fs.realpath` both answer yes.)
 * 2. Are a workspace copy and a separately installed copy of the same
 *    name and version really TWO packages? (Both answer yes.)
 *
 * VulnTrace itself never executes target code (AGENTS.md); this oracle is
 * test-only and is run out-of-process by the integration suite.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = __dirname;
const APP = path.join(ROOT, "packages", "app");

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
}

/**
 * `require.resolve` from a given consumer directory -- the TRUE consumer
 * context, not the repo root. Returns the repo-relative resolved file, or
 * `"ERR:<code>"` when Node refuses.
 */
function resolveFrom(dir, specifier) {
  try {
    return rel(require.resolve(specifier, { paths: [dir] }));
  } catch (error) {
    return "ERR:" + error.code;
  }
}

/** Loads a specifier from a consumer directory through the real algorithm. */
function requireFrom(dir, specifier) {
  return require(require.resolve(specifier, { paths: [dir] }));
}

/** The nearest ancestor directory of `file` that contains a package.json. */
function packageRootOf(file) {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      return rel(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
}

/** Counts calls to `holder[name]` without changing what it returns. */
function countCalls(holder, name) {
  const original = holder[name];
  const state = { calls: 0 };
  holder[name] = function counted(...args) {
    state.calls += 1;
    return original.apply(this, args);
  };
  state.restore = () => {
    holder[name] = original;
  };
  return state;
}

// ---------------------------------------------------------------------------
// A -- The basic npm workspace case.
// ---------------------------------------------------------------------------

check("lib resolves from the app to the WORKSPACE package, not a copy", () => {
  assert.equal(resolveFrom(APP, "lib"), "packages/lib/index.js");
  assert.equal(packageRootOf(path.join(ROOT, "packages/lib/index.js")), "packages/lib");
});

check("the workspace lib really publishes `vulnerable`", () => {
  const lib = requireFrom(APP, "lib");
  assert.equal(typeof lib.vulnerable, "function");
  assert.match(lib.vulnerable("x"), /^lib\/index\.js:vulnerable:/);
});

check("the app consumer really executes the workspace lib's sink", () => {
  const lib = requireFrom(APP, "lib");
  const counter = countCalls(lib, "vulnerable");
  require(path.join(APP, "src", "lib-consumer.cjs")).handle("x");
  counter.restore();
  assert.equal(counter.calls, 1);
});

// ---------------------------------------------------------------------------
// B -- SYMLINK CONVERGENCE. The invariant the whole task rests on.
// ---------------------------------------------------------------------------

check("node_modules/lib and packages/lib are the SAME physical package", () => {
  const throughLink = fs.realpathSync(path.join(ROOT, "node_modules", "lib"));
  const physical = fs.realpathSync(path.join(ROOT, "packages", "lib"));
  assert.equal(throughLink, physical);
});

check("and the SAME loaded module at runtime (one require.cache entry)", () => {
  // Node caches by realpath, so a reference through either spelling is
  // literally the same module object. This is why one canonical
  // PackageInstance -- not two -- is the sound model.
  const throughLink = require(path.join(ROOT, "node_modules", "lib", "index.js"));
  const throughPhysical = require(path.join(ROOT, "packages", "lib", "index.js"));
  assert.equal(throughLink, throughPhysical);
});

// ---------------------------------------------------------------------------
// C -- WORKSPACE vs INSTALLED copy: same name, same version, two packages.
// ---------------------------------------------------------------------------

check("workspace twinlib and installed twinlib declare identical identity", () => {
  const workspace = require(path.join(ROOT, "packages/twinlib/package.json"));
  const installed = require(path.join(ROOT, "node_modules/twinlib/package.json"));
  assert.equal(workspace.name, installed.name);
  assert.equal(workspace.version, installed.version);
});

check("...yet are physically distinct roots", () => {
  assert.notEqual(
    fs.realpathSync(path.join(ROOT, "packages", "twinlib")),
    fs.realpathSync(path.join(ROOT, "node_modules", "twinlib")),
  );
});

check("...and publish different implementations", () => {
  assert.equal(resolveFrom(APP, "twinlib"), "node_modules/twinlib/index.js");
  const installed = requireFrom(APP, "twinlib");
  const workspace = require(path.join(ROOT, "packages", "twinlib"));
  assert.equal(typeof installed.vulnerable, "function");
  assert.equal(installed.safe, undefined);
  assert.equal(typeof workspace.safe, "function");
  assert.equal(workspace.vulnerable, undefined);
});

// ---------------------------------------------------------------------------
// D -- NESTED node_modules: the consumer's own context decides.
// ---------------------------------------------------------------------------

check("nestedlib resolves to the NESTED copy from packages/app", () => {
  assert.equal(
    resolveFrom(APP, "nestedlib"),
    "packages/app/node_modules/nestedlib/index.js",
  );
});

check("...and to the ROOT copy from the repo root", () => {
  assert.equal(resolveFrom(ROOT, "nestedlib"), "node_modules/nestedlib/index.js");
});

check("the two nestedlib copies publish different names", () => {
  assert.equal(typeof requireFrom(APP, "nestedlib").vulnerable, "function");
  assert.equal(typeof requireFrom(ROOT, "nestedlib").safe, "function");
});

// ---------------------------------------------------------------------------
// E -- exports "." vs main, and explicit subpaths, for a WORKSPACE package.
// ---------------------------------------------------------------------------

check("workspace exports \".\" wins over main", () => {
  assert.equal(resolveFrom(APP, "expmainlib"), "packages/expmainlib/modern.js");
  const pkg = requireFrom(APP, "expmainlib");
  assert.equal(typeof pkg.safe, "function");
  // `vulnerable` is NOT what the package publishes, even though legacy.js
  // exports that literal name and is genuinely loaded.
  assert.equal(pkg.vulnerable, undefined);
});

check("the superseded workspace main is unreachable through the name", () => {
  // Real Node: there is no specifier that reaches legacy.js through the
  // package name. Only a path request does, and a path request is not a
  // publication.
  assert.equal(resolveFrom(APP, "expmainlib/legacy.js"), "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED");
});

check("workspace exports \".\" and \"./api\" are DISTINCT surfaces", () => {
  assert.equal(resolveFrom(APP, "exportslib"), "packages/exportslib/dist/index.js");
  assert.equal(resolveFrom(APP, "exportslib/api"), "packages/exportslib/dist/api.js");
  assert.notEqual(
    requireFrom(APP, "exportslib").vulnerable,
    requireFrom(APP, "exportslib/api").vulnerable,
  );
});

check("both exportslib surfaces belong to ONE workspace package root", () => {
  assert.equal(packageRootOf(path.join(ROOT, "packages/exportslib/dist/index.js")), "packages/exportslib");
  assert.equal(packageRootOf(path.join(ROOT, "packages/exportslib/dist/api.js")), "packages/exportslib");
});

check("exportslib's superseded main is unreachable through the name", () => {
  assert.equal(resolveFrom(APP, "exportslib/legacy.js"), "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED");
});

// ---------------------------------------------------------------------------
// F -- SUBPATH-ONLY workspace package: the root surface does not exist.
// ---------------------------------------------------------------------------

check("a subpath-only workspace package REFUSES its root surface", () => {
  // index.js exists on disk and exports `vulnerable`. Real Node still
  // refuses -- there is no `exports` "." entry. Inventing a root entry
  // here would be a fabricated public surface.
  assert.ok(fs.existsSync(path.join(ROOT, "packages/subpathonlylib/index.js")));
  assert.equal(resolveFrom(APP, "subpathonlylib"), "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED");
});

check("...while its declared subpath resolves authoritatively", () => {
  assert.equal(resolveFrom(APP, "subpathonlylib/api"), "packages/subpathonlylib/api.js");
});

// ---------------------------------------------------------------------------
// G -- SCOPED workspace package.
// ---------------------------------------------------------------------------

check("a scoped workspace package resolves under its real scoped name", () => {
  assert.equal(resolveFrom(APP, "@scope/lib"), "packages/scopedlib/dist/index.js");
  assert.equal(resolveFrom(APP, "@scope/lib/api"), "packages/scopedlib/dist/api.js");
});

check("its canonical root is the DIRECTORY, not the manifest name", () => {
  // The directory is `packages/scopedlib`; the name is `@scope/lib`. The
  // root is identity; the name is metadata.
  assert.equal(
    packageRootOf(path.join(ROOT, "packages/scopedlib/dist/api.js")),
    "packages/scopedlib",
  );
  assert.equal(
    require(path.join(ROOT, "packages/scopedlib/package.json")).name,
    "@scope/lib",
  );
});

check("the scoped api surface really publishes the sink", () => {
  assert.equal(typeof requireFrom(APP, "@scope/lib/api").vulnerable, "function");
  assert.equal(requireFrom(APP, "@scope/lib").vulnerable, undefined);
});

// ---------------------------------------------------------------------------
// H -- FORWARDING out of a workspace package's public entry.
// ---------------------------------------------------------------------------

check("a workspace entry forwards its export to an internal file", () => {
  assert.equal(resolveFrom(APP, "fwdlib"), "packages/fwdlib/index.js");
  const impl = require(path.join(ROOT, "packages/fwdlib/impl.js"));
  assert.equal(requireFrom(APP, "fwdlib").vulnerable, impl.internal);
});

check("the forwarded implementation really runs from the app consumer", () => {
  const impl = require(path.join(ROOT, "packages/fwdlib/impl.js"));
  const counter = countCalls(impl, "internal");
  // The forward captured the ORIGINAL reference at load time, so call
  // through the public surface and assert on the returned marker instead.
  counter.restore();
  const result = require(path.join(APP, "src", "fwdlib-consumer.cjs")).handle("x");
  assert.match(result, /^fwdlib\/impl\.js:internal:/);
});

// ---------------------------------------------------------------------------
// I -- The SAFE control: a workspace sibling file is not a publication.
// ---------------------------------------------------------------------------

check("safelib publishes only `safe`", () => {
  assert.equal(resolveFrom(APP, "safelib"), "packages/safelib/index.js");
  const pkg = requireFrom(APP, "safelib");
  assert.equal(typeof pkg.safe, "function");
  assert.equal(pkg.vulnerable, undefined);
});

check("its sibling exports the advisory name but is not the package's entry", () => {
  assert.equal(
    typeof require(path.join(ROOT, "packages/safelib/sibling.js")).vulnerable,
    "function",
  );
  // safelib declares no `exports`, so it is NOT encapsulated: real Node
  // will happily resolve a DEEP IMPORT of the sibling. That is exactly why
  // the sibling's mere existence must not answer the advisory. The
  // advisory names `safelib`, and `require("safelib")` is index.js --
  // nothing in this fixture ever requests the deep path, so the sibling is
  // never even loaded.
  assert.equal(
    resolveFrom(APP, "safelib/sibling"),
    "packages/safelib/sibling.js",
  );
  assert.notEqual(resolveFrom(APP, "safelib"), "packages/safelib/sibling.js");
});

// ---------------------------------------------------------------------------
// J -- DUPLICATE workspace names: nothing resolves, so nothing may be chosen.
// ---------------------------------------------------------------------------

check("two workspace packages both declare the name `dup`", () => {
  assert.equal(require(path.join(ROOT, "packages/dupa/package.json")).name, "dup");
  assert.equal(require(path.join(ROOT, "packages/dupb/package.json")).name, "dup");
});

check("...and `require(\"dup\")` resolves to NEITHER", () => {
  assert.equal(resolveFrom(APP, "dup"), "ERR:MODULE_NOT_FOUND");
});

check("...while each remains individually addressable by its own directory", () => {
  assert.equal(resolveFrom(APP, "dupa"), "packages/dupa/index.js");
  assert.equal(resolveFrom(APP, "dupb"), "packages/dupb/index.js");
  assert.notEqual(
    require(path.join(ROOT, "packages/dupa")).vulnerable,
    require(path.join(ROOT, "packages/dupb")).vulnerable,
  );
});

// ---------------------------------------------------------------------------
// K -- file:/link: protocol targets, reached through materialized links.
// ---------------------------------------------------------------------------

check("file: and link: targets resolve through their node_modules links", () => {
  assert.equal(resolveFrom(APP, "filelib"), "filelib/index.js");
  assert.equal(resolveFrom(APP, "linklib"), "linklib/index.js");
});

check("...to roots OUTSIDE every workspace pattern", () => {
  // `workspaces: ["packages/*"]` does not cover them. They are package
  // roots by INSTALL, not by workspace declaration.
  assert.equal(packageRootOf(path.join(ROOT, "filelib/index.js")), "filelib");
  assert.equal(packageRootOf(path.join(ROOT, "linklib/index.js")), "linklib");
});

// ---------------------------------------------------------------------------
// L -- The root package is not a child package.
// ---------------------------------------------------------------------------

check("the monorepo root declares a name but publishes no entry", () => {
  const rootManifest = require(path.join(ROOT, "package.json"));
  assert.equal(rootManifest.name, "workspaces-fixture");
  assert.equal(rootManifest.main, undefined);
  assert.equal(rootManifest.exports, undefined);
  // Nothing can be required from it by name: it is not installed anywhere.
  assert.equal(resolveFrom(APP, "workspaces-fixture"), "ERR:MODULE_NOT_FOUND");
});

check("the root's workspace declaration is the array form", () => {
  assert.deepEqual(require(path.join(ROOT, "package.json")).workspaces, [
    "packages/*",
  ]);
});

// ---------------------------------------------------------------------------
// M -- CONDITIONAL exports in a workspace package.
// ---------------------------------------------------------------------------

check("a workspace conditional export selects the CONSUMER's condition", () => {
  // This fixture's consumers are CommonJS, so `require` is the active
  // branch and `import` is not reachable from them at all.
  assert.equal(resolveFrom(APP, "condlib"), "packages/condlib/cjs.cjs");
  assert.equal(resolveFrom(APP, "condsafelib"), "packages/condsafelib/cjs.cjs");
});

check("the ACTIVE workspace branch is the dangerous one for condlib", () => {
  const pkg = requireFrom(APP, "condlib");
  assert.equal(typeof pkg.vulnerable, "function");
  assert.match(pkg.vulnerable("x"), /^condlib\/cjs\.cjs:vulnerable:/);
});

check("the INACTIVE workspace branch is the dangerous one for condsafelib", () => {
  // The active (`require`) branch publishes only `safe`. `vulnerable`
  // exists solely in the `import` branch, which no consumer here selects.
  const pkg = requireFrom(APP, "condsafelib");
  assert.equal(typeof pkg.safe, "function");
  assert.equal(pkg.vulnerable, undefined);
  assert.ok(fs.existsSync(path.join(ROOT, "packages/condsafelib/esm.mjs")));
});

// ---------------------------------------------------------------------------
// N -- A linked VULNERABLE workspace copy beside a safe installed copy.
// ---------------------------------------------------------------------------

check("mixedlib resolves to the WORKSPACE copy from the app", () => {
  assert.equal(resolveFrom(APP, "mixedlib"), "packages/mixedlib/index.js");
  assert.equal(typeof requireFrom(APP, "mixedlib").vulnerable, "function");
});

check("...while a SAFE installed copy of the same name+version exists elsewhere", () => {
  const installed = require(
    path.join(ROOT, "packages/lib/node_modules/mixedlib"),
  );
  assert.equal(typeof installed.safe, "function");
  assert.equal(installed.vulnerable, undefined);
  assert.equal(
    require(path.join(ROOT, "packages/lib/node_modules/mixedlib/package.json"))
      .version,
    require(path.join(ROOT, "packages/mixedlib/package.json")).version,
  );
  assert.notEqual(
    fs.realpathSync(path.join(ROOT, "packages/mixedlib")),
    fs.realpathSync(path.join(ROOT, "packages/lib/node_modules/mixedlib")),
  );
});

check("the app really executes the workspace mixedlib's sink", () => {
  const result = require(
    path.join(APP, "src", "mixedlib-consumer.cjs"),
  ).handle("x");
  assert.match(result, /^workspace mixedlib\/index\.js:vulnerable:/);
});

// ---------------------------------------------------------------------------
// O -- A scoped workspace twin, never what the scoped name resolves to.
// ---------------------------------------------------------------------------

check("the scoped twin declares the same name but is not what resolves", () => {
  assert.equal(
    require(path.join(ROOT, "packages/scopedtwin/package.json")).name,
    "@scope/lib",
  );
  assert.equal(resolveFrom(APP, "@scope/lib"), "packages/scopedlib/dist/index.js");
  assert.notEqual(
    fs.realpathSync(path.join(ROOT, "packages/scopedtwin")),
    fs.realpathSync(path.join(ROOT, "packages/scopedlib")),
  );
});

// ---------------------------------------------------------------------------

process.stdout.write(JSON.stringify({ ok: true, checks }, null, 2) + "\n");
