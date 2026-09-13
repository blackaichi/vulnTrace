"use strict";

function safe(input) {
  return "@scope/lib/out/index.js:safe:" + String(input);
}

module.exports = { safe };
