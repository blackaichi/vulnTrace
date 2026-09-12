"use strict";

// The ACTIVE branch for this fixture's `.cjs` consumer, and the dangerous
// one. A workspace package's conditional exports must be selected by the
// real consumer's condition, exactly as an installed package's are.
function vulnerable(input) {
  return "condlib/cjs.cjs:vulnerable:" + String(input);
}

module.exports = { vulnerable };
