// Both instances are LOADED; only the alias instance's public entry is
// CALLED. The two must never collapse into one identity.
const alias = require("twin-alias");
require("twin-lib");

module.exports = function main(input) {
  return alias.vulnerable(input);
};
