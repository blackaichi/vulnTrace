"use strict";

// The isolating control -- the same call as a top-level statement.
const fixture = require("fixture-lib/top-level");

module.exports = function main(input) {
  return { fixture, input };
};
