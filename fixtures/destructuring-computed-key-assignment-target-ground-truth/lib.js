"use strict";

// The poisoned module, byte-for-byte the shape RWF-025 is about: an
// UNRELATED destructuring assignment whose computed key merely EVALUATES
// `keyFor(bail)`, and, further down, an RWF-024 object-literal computed key
// that really does end module evaluation.
const danger = require("./danger");

function dangerousOp(input) {
  return danger.explode(input);
}

function safeOp(input) {
  return "safe:" + input;
}

function bail() {
  throw new Error("fast mode is not supported here");
}

function keyFor(fn) {
  return "handler:" + fn.name;
}

const REGISTRY = { "handler:bail": "registered" };
let seen;

// THE POISON. Completes normally: it reads REGISTRY["handler:bail"] and
// binds it to `seen`. `bail` is passed as an ARGUMENT, and is not rebound.
({ [keyFor(bail)]: seen } = REGISTRY);

// The element-access form of the same shape. Rebinds nothing local.
REGISTRY[keyFor(safeOp)] = "installed";

module.exports = dangerousOp;

// The cyclic consumer observes the module HERE -- with `dangerousOp`
// published and the throwing statement still ahead of it.
require("./observer");

// RWF-024's cutoff. Reaching this necessarily invokes `bail()`, which never
// returns, so nothing below runs on this load.
const mode = {
  [keyFor(safeOp)]: "fast",
  [bail()]: 1,
};
void mode;

// Never reached on this load.
module.exports = safeOp;
void seen;
