#!/usr/bin/env node
"use strict";
/**
 * RUNTIME ORACLE for fixtures/authoritative-public-entry (P1-A2 / RWF-030).
 *
 * Asserts, under real `node` and out-of-process, what each package REALLY
 * publishes from its authoritative public entry -- by callable IDENTITY,
 * not by name -- and which callable a consumer really executes. Every
 * expectation in the P1-A2 suites is derived from this, never from what
 * the analyzer happens to say.
 *
 * VulnTrace itself never executes target code (AGENTS.md); this oracle is
 * test-only and is run out-of-process by the integration suite.
 */
const assert = require("node:assert/strict");
const path = require("node:path");

const nm = (...segments) => path.join(__dirname, "node_modules", ...segments);
const src = (file) => require(path.join(__dirname, "src", file));

const checks = [];
function check(name, fn) {
  fn();
  checks.push(name);
}

// ---------------------------------------------------------------------------
// THE canonical RWF-030 case: the package's public `vulnerable` is the SAFE
// implementation, and the dangerous same-named sibling is published under a
// different public name entirely.
// ---------------------------------------------------------------------------
check("publicsafe-lib: public `vulnerable` IS impl.safeImpl", () => {
  const pkg = require(nm("publicsafe-lib"));
  const impl = require(nm("publicsafe-lib", "impl.js"));
  const other = require(nm("publicsafe-lib", "other.js"));

  assert.equal(pkg.vulnerable, impl.safeImpl);
  assert.notEqual(pkg.vulnerable, other.vulnerable);
  assert.equal(pkg.vulnerable("x"), "publicsafe-safe:x");
});

check("publicsafe-lib: the consumer never executes the public target", () => {
  const impl = require(nm("publicsafe-lib", "impl.js"));

  let safeCalls = 0;
  const original = impl.safeImpl;
  impl.safeImpl = function counted(input) {
    safeCalls += 1;
    return original(input);
  };
  try {
    // The dangerous sibling DOES run -- but as `runOther`, which is not the
    // advisory's symbol. `pkg.vulnerable` (safeImpl) is never entered.
    assert.equal(src("publicsafe-consumer.cjs")("x"), "publicsafe-dangerous:x");
  } finally {
    impl.safeImpl = original;
  }
  assert.equal(safeCalls, 0);
});

// ---------------------------------------------------------------------------
// Reverse control: the public entry really does publish the dangerous one.
// ---------------------------------------------------------------------------
check("publicvuln-lib: public `vulnerable` IS impl.dangerousImpl", () => {
  const pkg = require(nm("publicvuln-lib"));
  const impl = require(nm("publicvuln-lib", "impl.js"));
  const safe = require(nm("publicvuln-lib", "safe.js"));

  assert.equal(pkg.vulnerable, impl.dangerousImpl);
  assert.notEqual(pkg.vulnerable, safe.vulnerable);
  assert.equal(
    src("publicvuln-consumer.cjs")("x"),
    "publicvuln-dangerous:x|publicvuln-harmless:x",
  );
});

// ---------------------------------------------------------------------------
// Direct public export, with a same-named sibling present anyway.
// ---------------------------------------------------------------------------
check("directpub-lib: public `vulnerable` is declared in the entry", () => {
  const pkg = require(nm("directpub-lib"));
  const other = require(nm("directpub-lib", "other.js"));

  assert.equal(pkg.vulnerable.name, "vulnerableImpl");
  assert.notEqual(pkg.vulnerable, other.vulnerable);
  assert.equal(pkg.vulnerable("x"), "directpub-vulnerable:x");
});

// ---------------------------------------------------------------------------
// Missing public symbol: nothing named `vulnerable` is published at all.
// ---------------------------------------------------------------------------
check("missing-lib: the public entry publishes no `vulnerable`", () => {
  const pkg = require(nm("missing-lib"));
  const other = require(nm("missing-lib", "other.js"));

  assert.equal(pkg.vulnerable, undefined);
  assert.equal(typeof other.vulnerable, "function");
});

// ---------------------------------------------------------------------------
// Several same-named siblings; only the entry's own chain decides.
// ---------------------------------------------------------------------------
check("multisibling-lib: public `vulnerable` IS impl.internalName", () => {
  const pkg = require(nm("multisibling-lib"));
  const impl = require(nm("multisibling-lib", "impl.js"));

  assert.equal(pkg.vulnerable, impl.internalName);
  for (const sibling of ["sibling-a.js", "sibling-b.js", "sibling-c.js"]) {
    assert.notEqual(
      pkg.vulnerable,
      require(nm("multisibling-lib", sibling)).vulnerable,
    );
  }
  assert.equal(pkg.vulnerable("x"), "multisibling-impl:x");
});

// ---------------------------------------------------------------------------
// Public rename onto a safe implementation, dangerous same-named sibling.
// ---------------------------------------------------------------------------
check("renamesafe-lib: public `vulnerable` IS impl.safeInternal", () => {
  const pkg = require(nm("renamesafe-lib"));
  const impl = require(nm("renamesafe-lib", "impl.js"));
  const other = require(nm("renamesafe-lib", "other.js"));

  assert.equal(pkg.vulnerable, impl.safeInternal);
  assert.notEqual(pkg.vulnerable, other.vulnerable);
  assert.equal(src("renamesafe-consumer.cjs")("x"), "renamesafe-dangerous:x");
});

