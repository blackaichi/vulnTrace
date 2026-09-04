"use strict";
const danger = require("./danger");

function dangerousOp(input) {
  return danger.explode(input);
}

function bail() {
  throw new Error("a.js: bail() always throws");
}

// Publish the dangerous branch FIRST, while it is still `module.exports`...
console.log("[a.js] publishing dangerousOp as module.exports");
module.exports = dangerousOp;

// ...then pull in a circular dependency: b.js requires US BACK, and Node's
// circular-require semantics hand it whatever module.exports currently
// holds -- the dangerous branch, since we have not reached the final
// (safe) assignment yet.
console.log("[a.js] requiring ./b (circular back-reference to a.js)");
const b = require("./b");

// The RWF-017 shape: the resolvable, always-throwing local call is NOT a
// bare `bail();` expression statement -- it is the INITIALIZER of a
// variable declaration. JavaScript evaluates a declarator's initializer
// when the declaration executes, so reaching this statement necessarily
// invokes `bail()`; the declaration never completes, and `result` is
// never bound. Execution semantics, not statement shape, decide this.
console.log("[a.js] evaluating `const result = bail()` -- about to throw");
const result = bail();

// Never reached on this path.
console.log("[a.js] const result bound to:", result);
function safeOp(input) {
  return "safe:" + input;
}
console.log("[a.js] publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
