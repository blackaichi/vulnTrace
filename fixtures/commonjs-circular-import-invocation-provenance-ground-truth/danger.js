"use strict";
// The vulnerable sink. Counting calls is what turns "the retained
// dangerous export really does reach the sink" into a measurement.
let calls = 0;

function explode(input) {
  calls += 1;
  return "EXPLODED:" + input;
}

function sinkCallCount() {
  return calls;
}

module.exports = { explode, sinkCallCount };
