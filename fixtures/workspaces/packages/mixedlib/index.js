"use strict";

// The WORKSPACE copy, and the dangerous one. It is what the app really
// resolves (node_modules/mixedlib links here). A SAFE installed copy of
// the same name and version exists at packages/lib/node_modules/mixedlib;
// attributing this consumer's call to that one would be a false
// NOT_AFFECTED about a genuinely reachable sink.
function vulnerable(input) {
  return "workspace mixedlib/index.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
