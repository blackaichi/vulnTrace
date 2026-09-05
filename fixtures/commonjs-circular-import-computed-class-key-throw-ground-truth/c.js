"use strict";
// The DEFERRED-position NEGATIVE control, deliberately identical to a.js
// except that the always-throwing call sits where the language really does
// defer it:
//
//   * `x = bail()` -- an instance field's VALUE, executed per-instance
//     during construction (this is RWF-018's line, and it still holds);
//   * `m() { bail(); }` -- a method BODY, executed on invocation;
//   * a computed key on a class defined inside `configure()`, which
//     nothing calls at module scope.
//
// Evaluating this class definition installs the initializer and runs
// nothing, so module evaluation continues, and the LATER (safe) export
// really is authoritative. Withdrawing authority here would be a false
// refusal. The contrast with a.js is the whole of RWF-019: the same
// element whose VALUE is deferred has a KEY that is not.

function dangerousOp(input) {
  return "EXPLODED:" + input;
}

function bail() {
  throw new Error("c.js: bail() always throws (deferred positions only)");
}

function configure() {
  class Deferred {
    [bail()] = 1;
  }
  return Deferred;
}

module.exports = dangerousOp;

class C {
  x = bail();
  m() {
    bail();
  }
}

function safeOp(input) {
  return "safe:" + input;
}

console.log(
  "[c.js] class C evaluated WITHOUT calling bail(); publishing safeOp",
);
safeOp.construct = () => new C();
safeOp.configure = configure;
module.exports = safeOp;
