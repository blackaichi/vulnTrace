"use strict";

const api = require("@scope/lib/api");

module.exports.handle = function handle(input) {
  return api.vulnerable(input);
};
