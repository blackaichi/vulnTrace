"use strict";

// Published only through the entry's forward, under a DIFFERENT public
// name. The advisory names `fwdlib#vulnerable`; the implementation is
// `internal` here (P1-A1/RWF-029's relation, reused unchanged).
exports.internal = function fwdlibImplDanger(input) {
  return "fwdlib/impl.js:internal:" + String(input);
};
