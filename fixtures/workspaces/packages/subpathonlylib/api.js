"use strict";

function vulnerable(input) {
  return "subpathonlylib/api.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
