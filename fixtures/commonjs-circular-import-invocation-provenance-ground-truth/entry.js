"use strict";
// RWF-028 runtime ground truth. Every claim below is ASSERTED, not merely
// printed: `node entry.js` exits 0 only if real Node behaves exactly the
// way VulnTrace's invocation/provenance model says it does.
//
// The load-bearing difference from the RWF-016 ground truth: the call that
// ends module evaluation here is NOT a bare `bail()`. It is a one-hop
// const alias, and the whole question RWF-028 answers is whether an
// analyzer may say which function such an invocation enters.
const assert = require("node:assert/strict");
const danger = require("./danger");
const trace = require("./trace");

console.log("=== 1. the aliased call ends module evaluation ===");
let loadError;
let exportsValue;
try {
  exportsValue = require("./a");
} catch (err) {
  loadError = err;
}
const events = trace.seen();
const b = require("./b");

assert.ok(
  events.includes("a.js: publishing dangerousOp as module.exports"),
  "a.js must have published dangerousOp first",
);
assert.equal(
  b.retained.name,
  "dangerousOp",
  "b.js must have retained dangerousOp itself, by identity",
);
assert.ok(events.includes("a.js: calling alias()"), "alias() must have been reached");
assert.ok(
  events.includes("bail(): entered, about to throw"),
  "alias() must have entered bail's OWN body -- this is the identity claim",
);
assert.ok(loadError, "require('./a') must have thrown");
assert.equal(loadError.constructor.name, "Error");
assert.equal(loadError.message, "boom");
assert.ok(
  !events.includes("a.js: after alias() (UNREACHABLE)"),
  "nothing after alias() may run",
);
assert.ok(
  !events.includes("a.js: publishing safeOp (UNREACHABLE on this path)"),
  "module.exports = safeOp must be unreachable",
);
assert.equal(exportsValue, undefined);
console.log("ok: alias() entered bail's body and threw; safeOp never ran.");

console.log("\n=== 2. the alias and its source are the SAME function ===");
// The identity claim, stated directly rather than inferred from the abort.
function throwing() {
  throw new Error("boom");
}
const alias = throwing;
assert.equal(alias, throwing, "a one-hop const alias IS the source function");
assert.throws(() => alias(), /boom/);
console.log("ok: `const alias = f` binds the same function object as `f`.");

console.log("\n=== 3. the retained dangerous export reaches the SINK ===");
const before = danger.sinkCallCount();
const result = b.retained("payload-from-entrypoint");
assert.equal(danger.sinkCallCount(), before + 1, "the sink must have run");
assert.equal(result, "EXPLODED:payload-from-entrypoint");
console.log("ok: vulnerable sink executed, result:", result);

console.log("\n=== 4. re-require is COHERENT ===");
let second;
try {
  require("./a");
} catch (err) {
  second = err;
}
assert.ok(second, "a failed load is retried and re-throws");
assert.equal(second.constructor.name, "Error");
console.log("ok: require('./a') re-threw", second.constructor.name + ":", second.message);

console.log("\n=== 5. the boundary cases this rule must NOT cross ===");
// Calling an async function does not throw synchronously.
async function asyncBail() {
  throw new Error("boom");
}
let syncThrew = false;
let promise;
try {
  promise = asyncBail();
} catch {
  syncThrew = true;
}
assert.equal(syncThrew, false, "calling an async function must not throw synchronously");
assert.ok(promise instanceof Promise);
promise.catch(() => {});
console.log("ok: an async callee returns a REJECTED PROMISE, not a synchronous throw.");

// Calling a generator function does not run its body at all.
let generatorBodyRan = false;
function* genBail() {
  generatorBodyRan = true;
  throw new Error("boom");
}
const iterator = genBail();
assert.equal(generatorBodyRan, false, "a generator body must not run on call");
assert.equal(typeof iterator.next, "function");
console.log("ok: a generator callee's body does not start until iteration.");

// `new` on a non-constructable callable throws BEFORE the body runs.
let arrowBodyRan = false;
const arrowBail = () => {
  arrowBodyRan = true;
  throw new Error("boom");
};
assert.throws(() => new arrowBail(), TypeError);
assert.equal(
  arrowBodyRan,
  false,
  "an arrow's body must NOT run -- `new` fails on constructability first",
);
assert.throws(() => new asyncBail(), TypeError);
assert.throws(() => new genBail(), TypeError);
console.log(
  "ok: `new` on an arrow/async/generator throws TypeError WITHOUT entering the body.",
);
console.log(
  "    Module evaluation still ends -- but for a reason RWF-028 does not claim.",
);

// Duplicate object keys: the LAST one wins, both ways round.
const safeLast = { bail: throwing, ["bail"]: () => "safe" };
assert.equal(safeLast.bail(), "safe", "the last duplicate key must win");
const throwLast = { bail: () => "safe", ["bail"]: throwing };
assert.throws(() => throwLast.bail(), /boom/);
console.log("ok: duplicate object keys resolve in SOURCE ORDER, last write winning.");

console.log("\n=== the full outcome matrix, measured ===");
const mismatches = require("./forms").report();
assert.equal(mismatches, 0, "every measured row must match its expectation");
console.log("ok: all rows matched");

console.log("\nALL RWF-028 GROUND-TRUTH ASSERTIONS PASSED");
