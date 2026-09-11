"use strict";
// A shared, drainable event log, so entry.js can assert WHICH statements
// actually executed rather than only which value came back.
const events = [];

function record(event) {
  events.push(event);
}

/** Everything recorded since the last call, and clears the log. */
function seen() {
  return events.splice(0, events.length);
}

module.exports = { record, seen };
