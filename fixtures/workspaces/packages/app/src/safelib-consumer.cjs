"use strict";

const safelib = require("safelib");

module.exports.handle = function handle(input) {
  return safelib.safe(input);
};
