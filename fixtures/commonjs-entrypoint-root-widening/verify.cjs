"use strict";
// Runtime ground truth for RWF-021, run with plain `node verify.cjs`.
//
// This fixture IS scanned by the test suite, but this file is not part of
// the scan -- it exists so the soundness claim can be checked against real
// Node semantics rather than argued. It asserts the one fact that makes
// every NOT_AFFECTED in this family false: with the flag unset, the abrupt
// construct never runs, the module really does publish its callable, and
// calling that callable really does reach the vulnerable sink.
const assert = require("node:assert");

assert.strictEqual(
  process.env.FIXTURE_FLAG,
  undefined,
  "run without FIXTURE_FLAG set",
);

const named = ["rwf016", "rwf017", "rwf018", "rwf019", "precise"];
for (const name of named) {
  const exported = require(`./src/${name}.cjs`);
  assert.strictEqual(typeof exported, "function", `${name}: exports a function`);
  assert.strictEqual(exported.name, "main", `${name}: the export IS main`);
  assert.strictEqual(
    exported("payload"),
    "danger:payload",
    `${name}: calling it reaches the vulnerable sink`,
  );
}

const property = require("./src/property.cjs");
assert.strictEqual(typeof property.run, "function", "property: exports run");
assert.strictEqual(
  property.run("payload"),
  "danger:payload",
  "property: calling run reaches the vulnerable sink",
);

const anonymous = require("./src/anonymous.cjs");
assert.strictEqual(typeof anonymous, "function", "anonymous: exports a function");
assert.strictEqual(anonymous.name, "", "anonymous: it really is anonymous");
assert.strictEqual(
  anonymous("payload"),
  "danger:payload",
  "anonymous: calling it reaches the vulnerable sink",
);

// The Family C control's own claim: nothing this entrypoint exposes ever
// reaches `neverCalled`, which is why NOT_AFFECTED stays correct there.
const unreachable = require("./src/unreachable.cjs");
assert.strictEqual(unreachable("payload"), "danger:payload");

console.log(
  "OK: every entrypoint publishes its callable and reaches the sink with FIXTURE_FLAG unset",
);

// And with the flag set, the abrupt construct aborts the load -- which is
// exactly why export attribution is ambiguous, and why root selection must
// widen rather than resolve it.
const { execFileSync } = require("node:child_process");
for (const name of named.slice(0, 4)) {
  let threw = false;
  try {
    execFileSync(process.execPath, ["-e", `require("./src/${name}.cjs")`], {
      cwd: __dirname,
      env: { ...process.env, FIXTURE_FLAG: "1" },
      stdio: "pipe",
    });
  } catch {
    threw = true;
  }
  assert.ok(threw, `${name}: FIXTURE_FLAG=1 aborts the load`);
}
console.log("OK: with FIXTURE_FLAG=1 each cutoff family aborts module load");
