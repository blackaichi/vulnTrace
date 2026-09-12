"use strict";

const api = require("subpathonlylib/api");

module.exports.handle = function handle(input) {
  return api.vulnerable(input);
};
