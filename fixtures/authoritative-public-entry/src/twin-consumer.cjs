// Reaches BOTH twins in one scan: the top-level install directly, and the
// nested install through wrap-lib. Each instance's advisory must be
// answered only from its own public entry.
const top = require("twinpub-lib");
const wrap = require("wrap-lib");

module.exports = function main(input) {
  return top.vulnerable(input) + "|" + wrap.runNestedVulnerable(input);
};
