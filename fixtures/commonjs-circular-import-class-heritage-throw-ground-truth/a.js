"use strict";
const danger = require("./danger");

function dangerousOp(input) {
  return danger.explode(input);
}

function bail() {
  throw new Error("a.js: bail() always throws");
}

function tag(name) {
  console.log("[a.js]   evaluated:", name);
  return name;
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

// The RWF-020 shape. The always-throwing local call is neither in a value
// position nor in a computed key: it is the class HERITAGE expression.
// `extends bail()` is evaluated by ClassDefinitionEvaluation BEFORE any
// class element is defined -- the superclass has to exist before the
// prototype chain can be built -- so merely reaching this class
// declaration invokes `bail()`. Neither the computed key below nor the
// static field below it is ever evaluated, `C` is never bound, and
// nothing after the class runs.
console.log("[a.js] evaluating `class C extends bail() {}` -- about to throw");
class C extends bail() {
  [tag("computed key -- NEVER evaluated")] = 1;
  static x = tag("static field -- NEVER evaluated");
}

// Never reached on this path.
console.log("[a.js] class C evaluated, C =", C);
function safeOp(input) {
  return "safe:" + input;
}
console.log("[a.js] publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
