const pkg = require("renamed-lib");

module.exports = function main(input) {
  return pkg.vulnerable(input);
};
