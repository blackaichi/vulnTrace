"use strict";

// The real public entry: `exports` "." wins over `main`.
function safe(input) {
  return "expmainlib/modern.js:safe:" + String(input);
}

// Re-published under a DIFFERENT public name, so legacy.js is genuinely
// module-load reachable while `vulnerable` is not what it publishes.
const legacy = require("./legacy.js");

module.exports = { safe, alsoSafe: legacy.vulnerable };
