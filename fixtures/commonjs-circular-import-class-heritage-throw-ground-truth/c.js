"use strict";
// The DEFERRED / HARMLESS-HERITAGE NEGATIVE control, deliberately
// identical to a.js except that no heritage expression aborts the class
// definition:
//
//   * `extends baseFactory()` -- a heritage CALL that returns normally,
//     which is all RWF-020 ever needs to know about the returned value;
//   * `extends null` -- legal, evaluates no call at all;
//   * a `class ... extends bail()` defined inside `configure()`, which
//     nothing calls at module scope, so its heritage is deferred.
//
// Evaluating these class definitions runs `baseFactory()` and nothing
// else, so module evaluation continues and the LATER (safe) export really
// is authoritative. Withdrawing authority here would be a false refusal.

function dangerousOp(input) {
  return "EXPLODED:" + input;
}

function bail() {
  throw new Error("c.js: bail() always throws (deferred position only)");
}

function baseFactory() {
  console.log("[c.js] baseFactory() called -- returns normally");
  return class Base {};
}

function configure() {
  class Deferred extends bail() {}
  return Deferred;
}

module.exports = dangerousOp;

class C extends baseFactory() {}
class N extends null {}

function safeOp(input) {
  return "safe:" + input;
}

console.log(
  "[c.js] both class definitions completed WITHOUT throwing; publishing safeOp",
);
safeOp.C = C;
safeOp.N = N;
safeOp.configure = configure;
module.exports = safeOp;
