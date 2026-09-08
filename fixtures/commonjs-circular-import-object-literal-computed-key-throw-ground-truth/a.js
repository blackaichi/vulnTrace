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

// The RWF-024 shape. The always-throwing local call is an OBJECT LITERAL's
// COMPUTED KEY, not a class element at all. For every property in an
// ObjectLiteral's PropertyDefinitionList, in source order, the computed key
// expression is evaluated and converted to a property key BEFORE that
// property's value is defined on the new object -- so merely evaluating
// this object literal invokes `bail()`. The third key is never evaluated,
// the object literal never finishes constructing, and nothing after it
// runs.
console.log(
  "[a.js] evaluating `const o = { [bail()]: 1 }` -- about to throw",
);
const o = {
  [tag("before")]: "evaluated before the throw",
  [bail()]: 1,
  [tag("after")]: "NEVER evaluated",
};

// Never reached on this path.
console.log("[a.js] object literal evaluated, o =", o);
function safeOp(input) {
  return "safe:" + input;
}
console.log("[a.js] publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
