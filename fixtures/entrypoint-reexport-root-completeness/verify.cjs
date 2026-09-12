"use strict";
// Runtime ground truth for the P0-Z entrypoint re-export remediation, run
// with plain `node verify.cjs`.
//
// This fixture IS scanned by the test suite, but this file is not part of
// the scan -- it exists so the soundness claim can be checked against real
// Node semantics rather than argued. It asserts the one fact that makes
// every NOT_AFFECTED in this family false: each re-exporting entrypoint
// really does publish a callable, and calling that callable really does
// reach the vulnerable sink.
const assert = require("node:assert");

// The five CommonJS blocker forms, plus the two-hop chain. Each publishes
// `run`, which reaches `dangerousOp`.
const forwarding = [
  "whole-module",
  "object-assign",
  "property",
  "chained",
];
for (const name of forwarding) {
  const exported = require(`./src/${name}.cjs`);
  assert.strictEqual(
    typeof exported.run,
    "function",
    `${name}: publishes run`,
  );
  assert.strictEqual(
    exported.run("payload"),
    "danger:payload",
    `${name}: calling the published callable reaches the vulnerable sink`,
  );
}

// The package re-export hands out the vulnerable export itself.
const pkg = require("./src/package-reexport.cjs");
assert.strictEqual(
  typeof pkg.dangerousOp,
  "function",
  "package-reexport: publishes dangerousOp",
);
assert.strictEqual(
  pkg.dangerousOp("payload"),
  "danger:payload",
  "package-reexport: the published sink really is the vulnerable one",
);

// The dynamic computed export: a LOCAL callable published under a name
// only the runtime knows. It is genuinely callable and genuinely reaches
// the sink, which is why zero derived roots must not read as "complete".
const computed = require("./src/computed-key.cjs");
assert.strictEqual(
  typeof computed.run,
  "function",
  "computed-key: publishes run under its runtime name",
);
assert.strictEqual(
  computed.run("payload"),
  "danger:payload",
  "computed-key: calling the published callable reaches the vulnerable sink",
);

// The literal-bracket family found by the focused re-audit. Each publishes
// `run` under a statically exact key and reaches the vulnerable sink, so
// none of them may be certified absent.
for (const name of ["literal-bracket", "bracket-reexport", "dynamic-bracket"]) {
  const exported = require(`./src/${name}.cjs`);
  assert.strictEqual(
    typeof exported.run,
    "function",
    `${name}: publishes run`,
  );
  assert.strictEqual(
    exported.run("payload"),
    "danger:payload",
    `${name}: calling the published callable reaches the vulnerable sink`,
  );
}

// The direct-export control: same reachable sink, root derivable locally.
const direct = require("./src/direct.cjs");
assert.strictEqual(
  direct.run("payload"),
  "danger:payload",
  "direct: calling the published callable reaches the vulnerable sink",
);

// The Family C control's own claim: this entrypoint reaches `dangerousOp`
// but never `neverCalled`, which is why NOT_AFFECTED stays correct there
// for a rule naming `neverCalled`.
const validFamilyC = require("./src/valid-family-c.cjs");
assert.strictEqual(validFamilyC.run("payload"), "danger:payload");

// The no-export control genuinely publishes no callable.
assert.strictEqual(
  typeof require("./src/no-callable-export.cjs"),
  "number",
  "no-callable-export: publishes no callable at all",
);

// The read-only control publishes a callable and mutates nothing.
assert.strictEqual(
  require("./src/export-read-only.cjs").run("payload"),
  "danger:payload",
  "export-read-only: publishes a working callable",
);

console.log(
  "OK: every re-exporting entrypoint publishes a callable that reaches the vulnerable sink",
);

// The ESM forms, checked in the same process via dynamic import.
(async () => {
  for (const name of ["named-reexport", "export-star"]) {
    const mod = await import(`./src/${name}.mjs`);
    assert.strictEqual(typeof mod.run, "function", `${name}: publishes run`);
    assert.strictEqual(
      mod.run("payload"),
      "danger:payload",
      `${name}: calling the re-exported callable reaches the vulnerable sink`,
    );
  }
  console.log(
    "OK: both ESM re-export forms publish a callable that reaches the vulnerable sink",
  );
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
