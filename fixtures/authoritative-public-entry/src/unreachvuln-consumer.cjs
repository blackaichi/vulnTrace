const pkg = require("unreachvuln-lib");

module.exports = function main(input) {
  return pkg.safe(input);
};
