"use strict";
const fixture = require("fixture-lib");

function main(input) {
  return fixture(input);
}

function bail() {
  throw new Error("entry bail");
}

if (process.env.FIXTURE_LIB_MODE === "fast") {
  const o = { k: bail() };
  void o;
}

module.exports = main;
