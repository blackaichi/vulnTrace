"use strict";

function vulnerable(input) {
  return "@scope/lib/out/api.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
