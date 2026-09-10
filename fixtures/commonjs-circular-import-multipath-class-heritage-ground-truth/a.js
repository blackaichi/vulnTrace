"use strict";
// RWF-027's canonical B01 module. The heritage factory here is neither
// RWF-020's shape nor RWF-022's:
//
//   * it is NOT always-throwing, so `cannotCompleteNormally` declines;
//   * it has NO single unconditional return, so `classifyExactCallReturnValue`
//     declines.
//
// It has TWO endings, and they fail the class definition for two DIFFERENT
// reasons -- which is exactly why no single existing rule can see it.
const danger = require("./danger");
const { record } = require("./trace");

function dangerousOp(input) {
  return danger.explode(input);
}

// The RWF-027 factory. FLAG is truthy in this file's run, so the `throw`
// path is the one measured here; entry.js re-runs the SAME source with a
// falsy flag to measure the other ending.
function maybe(flag) {
  record("maybe() body entered, flag=" + String(flag));
  if (flag) {
    record("maybe(): taking the THROW path");
    throw new Error("boom");
  }
  record("maybe(): taking the RETURN 1 path");
  return 1;
}

const FLAG = true;

// Publish the dangerous branch FIRST, while it is still `module.exports`...
record("a.js: publishing dangerousOp as module.exports");
module.exports = dangerousOp;

// ...then pull in a circular dependency: b.js requires US BACK, and Node
// hands it whatever module.exports currently holds -- the dangerous branch.
record("a.js: requiring ./b (circular back-reference to a.js)");
const b = require("./b");

record("a.js: evaluating `class C extends maybe(FLAG)`");
class C extends maybe(FLAG) {}

// Never reached on this path.
record("a.js: class C evaluated (UNREACHABLE) C=" + String(C));
function safeOp(input) {
  return "safe:" + input;
}
record("a.js: publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
