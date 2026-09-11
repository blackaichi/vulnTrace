const fixture = require("fixture-lib");

// Calls ONLY `safe`. Nothing here reaches `unused`, whose attribution is
// clean both before and after RWF-025b -- the valid Family C control.
module.exports = function main(input) {
  return fixture.safe(input);
};
