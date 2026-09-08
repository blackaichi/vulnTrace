"use strict";

// The canonical RWF-023 shape as a real CommonJS module, so `entry.js` can
// prove that a plain `require()` -- with no call into the module, no
// entrypoint, and no export ambiguity -- is on its own enough to reach the
// sink.

const danger = require("./danger");

function key() {
  danger.explode("from-computed-key");
  return "x";
}

class C {
  [key()]() {
    // Deferred. Never runs during module evaluation.
    return danger.explode("from-method-body");
  }
}

module.exports = C;
