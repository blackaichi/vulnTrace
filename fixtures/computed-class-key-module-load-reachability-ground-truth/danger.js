"use strict";

// The instrumented stand-in for a vulnerable dependency export. It records
// every invocation so `entry.js` can ASSERT on what actually ran, rather
// than reading log output and believing it.

let calls = [];

function explode(tag) {
  calls.push(tag);
  return tag;
}

module.exports = {
  explode,
  reset() {
    calls = [];
  },
  calls() {
    return [...calls];
  },
};
