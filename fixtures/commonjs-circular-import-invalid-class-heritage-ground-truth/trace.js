"use strict";
// A shared, ordered event log. `a.js` aborts partway through its own
// evaluation, so the only way to prove WHICH steps ran (and in what order)
// is to record them somewhere that survives the throw.
const events = [];

function record(event) {
  events.push(event);
  console.log("[trace]", event);
  return event;
}

function seen() {
  return events.slice();
}

module.exports = { record, seen };
