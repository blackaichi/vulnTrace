const debug = require("debug");

// `ms` is never a direct dependency of this application -- it is pulled
// in transitively, solely because `debug` depends on it. The reachable
// call here goes through debug's own re-export (debug.js:14,
// `exports.humanize = require('ms')`), not through any direct reference
// to `ms` at all. GHSA-3fx5-fwvr-xrjg / CVE-2015-8315 (ReDoS) is in
// ms@0.6.2's own parser, reached here under the name `debug.humanize`.
function parseWindow(userSuppliedDuration) {
  return debug.humanize(userSuppliedDuration);
}

module.exports = { parseWindow };
