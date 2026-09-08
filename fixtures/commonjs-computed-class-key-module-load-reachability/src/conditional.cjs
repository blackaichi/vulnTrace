"use strict";

// A class declared inside a top-level `if` -- reachable, not must-execute.
const fixture = require("fixture-lib/conditional");

module.exports = function main(input) {
  return { fixture, input };
};
