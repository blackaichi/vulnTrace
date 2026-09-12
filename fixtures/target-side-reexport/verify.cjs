"use strict";
// Runtime ground truth for the P1-A1 target-side re-export matrix, run with
// plain `node verify.cjs` (and asserted by
// src/analysis/verdict.target-side-reexport.integration.test.ts, so it can
// never silently rot).
//
// This fixture IS scanned by the test suite; this file is not part of the
// scan. It exists so every expected verdict in the matrix rests on what
// Node really does rather than on what the analyzer says. VulnTrace itself
// never executes target code -- the runtime oracle is test-only.
//
// What it pins, per case: which installed instance is loaded, which
// forwarding files are loaded, which callable each package really
// publishes under the advisory-facing name "vulnerable", and -- for the
// reachable consumers -- that calling the published export really does
// enter the concrete implementation.
const assert = require("node:assert");
const Module = require("node:module");
const path = require("node:path");

/** Every file this process has loaded out of the fixture's node_modules. */
function loadedFixtureFiles() {
  return Object.keys(require.cache)
    .filter((f) => f.startsWith(path.join(__dirname, "node_modules")))
    .map((f) => path.relative(__dirname, f).split(path.sep).join("/"));
}

// ---------------------------------------------------------------- control
// A directly-exported target: no forwarding, nothing to chase.
{
  const lib = require("direct-lib");
  assert.strictEqual(typeof lib.vulnerable, "function", "direct: publishes");
  assert.strictEqual(lib.vulnerable("x"), "direct:x", "direct: reaches impl");
  assert.strictEqual(
    lib.vulnerable.name,
    "vulnerable",
    "direct: implementation-facing name equals the advisory-facing name",
  );
}

// ------------------------------------------------------- one hop (RWB-05)
// The exact qs@6.10.1 shape. The advisory-facing name is "vulnerable"; the
// implementation is an ANONYMOUS whole-module default in a sibling file,
// i.e. the canonical export name "default". The two names genuinely differ.
{
  const lib = require("onehop-lib");
  assert.strictEqual(typeof lib.vulnerable, "function", "onehop: publishes");
  assert.strictEqual(
    lib.vulnerable("x"),
    "onehop-vulnerable:x",
    "onehop: the published export IS the sibling file's implementation",
  );
  assert.strictEqual(
    lib.vulnerable,
    require("onehop-lib/impl.js"),
    "onehop: identity -- the published value IS impl.js's module.exports",
  );
  assert.strictEqual(
    lib.vulnerable.name,
    "",
    "onehop: the implementation is anonymous -- it has no name to be found by",
  );
  assert.strictEqual(
    lib.safe("x"),
    "onehop-safe:x",
    "onehop: the unrelated sibling export is a different callable",
  );
  assert.notStrictEqual(lib.vulnerable, lib.safe, "onehop: distinct exports");

  const loaded = loadedFixtureFiles();
  for (const f of [
    "node_modules/onehop-lib/index.js",
    "node_modules/onehop-lib/impl.js",
    "node_modules/onehop-lib/safe.js",
  ]) {
    assert.ok(loaded.includes(f), `onehop: ${f} is loaded`);
  }
}

// --------------------------------------------------------------- two hops
{
  const lib = require("twohop-lib");
  assert.strictEqual(
    lib.vulnerable("x"),
    "twohop-vulnerable:x",
    "twohop: two whole-module hops land on the real implementation",
  );
  assert.strictEqual(
    lib.vulnerable,
    require("twohop-lib/impl.js"),
    "twohop: identity -- the published value IS impl.js's module.exports",
  );
  assert.strictEqual(
    lib.vulnerable.name,
    "twoHopImplementation",
    "twohop: the implementation-facing name differs from the advisory's",
  );
  const loaded = loadedFixtureFiles();
  for (const f of [
    "node_modules/twohop-lib/index.js",
    "node_modules/twohop-lib/api.js",
    "node_modules/twohop-lib/impl.js",
  ]) {
    assert.ok(loaded.includes(f), `twohop: ${f} is loaded`);
  }
}

// ----------------------------------------------------------------- rename
{
  const lib = require("renamed-lib");
  const impl = require("renamed-lib/impl.js");
  assert.strictEqual(
    lib.vulnerable("x"),
    "renamed-vulnerable:x",
    "renamed: the published export is internalName's implementation",
  );
  assert.strictEqual(
    lib.vulnerable,
    impl.internalName,
    "renamed: identity -- advisory name 'vulnerable' IS impl's internalName",
  );
  assert.strictEqual(
    impl.unrelatedDecoy("x"),
    "renamed-decoy:x",
    "renamed: the same-named decoy is a genuinely different callable",
  );
  assert.strictEqual(
    impl.unrelatedDecoy.name,
    "vulnerable",
    "renamed: the decoy really is declared under the advisory's own name",
  );
  assert.notStrictEqual(
    lib.vulnerable,
    impl.unrelatedDecoy,
    "renamed: what the package publishes is NOT the same-named decoy",
  );
}

// ------------------------------------------------------------ local alias
{
  const lib = require("alias-lib");
  assert.strictEqual(
    lib.vulnerable("x"),
    "alias-vulnerable:x",
    "alias: a single-assignment local alias still publishes the impl",
  );
  assert.strictEqual(
    lib.vulnerable,
    require("alias-lib/impl.js").internalName,
    "alias: identity",
  );
}

