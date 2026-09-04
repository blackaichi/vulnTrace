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

// The RWF-018 shape: the resolvable, always-throwing local call is the
// initializer of a class STATIC FIELD. Evaluating a class definition runs
// its static elements -- static blocks and static field initializers alike
// -- in declaration order, as part of that evaluation. So merely reaching
// this class declaration invokes `bail()`. `staticSafe` below it never
// initializes, `C` is never bound, and nothing after the class runs.
console.log("[a.js] evaluating `class C { static x = bail(); }` -- about to throw");
class C {
  static before = "initialized before the throw";
  static x = bail();
  static after = "NEVER initialized";
}

// Never reached on this path.
console.log("[a.js] class C evaluated, C.x =", C.x);
function safeOp(input) {
  return "safe:" + input;
}
console.log("[a.js] publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