// ---------------------------------------------------------------------------
// The authoritative target resolves exactly and is simply never called.
// ---------------------------------------------------------------------------
check("unreachvuln-lib: the public target exists and is not called", () => {
  const pkg = require(nm("unreachvuln-lib"));
  const impl = require(nm("unreachvuln-lib", "impl.js"));

  assert.equal(pkg.vulnerable, impl.dangerousImpl);

  let calls = 0;
  const original = impl.dangerousImpl;
  impl.dangerousImpl = function counted(input) {
    calls += 1;
    return original(input);
  };
  try {
    assert.equal(src("unreachvuln-consumer.cjs")("x"), "unreachvuln-safe:x");
  } finally {
    impl.dangerousImpl = original;
  }
  assert.equal(calls, 0);
});

// ---------------------------------------------------------------------------
// Duplicate public writes: last write wins, in both directions.
// ---------------------------------------------------------------------------
check("dupwrite-lib: the LAST public write wins (safe)", () => {
  const pkg = require(nm("dupwrite-lib"));
  const safe = require(nm("dupwrite-lib", "safe.js"));
  const dangerous = require(nm("dupwrite-lib", "dangerous.js"));

  assert.equal(pkg.vulnerable, safe.safeImpl);
  assert.notEqual(pkg.vulnerable, dangerous.dangerousImpl);
  assert.equal(pkg.vulnerable("x"), "dupwrite-safe:x");
});

check("dupreverse-lib: the LAST public write wins (dangerous)", () => {
  const pkg = require(nm("dupreverse-lib"));
  const safe = require(nm("dupreverse-lib", "safe.js"));
  const dangerous = require(nm("dupreverse-lib", "dangerous.js"));

  assert.equal(pkg.vulnerable, dangerous.dangerousImpl);
  assert.notEqual(pkg.vulnerable, safe.safeImpl);
  assert.equal(pkg.vulnerable("x"), "dupreverse-dangerous:x");
});

// ---------------------------------------------------------------------------
// Conditional / dynamic public exports.
// ---------------------------------------------------------------------------
check("condpublic-lib: the public export is condition-dependent", () => {
  // Under this process's environment the conditional write does not run at
  // all, which is precisely why the public identity is not statically
  // provable -- a different environment publishes a different value.
  const pkg = require(nm("condpublic-lib"));
  assert.equal(pkg.vulnerable, undefined);
  assert.equal(typeof require(nm("condpublic-lib", "other.js")).vulnerable, "function");
});

check("dynpublic-lib: the public export NAME is computed", () => {
  const pkg = require(nm("dynpublic-lib"));
  const impl = require(nm("dynpublic-lib", "impl.js"));
  // It happens to land on `vulnerable` with this environment, and on some
  // other name with another -- the name is not statically proven.
  assert.equal(pkg.vulnerable, impl.dangerousImpl);
  assert.notEqual(pkg.vulnerable, require(nm("dynpublic-lib", "other.js")).vulnerable);
});

// ---------------------------------------------------------------------------
// Package entry identity comes from package metadata, not from a filename.
// ---------------------------------------------------------------------------
check("mainfield-lib: the entry is lib/entry.js, not index.js", () => {
  const pkg = require(nm("mainfield-lib"));
  const impl = require(nm("mainfield-lib", "lib", "impl.js"));
  const decoy = require(nm("mainfield-lib", "index.js"));

  assert.equal(pkg.vulnerable, impl.realImpl);
  assert.notEqual(pkg.vulnerable, decoy.vulnerable);
  assert.equal(
    src("mainfield-consumer.cjs")("x"),
    "mainfield-real:x|mainfield-decoy:x",
  );
});

// ---------------------------------------------------------------------------
// Deep import: the public entry publishes no `vulnerable` at all.
// ---------------------------------------------------------------------------
check("deep-lib: the deep file's export is not the public surface", () => {
  const pkg = require(nm("deep-lib"));
  const deep = require(nm("deep-lib", "deep.js"));

  assert.equal(pkg.vulnerable, undefined);
  assert.equal(deep.vulnerable("x"), "deep-deep:x");
  assert.equal(src("deep-consumer.cjs")("x"), "deep-deep:x|deep-safe:x");
});

// ---------------------------------------------------------------------------
// Cross-package forwarding: the implementation is owned by another package.
// ---------------------------------------------------------------------------
check("crosspub-lib: the public value comes from outside-lib", () => {
  const pkg = require(nm("crosspub-lib"));
  const outside = require(nm("outside-lib"));

  assert.equal(pkg.vulnerable, outside.vulnerable);
  assert.notEqual(pkg.vulnerable, require(nm("crosspub-lib", "other.js")).vulnerable);
});

// ---------------------------------------------------------------------------
// PackageInstance twins: identical name and version, different publics.
// ---------------------------------------------------------------------------
check("twinpub-lib: the two installs publish different callables", () => {
  const top = require(nm("twinpub-lib"));
  const nested = require(nm("wrap-lib", "node_modules", "twinpub-lib"));

  const topPkgJson = require(nm("twinpub-lib", "package.json"));
  const nestedPkgJson = require(
    nm("wrap-lib", "node_modules", "twinpub-lib", "package.json"),
  );
  assert.equal(topPkgJson.name, nestedPkgJson.name);
  assert.equal(topPkgJson.version, nestedPkgJson.version);

  assert.notEqual(top.vulnerable, nested.vulnerable);
  assert.equal(top.vulnerable("x"), "twin-top-safe:x");
  assert.equal(nested.vulnerable("x"), "twin-nested-dangerous:x");
  assert.equal(
    src("twin-consumer.cjs")("x"),
    "twin-top-safe:x|twin-nested-dangerous:x",
  );
});

console.log(`authoritative-public-entry oracle: ${checks.length} checks OK`);
for (const name of checks) {
  console.log(`  ok ${name}`);
}