// -------------------------------------------------------- reassigned alias
// The soundness control: the stale initializer is NOT what is published.
{
  const lib = require("reassigned-lib");
  const impl = require("reassigned-lib/impl.js");
  assert.strictEqual(
    lib.vulnerable("x"),
    "reassigned-harmless:x",
    "reassigned: the CURRENT value is published, not the stale initializer",
  );
  assert.strictEqual(lib.vulnerable, impl.harmless, "reassigned: identity");
  assert.notStrictEqual(
    lib.vulnerable,
    impl.dangerous,
    "reassigned: the stale `dangerous` binding is NOT published",
  );
}

// --------------------------------------------------- duplicate export write
{
  const lib = require("duplicate-lib");
  const impl = require("duplicate-lib/impl.js");
  assert.strictEqual(
    lib.vulnerable("x"),
    "duplicate-harmless:x",
    "duplicate: last write wins",
  );
  assert.strictEqual(lib.vulnerable, impl.harmless, "duplicate: identity");
  assert.notStrictEqual(
    lib.vulnerable,
    impl.dangerous,
    "duplicate: the stale FIRST write is NOT published",
  );
}

// ------------------------------------------------------------------ cycle
// A forwarding cycle terminates under Node too -- with nothing published.
{
  const lib = require("cycle-lib");
  assert.strictEqual(
    lib.vulnerable,
    undefined,
    "cycle: the package publishes NO `vulnerable` at all",
  );
}

// ----------------------------------------- package-root / cross-package
{
  const boundary = require("boundary-lib");
  const outside = require("outside-lib");
  assert.strictEqual(
    boundary.vulnerable,
    outside.vulnerable,
    "boundary: at runtime the value really does come from outside-lib -- " +
      "which is exactly why binding a boundary-lib ADVISORY to it would " +
      "re-interpret whose vulnerability this is",
  );
  const crosspkg = require("crosspkg-lib");
  assert.strictEqual(
    crosspkg.vulnerable,
    outside.vulnerable,
    "crosspkg: same, through a bare specifier",
  );
}

// ------------------------------------------------------------------- twin
// Two installs, same name AND same version, different paths, different
// implementations. Node reaches the NESTED one from wrapper-lib.
{
  const topLevel = require("twin-lib");
  const wrapper = require("wrapper-lib");
  assert.strictEqual(
    topLevel.vulnerable("x"),
    "twin-top-level:x",
    "twin: the top-level instance has its own implementation",
  );
  assert.strictEqual(
    wrapper.run("x"),
    "twin-nested:x",
    "twin: wrapper-lib reaches the NESTED instance, not the top-level one",
  );
  const topPkg = require("twin-lib/package.json");
  const nestedPkg = require("wrapper-lib/node_modules/twin-lib/package.json");
  assert.strictEqual(topPkg.name, nestedPkg.name, "twin: same name");
  assert.strictEqual(
    topPkg.version,
    nestedPkg.version,
    "twin: same version -- name+version cannot tell these instances apart",
  );
  assert.notStrictEqual(
    topLevel.vulnerable,
    require("wrapper-lib/node_modules/twin-lib").vulnerable,
    "twin: the two instances publish genuinely different callables",
  );
}

// ------------------------------------- same implementation, two names
// The FALSE-NOT_AFFECTED probe: an advisory naming one of these names
// describes the very callable the other name reaches.
{
  const lib = require("twoname-lib");
  const impl = require("twoname-lib/impl.js");
  assert.strictEqual(
    lib.vulnerable,
    impl,
    "twoname: `vulnerable` IS the sibling implementation",
  );
  assert.strictEqual(
    lib.alsoVulnerable,
    impl,
    "twoname: `alsoVulnerable` is the SAME callable, by identity",
  );
  assert.strictEqual(
    lib.alsoVulnerable("x"),
    "twoname-vulnerable:x",
    "twoname: calling the other name really does execute the advisory's target",
  );
}

// ------------------------------------------------ literal-bracket export
{
  const lib = require("bracket-lib");
  assert.strictEqual(
    lib.vulnerable,
    require("bracket-lib/impl.js").internalName,
    "bracket: the literal-bracket export publishes impl's internalName",
  );
  assert.strictEqual(
    lib.vulnerable("x"),
    "bracket-vulnerable:x",
    "bracket: reaches the implementation",
  );
}

// -------------------------------------------------- reachable consumers
// Each reachable entrypoint really does reach its concrete implementation.
{
  const cases = [
    ["direct-reachable", "direct:x"],
    ["onehop-reachable", "onehop-vulnerable:x"],
    ["twohop-reachable", "twohop-vulnerable:x"],
    ["renamed-reachable", "renamed-vulnerable:x"],
    ["alias-reachable", "alias-vulnerable:x"],
    ["reassigned-reachable", "reassigned-harmless:x"],
    ["duplicate-reachable", "duplicate-harmless:x"],
    ["twin-nested-consumer", "twin-nested:x"],
    ["twoname-other-name", "twoname-vulnerable:x"],
    ["bracket-reachable", "bracket-vulnerable:x"],
  ];
  for (const [name, expected] of cases) {
    const main = require(`./src/${name}.cjs`);
    assert.strictEqual(typeof main, "function", `${name}: publishes main`);
    assert.strictEqual(main("x"), expected, `${name}: reaches the sink`);
  }
}

// The unreachable consumer really does NOT enter the vulnerable impl.
{
  const main = require("./src/onehop-unreachable.cjs");
  assert.strictEqual(
    main("x"),
    "onehop-safe:x",
    "onehop-unreachable: calls only the unrelated sibling export",
  );
}

assert.ok(Module, "node:module is available");
console.log("target-side-reexport: runtime ground truth OK");
