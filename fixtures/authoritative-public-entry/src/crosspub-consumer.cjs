const pkg = require("crosspub-lib");

module.exports = function main(input) {
  return pkg.vulnerable(input) + "|" + pkg.runOther(input);
};
