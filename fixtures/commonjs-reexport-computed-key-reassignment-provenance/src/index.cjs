const fixture = require("fixture-lib");

// Calls the poisoned export. Runtime truth: this IS lib.js's `vulnerable`.
module.exports = function main(input) {
  return fixture.vulnerable(input);
};
