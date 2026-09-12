#!/usr/bin/env node
"use strict";
/**
 * RUNTIME ORACLE for fixtures/package-entry (P1-A3).
 *
 * Asserts, under real `node` and out-of-process, what each package really
 * publishes from each of its declared public surfaces -- by callable
 * IDENTITY and by resolved FILE, not by name -- which surfaces are not
 * importable at all, and which callable each consumer really executes.
 * Every expectation in the P1-A3 suites is derived from this, never from
 * what the analyzer happens to say.
 *
 * VulnTrace itself never executes target code (AGENTS.md); this oracle is
 * test-only and is run out-of-process by the integration suite.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

const nm = (...segments) => path.join(__dirname, "node_modules", ...segments);
const src = (file) => require(path.join(__dirname, "src", file));
/**
 * Requires a package through its BARE specifier, from this fixture root --
 * i.e. through the real `exports`/`main` algorithm. Deliberately distinct
 * from `nm(...)`, which is a PATH request and (as this oracle's own
 * expmain-lib check asserts) never consults `exports` at all.
 */
const pub = (specifier) =>
  require(require.resolve(specifier, { paths: [__dirname] }));
const rel = (p) => path.relative(__dirname, p).split(path.sep).join("/");

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
}

/** `require.resolve` from this fixture root, or the thrown error's `code`. */
function resolveOrCode(specifier) {
  try {
    return rel(require.resolve(specifier, { paths: [__dirname] }));
  } catch (error) {
    return "ERR:" + error.code;
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
// exports "." vs main -- `exports` wins, and the superseded `main` file is
// not reachable through the package name at all.
// ---------------------------------------------------------------------------
check('expmain-lib: "exports" has authority over "main"', () => {
  assert.equal(resolveOrCode("expmain-lib"), "node_modules/expmain-lib/modern.js");

  const pkg = pub("expmain-lib");
  const modern = require(nm("expmain-lib", "modern.js"));
  const legacy = require(nm("expmain-lib", "legacy.js"));

  assert.equal(pkg.vulnerable, modern.vulnerable);
  assert.notEqual(pkg.vulnerable, legacy.vulnerable);
  assert.equal(pkg.vulnerable("x"), "expmain-modern:x");
});

check("expmain-lib: the consumer really executes the public entry", () => {
  const modern = require(nm("expmain-lib", "modern.js"));
  const counted = countCalls(modern, "vulnerable");
  // The consumer captured `pkg` at load time, so re-require it after the
  // counter is installed.
  delete require.cache[require.resolve(path.join(__dirname, "src", "expmain-consumer.cjs"))];
  assert.equal(src("expmain-consumer.cjs")("x"), "expmain-modern:x");
  assert.equal(counted.calls, 1);
  counted.restore();
});

check("expmain-lib: an absolute PATH request bypasses exports (the closed probe)", () => {
  // This is the measured Node divergence P1-A3 § C had to close: a path
  // request never consults `exports`, so it lands on the superseded
  // `main`. That file is not part of the package's public surface.
  assert.equal(resolveOrCode(nm("expmain-lib")), "node_modules/expmain-lib/legacy.js");
});

check("expmainsafe-lib: public `vulnerable` is SAFE and never called", () => {
  assert.equal(
    resolveOrCode("expmainsafe-lib"),
    "node_modules/expmainsafe-lib/modern.js",
  );

  const pkg = pub("expmainsafe-lib");
  const modern = require(nm("expmainsafe-lib", "modern.js"));
  const legacy = require(nm("expmainsafe-lib", "legacy.js"));

  assert.equal(pkg.vulnerable, modern.vulnerable);
  assert.notEqual(pkg.vulnerable, legacy.vulnerable);
  assert.equal(pkg.vulnerable("x"), "expmainsafe-safe:x");

  const publicCalls = countCalls(modern, "vulnerable");
  const legacyCalls = countCalls(legacy, "vulnerable");
  delete require.cache[
    require.resolve(path.join(__dirname, "src", "expmainsafe-consumer.cjs"))
  ];
  assert.equal(src("expmainsafe-consumer.cjs")("x"), "expmainsafe-dangerous:x");
  // The dangerous legacy callable DOES run -- but never as `pkg.vulnerable`.
  assert.equal(legacyCalls.calls, 1);
  assert.equal(publicCalls.calls, 0);
  publicCalls.restore();
  legacyCalls.restore();
});

// ---------------------------------------------------------------------------
// exports string shorthand
// ---------------------------------------------------------------------------
check("shorthand-lib: the string shorthand is the public entry", () => {
  assert.equal(
    resolveOrCode("shorthand-lib"),
    "node_modules/shorthand-lib/out/index.js",
  );

  const pkg = pub("shorthand-lib");
  const sibling = require(nm("shorthand-lib", "index.js"));
  assert.notEqual(pkg.vulnerable, sibling.vulnerable);
  assert.equal(pkg.vulnerable("x"), "shorthand-public:x");
  assert.equal(src("shorthand-consumer.cjs")("x"), "shorthand-public:x");
});

// ---------------------------------------------------------------------------
// exports subpaths -- distinct public surfaces, and encapsulation
// ---------------------------------------------------------------------------
check("subpath-lib: `.` and `./parse` are DIFFERENT public surfaces", () => {
  assert.equal(resolveOrCode("subpath-lib"), "node_modules/subpath-lib/index.js");
  assert.equal(
    resolveOrCode("subpath-lib/parse"),
    "node_modules/subpath-lib/lib/parse.js",
  );

  const root = pub("subpath-lib");
  const parse = require(nm("subpath-lib", "lib", "parse.js"));
  assert.notEqual(root.vulnerable, parse.vulnerable);
  assert.equal(root.vulnerable("x"), "subpath-root-safe:x");
  assert.equal(parse.vulnerable("x"), "subpath-parse:x");
});

check("subpath-lib: the consumer calls ONLY the ./parse surface", () => {
  const root = pub("subpath-lib");
  const parse = require(nm("subpath-lib", "lib", "parse.js"));
  const rootCalls = countCalls(root, "vulnerable");
  const parseCalls = countCalls(parse, "vulnerable");
  delete require.cache[
    require.resolve(path.join(__dirname, "src", "subpath-consumer.cjs"))
  ];
  assert.equal(src("subpath-consumer.cjs")("x"), "subpath-parse:x");
  assert.equal(parseCalls.calls, 1);
  assert.equal(rootCalls.calls, 0);
  rootCalls.restore();
  parseCalls.restore();
});

check("subpath-lib: an UNEXPORTED internal file is not importable", () => {
  assert.equal(
    resolveOrCode("subpath-lib/lib/internal"),
    "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
  assert.equal(
    resolveOrCode("subpath-lib/lib/internal.js"),
    "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
});

// ---------------------------------------------------------------------------
// subpath-only package -- no "." entry exists
// ---------------------------------------------------------------------------
check("subpathonly-lib: the package ROOT is not importable", () => {
  assert.equal(resolveOrCode("subpathonly-lib"), "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED");
  assert.equal(
    resolveOrCode("subpathonly-lib/get"),
    "node_modules/subpathonly-lib/get.js",
  );
  assert.equal(src("subpathonly-consumer.cjs")("x"), "subpathonly-get:x");
});

// ---------------------------------------------------------------------------
// conditional exports
// ---------------------------------------------------------------------------
check("cond-lib: a CommonJS consumer really loads the `require` branch", () => {
  assert.equal(resolveOrCode("cond-lib"), "node_modules/cond-lib/cjs.cjs");
  assert.equal(src("cond-cjs-consumer.cjs")("x"), "cond-cjs:x");
});

check("condsafe-lib: the ACTIVE `require` branch is safe and never called", () => {
  assert.equal(resolveOrCode("condsafe-lib"), "node_modules/condsafe-lib/cjs.cjs");

  const cjs = require(nm("condsafe-lib", "cjs.cjs"));
  const counted = countCalls(cjs, "vulnerable");
  delete require.cache[
    require.resolve(path.join(__dirname, "src", "condsafe-consumer.cjs"))
  ];
  assert.equal(src("condsafe-consumer.cjs")("x"), "condsafe-other:x");
  assert.equal(counted.calls, 0);
  counted.restore();
});

// ---------------------------------------------------------------------------
// wildcard subpaths
// ---------------------------------------------------------------------------
check("wildcard-lib: a declared pattern subpath resolves; an absent one does not", () => {
  assert.equal(
    resolveOrCode("wildcard-lib/features/alpha"),
    "node_modules/wildcard-lib/src/features/alpha.js",
  );
  assert.equal(resolveOrCode("wildcard-lib/features/missing"), "ERR:MODULE_NOT_FOUND");
  // No "." entry exists in the pattern-only map.
  assert.equal(resolveOrCode("wildcard-lib"), "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED");
  assert.equal(src("wildcard-consumer.cjs")("x"), "wildcard-alpha:x");
});

// ---------------------------------------------------------------------------
// scoped packages
// ---------------------------------------------------------------------------
check("@scope/pkg: the package ROOT is node_modules/@scope/pkg", () => {
  assert.equal(
    resolveOrCode("@scope/pkg"),
    "node_modules/@scope/pkg/out/index.js",
  );
  assert.equal(
    resolveOrCode("@scope/pkg/api"),
    "node_modules/@scope/pkg/out/api.js",
  );
  assert.equal(
    resolveOrCode("@scope/pkg/out/api.js"),
    "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
  assert.equal(resolveOrCode("@other/pkg"), "node_modules/@other/pkg/index.js");
});

check("@scope/pkg vs @other/pkg: same basename, different packages", () => {
  const scoped = pub("@scope/pkg");
  const other = pub("@other/pkg");
  assert.notEqual(scoped.vulnerable, other.vulnerable);

  const otherCalls = countCalls(other, "vulnerable");
  delete require.cache[
    require.resolve(path.join(__dirname, "src", "scope-consumer.cjs"))
  ];
  assert.equal(src("scope-consumer.cjs")("x"), "scope-root:x");
  assert.equal(otherCalls.calls, 0);
  otherCalls.restore();

  assert.equal(src("scope-api-consumer.cjs")("x"), "scope-api:x");
});

// ---------------------------------------------------------------------------
// npm alias twin -- same manifest name, same version, two install locations
// ---------------------------------------------------------------------------
check("twin-lib / twin-alias: same manifest name, DISTINCT instances", () => {
  const real = require(nm("twin-lib", "package.json"));
  const alias = require(nm("twin-alias", "package.json"));
  assert.equal(real.name, "twin-lib");
  assert.equal(alias.name, "twin-lib");
  assert.equal(real.version, alias.version);

  assert.equal(resolveOrCode("twin-lib"), "node_modules/twin-lib/index.js");
  assert.equal(resolveOrCode("twin-alias"), "node_modules/twin-alias/index.js");
  assert.equal(resolveOrCode("twin-alias/api"), "node_modules/twin-alias/api.js");

  const realPkg = pub("twin-lib");
  const aliasPkg = pub("twin-alias");
  assert.notEqual(realPkg.vulnerable, aliasPkg.vulnerable);
});

check("twin-consumer: only the ALIAS instance's public entry is called", () => {
  const realPkg = pub("twin-lib");
  const aliasPkg = pub("twin-alias");
  const realCalls = countCalls(realPkg, "vulnerable");
  const aliasCalls = countCalls(aliasPkg, "vulnerable");
  delete require.cache[
    require.resolve(path.join(__dirname, "src", "twin-consumer.cjs"))
  ];
  assert.equal(src("twin-consumer.cjs")("x"), "twin-alias-danger:x");
  assert.equal(aliasCalls.calls, 1);
  assert.equal(realCalls.calls, 0);
  realCalls.restore();
  aliasCalls.restore();
});

check("twin-api-consumer: the same split holds on a SUBPATH surface", () => {
  const realApi = require(nm("twin-lib", "api.js"));
  const aliasApi = require(nm("twin-alias", "api.js"));
  const realCalls = countCalls(realApi, "vulnerable");
  const aliasCalls = countCalls(aliasApi, "vulnerable");
  delete require.cache[
    require.resolve(path.join(__dirname, "src", "twin-api-consumer.cjs"))
  ];
  assert.equal(src("twin-api-consumer.cjs")("x"), "twin-alias-api-danger:x");
  assert.equal(aliasCalls.calls, 1);
  assert.equal(realCalls.calls, 0);
  realCalls.restore();
  aliasCalls.restore();
});

// ---------------------------------------------------------------------------
// exports encapsulation
// ---------------------------------------------------------------------------
check("encap-lib: the internal vulnerable file runs but is NOT importable", () => {
  assert.equal(
    resolveOrCode("encap-lib/lib/vulnerable"),
    "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
  assert.equal(src("encap-consumer.cjs")("x"), "encap-internal:x");
  // The public entry publishes no `vulnerable` at all.
  assert.equal(pub("encap-lib").vulnerable, undefined);
});

// ---------------------------------------------------------------------------
// main-only fallback
// ---------------------------------------------------------------------------
check("mainonly-lib: `main` beats the root index.js convention", () => {
  assert.equal(
    resolveOrCode("mainonly-lib"),
    "node_modules/mainonly-lib/lib/index.js",
  );
  const pkg = pub("mainonly-lib");
  const sibling = require(nm("mainonly-lib", "index.js"));
  assert.notEqual(pkg.vulnerable, sibling.vulnerable);
  assert.equal(src("mainonly-consumer.cjs")("x"), "mainonly-main:x");
});

// ---------------------------------------------------------------------------
// invalid exports target / package-root escape
// ---------------------------------------------------------------------------
check("badexports-lib: an exports target that is not there is unresolvable", () => {
  assert.equal(resolveOrCode("badexports-lib"), "ERR:MODULE_NOT_FOUND");
  // The sibling exists and exports the advisory's literal name -- and is
  // still not the package's public entry: it is not reachable through the
  // package NAME at all, only by an explicit relative file path.
  assert.equal(
    resolveOrCode("badexports-lib/index.js"),
    "ERR:ERR_PACKAGE_PATH_NOT_EXPORTED",
  );
  assert.equal(src("badexports-consumer.cjs")("x"), "badexports-sibling:x");
});

check("escape-lib: an exports target outside the package root is refused", () => {
  const resolved = resolveOrCode("escape-lib");
  assert.ok(
    resolved.startsWith("ERR:"),
    `expected escape-lib to be unresolvable, got ${resolved}`,
  );
});

// ---------------------------------------------------------------------------
// subpath authority -> forwarding -> implementation
// ---------------------------------------------------------------------------
check("subpathfwd-lib: ./api forwards its public name to the implementation", () => {
  assert.equal(
    resolveOrCode("subpathfwd-lib/api"),
    "node_modules/subpathfwd-lib/out/api.js",
  );
  const api = require(nm("subpathfwd-lib", "out", "api.js"));
  const impl = require(nm("subpathfwd-lib", "out", "impl.js"));
  const root = pub("subpathfwd-lib");
  assert.equal(api.vulnerable, impl.vulnerable);
  assert.notEqual(root.vulnerable, impl.vulnerable);
  assert.equal(src("subpathfwd-consumer.cjs")("x"), "subpathfwd-impl:x");
});

check("renamed-lib: the public name maps to a DIFFERENT internal name", () => {
  const pkg = pub("renamed-lib");
  const impl = require(nm("renamed-lib", "impl.js"));
  assert.equal(pkg.vulnerable, impl.internalName);
  assert.equal(src("renamed-consumer.cjs")("x"), "renamed-impl:x");
});

// ---------------------------------------------------------------------------
// the unreachable control
// ---------------------------------------------------------------------------
check("unreach-lib: the public `vulnerable` is dangerous and NEVER called", () => {
  const pkg = pub("unreach-lib");
  const counted = countCalls(pkg, "vulnerable");
  delete require.cache[
    require.resolve(path.join(__dirname, "src", "unreach-consumer.cjs"))
  ];
  assert.equal(src("unreach-consumer.cjs")("x"), "unreach-safe:x");
  assert.equal(counted.calls, 0);
  counted.restore();
});

process.stdout.write(`${checks.length} checks OK\n`);
process.stdout.write(JSON.stringify({ ok: true, checks }, null, 2) + "\n");
