"use strict";

function vulnerable(input) {
  return "exportslib/out/index.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
