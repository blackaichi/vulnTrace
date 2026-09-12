"use strict";

function vulnerable(input) {
  return "lib/index.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
