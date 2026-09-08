"use strict";
// The DEFERRED-position NEGATIVE control, deliberately identical to a.js
// except that the always-throwing call sits where the language really does
// defer it:
//
//   * `m() { bail(); }` -- a method BODY, executed on invocation, not while
//     the object literal is built;
//   * a computed key on an object literal built inside `configure()`,
//     which nothing calls at module scope.
//
// Unlike a CLASS's instance field, an object literal has no per-instance
// deferral for an ordinary property's VALUE -- every property of an object
// literal, key and value alike, evaluates immediately when the literal
// itself is evaluated (see expressions.js for that boundary demonstrated
// directly). What genuinely defers here is a BODY (a method/getter/setter
// only runs when called) and a computed key that never gets reached at all
// because the object literal containing it is never built.
//
// Evaluating the object literal below installs a method and runs nothing
// else, so module evaluation continues, and the LATER (safe) export really
// is authoritative.

function dangerousOp(input) {
  return "EXPLODED:" + input;
}

function bail() {
  throw new Error("c.js: bail() always throws (deferred positions only)");
}

function configure() {
  return {
    [bail()]: 1,
  };
}

module.exports = dangerousOp;

const o = {
  m() {
    bail();
  },
};

function safeOp(input) {
  return "safe:" + input;
}

console.log(
  "[c.js] object literal evaluated WITHOUT calling bail() from a KEY; publishing safeOp",
);
safeOp.callMethod = () => o.m();
safeOp.configure = configure;
module.exports = safeOp;
