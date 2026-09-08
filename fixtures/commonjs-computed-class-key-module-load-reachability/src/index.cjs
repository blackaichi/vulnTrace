"use strict";

// RWF-023's canonical entrypoint: loads only the minimal reproducer.
const fixture = require("fixture-lib");

module.exports = function main(input) {
  return { fixture, input };
};
