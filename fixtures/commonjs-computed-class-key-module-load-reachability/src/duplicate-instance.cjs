"use strict";

// Duplicate same-name, same-version installs; the key reaches the NESTED one.
const fixture = require("fixture-lib/duplicate-instance");

module.exports = function main(input) {
  return { fixture, input };
};
