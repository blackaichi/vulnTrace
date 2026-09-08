"use strict";
let sinkCalls = 0;

function explode(input) {
  sinkCalls += 1;
  return "EXPLODED:" + input;
}

function sinkCallCount() {
  return sinkCalls;
}

module.exports = { explode, sinkCallCount };
