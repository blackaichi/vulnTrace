const pkg = require("dupreverse-lib");

module.exports = function main(input) {
  return pkg.vulnerable(input) + "|" + pkg.runOther(input);
};
