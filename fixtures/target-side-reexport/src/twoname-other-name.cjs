// Calls the OTHER exported name for the very same implementation.
const lib = require("twoname-lib");

module.exports = function main(input) {
  return lib.alsoVulnerable(input);
};
