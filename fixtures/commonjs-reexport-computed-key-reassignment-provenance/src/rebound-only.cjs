const fixture = require("fixture-lib");

// Calls the export the facade GENUINELY reassigns. Attribution for it must
// stay refused, so this scan must stay UNKNOWN -- before and after.
module.exports = function main(input) {
  return fixture.rebound(input);
};
