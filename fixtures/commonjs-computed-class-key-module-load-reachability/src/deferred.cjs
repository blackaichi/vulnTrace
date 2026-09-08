"use strict";

// The deferral negative controls -- must stay unreachable.
const fixture = require("fixture-lib/deferred");

module.exports = function main(input) {
  return { fixture, input };
};
