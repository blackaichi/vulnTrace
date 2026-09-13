"use strict";

// A DISTINCT public surface from ".": exports["./api"]. An advisory naming
// `exportslib/api` must anchor here and never at out/index.js.
function vulnerable(input) {
  return "exportslib/out/api.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
