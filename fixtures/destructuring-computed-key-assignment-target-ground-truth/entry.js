"use strict";

// RWF-025 runtime ground truth. Run directly: `node entry.js`.
// Every claim is ASSERTED; the process exits non-zero if any is false.
const assert = require("node:assert");

// ---------------------------------------------------------------------------
// Part 1 -- which local bindings an assignment TARGET rebinds. Loading this
// module runs its own assertions.
// ---------------------------------------------------------------------------
const { rows } = require("./roles");
assert.strictEqual(rows.length, 7);

// ---------------------------------------------------------------------------
// Part 2 -- the poisoning module, observed through a circular `require()`.
// ---------------------------------------------------------------------------
const danger = require("./danger");

let libThrew = null;
try {
  require("./lib");
} catch (e) {
  libThrew = e.message;
}

// The RWF-024 cutoff really does end module evaluation: `module.exports =
// safeOp`, the last statement in lib.js, never runs on this load.
assert.strictEqual(libThrew, "fast mode is not supported here");

// The unrelated destructuring statement above it was NOT what threw -- it
// completed, which is the whole point: it is ordinary, harmless syntax.
const observer = require("./observer");

// The cyclic consumer captured the DANGEROUS export by identity, before the
// throw. This is the value a real consumer holds, and it is the reason
// NOT_AFFECTED is unsound for this file.
assert.strictEqual(typeof observer.captured, "function");
assert.strictEqual(observer.captured.name, "dangerousOp");

// And it genuinely reaches the sink when called.
assert.strictEqual(danger.reachedCount(), 0);
assert.strictEqual(observer.captured("payload"), "danger:payload");
assert.strictEqual(danger.reachedCount(), 1);

// Re-requiring the failed module re-throws deterministically: Node does not
// cache a module whose evaluation threw.
let second = null;
try {
  require("./lib");
} catch (e) {
  second = e.message;
}
assert.strictEqual(second, "fast mode is not supported here");

console.log("RWF-025 ground truth: all assertions passed");
