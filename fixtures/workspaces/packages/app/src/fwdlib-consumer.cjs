"use strict";

const fwdlib = require("fwdlib");

module.exports.handle = function handle(input) {
  return fwdlib.vulnerable(input);
};
