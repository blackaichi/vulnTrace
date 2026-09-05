"use strict";
const danger = require("./danger");

function dangerousOp(input) {
  return danger.explode(input);
}

function bail() {
  throw new Error("a.js: bail() always throws");
}

function tag(name) {
  console.log("[a.js]   computed key evaluated:", name);
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

// The RWF-019 shape. The always-throwing local call is in NO value
// position at all: it is a class element's COMPUTED KEY, and the element
// carries NO `static` modifier. A computed property name is evaluated by
// ClassDefinitionEvaluation as each element is defined -- the key has to
// exist before the element can be installed -- so merely reaching this
// class declaration invokes `bail()`. The third key is never evaluated,
// `C` is never bound, and nothing after the class runs.
console.log("[a.js] evaluating `class C { [bail()] = 1; }` -- about to throw");
class C {
  [tag("before")] = "evaluated before the throw";
  [bail()] = 1;
  [tag("after")] = "NEVER evaluated";
}

// Never reached on this path.
console.log("[a.js] class C evaluated, C =", C);
function safeOp(input) {
  return "safe:" + input;
}
console.log("[a.js] publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
