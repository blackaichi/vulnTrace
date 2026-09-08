"use strict";

// An imported member call written directly as the computed key.
const fixture = require("fixture-lib/direct-call");

module.exports = function main(input) {
  return { fixture, input };
};
