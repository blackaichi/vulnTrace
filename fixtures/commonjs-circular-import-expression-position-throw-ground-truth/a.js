"use strict";
const danger = require("./danger");

function dangerousOp(input) {
  return danger.explode(input);
}

function bail() {
  throw new Error("a.js: bail() always throws");
}

function before() {
  console.log("[a.js]   before() evaluated");
  return "before";
}

function after() {
  console.log("[a.js]   after() evaluated -- MUST NEVER APPEAR");
  return "after";
}

function sink(a, b, c) {
  console.log("[a.js]   sink() entered -- MUST NEVER APPEAR");
  return [a, b, c];
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

// The RWF-026 shape. The always-throwing local call is neither a bare
// statement nor a declarator's whole initializer: it is a call ARGUMENT.
// ECMAScript evaluates every argument, left to right, BEFORE the callee is
// entered -- so `sink` is never called at all, `before()` runs, `after()`
// does not, and nothing after this statement runs either.
console.log("[a.js] evaluating `sink(before(), bail(), after())` -- about to throw");
sink(before(), bail(), after());

// Never reached on this path.
console.log("[a.js] call completed (UNREACHABLE on this path)");
function safeOp(input) {
  return "safe:" + input;
}
console.log("[a.js] publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
