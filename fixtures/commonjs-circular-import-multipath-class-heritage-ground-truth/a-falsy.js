"use strict";
// The SAME module as a.js, with the SAME factory, run with a FALSY flag --
// so the OTHER ending is the one measured. This file exists because
// RWF-027's whole claim is about the path SET: proving one flag value fatal
// proves nothing, and "a TypeError happened" is not the assertion. Both
// endings must independently abort the class definition.
const danger = require("./danger");
const { record } = require("./trace");

function dangerousOp(input) {
  return danger.explode(input);
}

function maybe(flag) {
  record("maybe() body entered, flag=" + String(flag));
  if (flag) {
    record("maybe(): taking the THROW path");
    throw new Error("boom");
  }
  record("maybe(): taking the RETURN 1 path");
  return 1;
}

const FLAG = false;

record("a-falsy.js: publishing dangerousOp as module.exports");
module.exports = dangerousOp;

record("a-falsy.js: requiring ./b-falsy (circular back-reference)");
const b = require("./b-falsy");

record("a-falsy.js: evaluating `class C extends maybe(FLAG)`");
class C extends maybe(FLAG) {}

record("a-falsy.js: class C evaluated (UNREACHABLE) C=" + String(C));
function safeOp(input) {
  return "safe:" + input;
}
record("a-falsy.js: publishing safeOp (UNREACHABLE on this path)");
module.exports = safeOp;
