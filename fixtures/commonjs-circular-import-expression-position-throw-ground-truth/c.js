"use strict";
// The DEFERRED / CONDITIONAL negative control, deliberately identical to
// a.js except that the always-throwing call sits where the language does
// NOT require it to run:
//
//   * `flag && bail()` -- a logical operator's RIGHT operand, skipped
//     entirely for a falsy left operand;
//   * `() => sink(bail())` -- inside an arrow body, which nothing calls at
//     module scope;
//   * `function f(x = bail()) {}` -- a default parameter, evaluated only
//     on a call that omits the argument.
//
// None of them runs while this module is evaluated, so module evaluation
// continues and the LATER (safe) export really is authoritative. This is
// the precision half of RWF-026: the analyzer must keep authority here
// exactly as Node does.

function dangerousOp(input) {
  return "EXPLODED:" + input;
}

function bail() {
  throw new Error("c.js: bail() always throws (deferred positions only)");
}

function sink(a) {
  return a;
}

module.exports = dangerousOp;

const flag = 0;
const skipped = flag && bail();
const callback = () => sink(bail());
function withDefault(x = bail()) {
  return x;
}

function safeOp(input) {
  return "safe:" + input;
}

console.log(
  "[c.js] conditional / deferred positions evaluated WITHOUT calling bail(); publishing safeOp",
);
safeOp.runCallback = () => callback();
safeOp.runDefault = () => withDefault();
safeOp.skipped = skipped;
module.exports = safeOp;
