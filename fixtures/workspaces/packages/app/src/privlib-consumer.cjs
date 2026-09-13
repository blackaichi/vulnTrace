"use strict";

const privlib = require("privlib");

module.exports.handle = function handle(input) {
  return privlib.vulnerable(input);
};
