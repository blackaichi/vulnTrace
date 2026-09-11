"use strict";
// RWF-028's canonical C07 module: the invocation that ends module
// evaluation is a ONE-HOP CONST ALIAS, not a direct call.
//
//     const alias = bail;
//     alias();
//
// Every ingredient RWF-016 needs is already present and already proven --
// `bail` is a local, never-reassigned function declaration whose body
// throws on every path. The ONLY thing RWF-016 could not do is say which
// function `alias()` enters, and on that alone it kept the later export's
// authority and answered NOT_AFFECTED with a complete Family C proof.
const danger = require("./danger");
const { record } = require("./trace");

// The branch that reaches the vulnerable sink. Nothing in this file calls
// it: the ONLY way it ever runs is by being the module's exported value.
function dangerousOp(input) {
  return danger.explode(input);
}

function bail() {
  record("bail(): entered, about to throw");
  throw new Error("boom");
}

// The one-hop alias. `alias` and `bail` are the SAME function object.
const alias = bail;

// Publish the dangerous branch FIRST, while it is still `module.exports`...
record("a.js: publishing dangerousOp as module.exports");
module.exports = dangerousOp;

// ...then pull in a circular dependency: b.js requires US BACK, and Node
// hands it whatever module.exports currently holds -- the dangerous branch.
record("a.js: requiring ./b (circular back-reference to a.js)");
const b = require("./b");
void b;

record("a.js: calling alias()");
alias();

// Never reached.
record("a.js: after alias() (UNREACHABLE)");
function safeOp(input) {
  return "safe:" + input;
}
record("a.js: publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
