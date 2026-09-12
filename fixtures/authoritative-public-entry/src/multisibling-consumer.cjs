// Calls every public name, so all four candidate files are in the graph.
// Only the public entry's own forwarding chain may decide the target.
const pkg = require("multisibling-lib");

module.exports = function main(input) {
  return [
    pkg.vulnerable(input),
    pkg.runOne(input),
    pkg.runTwo(input),
    pkg.runThree(input),
  ].join("|");
};
