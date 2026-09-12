const lib = require("duplicate-lib");

module.exports = function main(input) {
  return lib.vulnerable(input);
};
