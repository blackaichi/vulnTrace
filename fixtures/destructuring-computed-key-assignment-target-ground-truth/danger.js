"use strict";

let reached = 0;

function explode(input) {
  reached++;
  return "danger:" + input;
}

module.exports = { explode, reachedCount: () => reached };
