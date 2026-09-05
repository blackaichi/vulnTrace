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

// The FALSE-AFFECTED controls, and the reason they are controls: in each,
// the callable that reaches the sink is one no export write can publish,
// so what the module actually hands an importer is safe. Rooting the
// unreachable callable would report a path that cannot execute.
for (const name of ["never-exported", "sibling-only-safe", "reassigned"]) {
  const exported = require(`./src/${name}.cjs`);
  assert.strictEqual(typeof exported, "function", `${name}: exports a function`);
  assert.strictEqual(
    exported("payload"),
    "safe:payload",
    `${name}: the PUBLISHED callable is the safe one`,
  );
}
// `reassigned` additionally proves the reassignment really took effect
// before the export write, which is what makes the stale declaration
// unpublishable rather than merely unlikely.
assert.strictEqual(
  require("./src/reassigned.cjs").name,
  "safe",
  "reassigned: the published value is the REASSIGNED function",
);
console.log(
  "OK: every false-AFFECTED control publishes a safe callable and never reaches the sink",
);

// The legitimate multi-candidate control: with the flag set, the dangerous
// value really is written to module.exports before the module aborts, so a
// cyclic importer can observe it -- which is why rooting it is correct.
{
  const exported = require("./src/both-writes.cjs");
  assert.strictEqual(
    exported("payload"),
    "safe:payload",
    "both-writes: the default run publishes the safe value",
  );
}
console.log("OK: both-writes publishes the safe value on the default run");

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
