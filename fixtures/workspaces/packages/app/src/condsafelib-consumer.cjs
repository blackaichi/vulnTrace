"use strict";

const condsafelib = require("condsafelib");

module.exports.handle = function handle(input) {
  return condsafelib.safe(input);
};
