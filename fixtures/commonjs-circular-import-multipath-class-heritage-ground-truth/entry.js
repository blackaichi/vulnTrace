"use strict";
// RWF-027 runtime ground truth. Every claim below is ASSERTED, not merely
// printed: `node entry.js` exits 0 only if real Node behaves exactly the way
// VulnTrace's multi-path class-definition model says it does.
//
// The load-bearing difference from the RWF-020 and RWF-022 ground truths:
// proving ONE flag value fatal proves nothing here. RWF-027's claim is about
// the path SET, so both endings of the SAME factory are measured
// independently, each in its own real circular-require module graph.
const assert = require("node:assert/strict");
const danger = require("./danger");
const trace = require("./trace");

console.log("=== PATH 1: FLAG truthy -- the factory THROWS ===");
let truthyError;
let truthyExports;
try {
  truthyExports = require("./a");
} catch (err) {
  truthyError = err;
}
const truthyEvents = trace.seen();
const b = require("./b");

assert.ok(
  truthyEvents.includes("a.js: publishing dangerousOp as module.exports"),
  "a.js must have published dangerousOp first",
);
assert.equal(
  b.retained.name,
  "dangerousOp",
  "b.js must have retained dangerousOp itself, by identity",
);
assert.ok(
  truthyEvents.includes("maybe(): taking the THROW path"),
  "the truthy flag must take the throw path",
);
assert.ok(truthyError, "require('./a') must have thrown");
assert.equal(truthyError.constructor.name, "Error");
assert.equal(truthyError.message, "boom");
assert.ok(
  !truthyEvents.includes("a.js: publishing safeOp (UNREACHABLE on this path)"),
  "module.exports = safeOp must be unreachable on the throwing path",
);
assert.equal(truthyExports, undefined);
console.log(
  "ok: the heritage expression completed ABRUPTLY (Error: boom) before",
);
console.log("    ClassDefinitionEvaluation was entered; safeOp never ran.");

console.log("\n=== PATH 2: FLAG falsy -- the factory RETURNS 1, NORMALLY ===");
let falsyError;
let falsyExports;
try {
  falsyExports = require("./a-falsy");
} catch (err) {
  falsyError = err;
}
const falsyEvents = trace.seen();
const bFalsy = require("./b-falsy");

assert.equal(
  bFalsy.retained.name,
  "dangerousOp",
  "the circular importer must have retained dangerousOp on this path too",
);
assert.ok(
  falsyEvents.includes("maybe(): taking the RETURN 1 path"),
  "the falsy flag must take the RETURN path",
);
assert.ok(falsyError, "require('./a-falsy') must have thrown");
assert.equal(falsyError.constructor.name, "TypeError");
assert.match(falsyError.message, /^Class extends value 1\b/);
assert.match(falsyError.message, /is not a constructor or null/);
assert.ok(
  !falsyEvents.includes(
    "a-falsy.js: publishing safeOp (UNREACHABLE on this path)",
  ),
  "module.exports = safeOp must be unreachable on the returning path either",
);
assert.equal(falsyExports, undefined);
console.log("ok:", falsyError.message);
console.log(
  "    -- the CALL completed normally; the CLASS DEFINITION is what failed.",
);

console.log("\n=== 3. the distinction RWF-027 rests on ===");
// The same factory, called in isolation, OUTSIDE any heritage position.
function maybe(flag) {
  if (flag) {
    throw new Error("boom");
  }
  return 1;
}
assert.throws(() => maybe(true), /boom/);
assert.equal(
  maybe(false),
  1,
  "the call itself completes NORMALLY on the falsy path",
);
console.log("ok: `maybe(false)` returns 1 and does NOT throw.");
console.log(
  "    So `maybe(FLAG);` as a plain statement is NOT definitely abrupt,",
);
console.log(
  "    and VulnTrace must not treat it as such. What is proven is only that",
);
console.log(
  "    evaluating THIS CLASS HERITAGE cannot complete a class definition.",
);

console.log("\n=== 4. every ending, on BOTH paths, prevented the safe export ===");
assert.ok(truthyError && falsyError, "both flag values must abort the load");
console.log("ok: neither flag value ever published safeOp.");

console.log("\n=== 5. the retained dangerous export reaches the SINK ===");
const before = danger.sinkCallCount();
const result = b.retained("payload-from-entrypoint");
assert.equal(danger.sinkCallCount(), before + 1, "the sink must have run");
assert.equal(result, "EXPLODED:payload-from-entrypoint");
console.log("ok: vulnerable sink executed, result:", result);

console.log("\n=== 6. re-require is COHERENT on both paths ===");
for (const [spec, kind] of [
  ["./a", "Error"],
  ["./a-falsy", "TypeError"],
]) {
  let second;
  try {
    require(spec);
  } catch (err) {
    second = err;
  }
  assert.ok(second, `a failed load of ${spec} is retried and re-throws`);
  assert.equal(second.constructor.name, kind);
  console.log(`ok: require('${spec}') re-threw ${kind}: ${second.message}`);
}

console.log(
  "\n=== negative control: one surviving good path keeps the later export ===",
);
const c = require("./c");
assert.equal(c.name, "safeOp", "c.js must complete and publish safeOp");
for (const [name, klass] of Object.entries(c.classes)) {
  assert.equal(klass.name, name, `${name} must have been DEFINED`);
}
assert.equal(
  Object.getPrototypeOf(c.classes.ExtendsInvalidOrNull.prototype),
  null,
  "`extends null` really does terminate the prototype chain",
);
console.log(
  "ok: c.js exported safeOp, and all five multi-path classes were defined:",
);
console.log("   ", Object.keys(c.classes).join(", "));
console.log(
  "    Withdrawing authority for ANY of these would be an RWF-027 overreach.",
);

console.log("\n=== the full outcome matrix, measured ===");
const mismatches = require("./forms").report();
assert.equal(mismatches, 0, "every measured row must match its expectation");
console.log("ok: all rows matched");

console.log("\nALL RWF-027 GROUND-TRUTH ASSERTIONS PASSED");
