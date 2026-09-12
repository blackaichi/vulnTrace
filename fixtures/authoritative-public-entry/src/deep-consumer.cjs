// Deep import: bypasses the package's public entry entirely.
const deep = require("deep-lib/deep");
const pkg = require("deep-lib");

module.exports = function main(input) {
  return deep.vulnerable(input) + "|" + pkg.safe(input);
};
