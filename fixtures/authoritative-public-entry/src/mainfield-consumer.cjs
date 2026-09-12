const pkg = require("mainfield-lib");

module.exports = function main(input) {
  return pkg.vulnerable(input) + "|" + pkg.runDecoy(input);
};
