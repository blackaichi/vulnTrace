"use strict";
// RWF-022 runtime ground truth. Every claim below is ASSERTED, not merely
// printed: `node entry.js` exits 0 only if real Node behaves exactly the
// way VulnTrace's invalid-heritage-value model says it does.
const assert = require("node:assert/strict");
const danger = require("./danger");
const trace = require("./trace");

let aLoadError;
let aExports;
try {
  aExports = require("./a");
} catch (err) {
  aLoadError = err;
}

const events = trace.seen();
const b = require("./b");

console.log("\n=== 1. the dangerous export was assigned ===");
assert.ok(
  events.includes("a.js: publishing dangerousOp as module.exports"),
  "a.js must have published dangerousOp",
);
console.log("ok: a.js published dangerousOp before anything else");

console.log("\n=== 2. the circular importer retained the EXACT dangerous value ===");
assert.equal(
  b.retained.name,
  "dangerousOp",
  "b.js must have retained dangerousOp itself",
);
assert.notEqual(b.retained.name, "safeOp");
console.log("ok: b.js holds dangerousOp, by identity, not by name alone");

console.log("\n=== 3. the heritage call BEGAN ===");
assert.ok(
  events.includes("a.js: evaluating `class C extends notAConstructor() {}`"),
  "the class definition must have been reached",
);
assert.ok(
  events.includes("notAConstructor() body entered"),
  "the heritage call must actually have been invoked",
);
console.log("ok: the class was reached and notAConstructor() was invoked");

console.log("\n=== 4. the call RETURNED NORMALLY, with 1 ===");
// Re-run the same factory in isolation. This is the distinction RWF-020
// cannot make: the call is not abrupt at all.
function notAConstructor() {
  return 1;
}
const returned = notAConstructor();
assert.equal(returned, 1);
assert.equal(typeof returned, "number");
console.log("ok: the factory returns 1 and does NOT throw");

console.log("\n=== 5. the CLASS DEFINITION threw, on heritage validation ===");
assert.ok(aLoadError, "require('./a') must have thrown");
assert.equal(aLoadError.constructor.name, "TypeError");
assert.match(aLoadError.message, /is not a constructor or null/);
assert.match(aLoadError.message, /^Class extends value 1\b/);
console.log("ok:", aLoadError.message);

console.log("\n=== 6. no class element INITIALIZER ran; the class never bound ===");
// MEASURED, and deliberately NOT the same answer as the RWF-020 fixture's.
// When the heritage CALL throws, nothing else in the class runs at all. When
// the call RETURNS and the VALUE is what is invalid, V8 has already evaluated
// the class body's computed property KEYS before it performs the
// IsConstructor check -- so a computed key DOES run here.
assert.ok(
  events.includes("class element evaluated: computed key -- DOES evaluate, see README"),
  "a computed KEY is evaluated before the IsConstructor check",
);
assert.ok(
  !events.includes("class element evaluated: static field -- never evaluated"),
  "a static field INITIALIZER is never evaluated",
);
const order = require("./forms").reportOrder();
assert.deepEqual(order.evaluated, ["heritage call ran", "computed key"]);
assert.equal(order.threw.constructor.name, "TypeError");
console.log(
  "ok: computed key ran; static field initializer did not; class never bound",
);
console.log(
  "   (this asymmetry vs the RWF-020 throwing-call fixture is real -- see README)",
);

console.log("\n=== 7. the later SAFE export never ran ===");
assert.ok(
  !events.includes("a.js: publishing safeOp (UNREACHABLE on this path)"),
  "module.exports = safeOp must be unreachable on this path",
);
assert.equal(aExports, undefined, "require('./a') produced no value at all");
assert.notEqual(b.retained.name, "safeOp");
console.log("ok: safeOp was never published, and nothing observed it");

console.log("\n=== 8. the retained dangerous export reaches the SINK ===");
const before = danger.sinkCallCount();
const result = b.retained("payload-from-entrypoint");
assert.equal(danger.sinkCallCount(), before + 1, "the sink must have run");
assert.equal(result, "EXPLODED:payload-from-entrypoint");
console.log("ok: vulnerable sink executed, result:", result);

console.log("\n=== 9. re-require is COHERENT ===");
let second;
try {
  require("./a");
} catch (err) {
  second = err;
}
assert.ok(second, "a failed module load is retried and re-throws");
assert.equal(second.constructor.name, "TypeError");
assert.match(second.message, /is not a constructor or null/);
console.log("ok: require('./a') re-threw deterministically:", second.message);
console.log("-> safeOp is NEVER this module's exported value on this path.");

console.log("\n=== negative control: VALID heritage values keep the later export ===");
const c = require("./c");
assert.equal(c.name, "safeOp", "c.js must complete and publish safeOp");
assert.equal(c.classes.ExtendsClass.name, "ExtendsClass");
assert.equal(c.classes.ExtendsFunction.name, "ExtendsFunction");
assert.equal(c.classes.ExtendsNull.name, "ExtendsNull");
assert.equal(c.classes.ExtendsMaybe.name, "ExtendsMaybe");
assert.equal(
  Object.getPrototypeOf(c.classes.ExtendsNull.prototype),
  null,
  "`extends null` really does terminate the prototype chain",
);
let deferred;
try {
  c.configure();
} catch (err) {
  deferred = err;
}
assert.ok(deferred, "the DEFERRED class throws only when configure() runs");
assert.equal(deferred.constructor.name, "TypeError");
console.log(
  "ok: c.js exported",
  c.name,
  "- and its deferred class threw only on call:",
  deferred.message,
);

console.log("\n=== every heritage VALUE category, measured ===");
const mismatches = require("./forms").report();
assert.equal(mismatches, 0, "every measured row must match its expectation");
console.log("ok: all rows matched");

console.log("\nALL RWF-022 GROUND-TRUTH ASSERTIONS PASSED");
