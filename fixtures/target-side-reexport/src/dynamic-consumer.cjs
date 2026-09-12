const lib = require("dynamic-lib");

module.exports = function main(input) {
  return lib.vulnerable(input);
};
