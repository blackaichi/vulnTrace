const pkg = require("mainonly-lib");

module.exports = function main(input) {
  return pkg.vulnerable(input);
};
