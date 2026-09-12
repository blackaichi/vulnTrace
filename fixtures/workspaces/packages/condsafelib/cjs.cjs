"use strict";

// The ACTIVE branch for this fixture's `.cjs` consumer, and it is safe.
function safe(input) {
  return "condsafelib/cjs.cjs:safe:" + String(input);
}

module.exports = { safe };
