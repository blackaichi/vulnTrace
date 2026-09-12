"use strict";

// A SCOPED twin: declares exactly the same scoped name and version as
// packages/scopedlib, in a different directory. Nothing links it under
// that name, so it is never what `require("@scope/lib")` resolves -- and
// it must remain a distinct PackageInstance regardless, never merged with
// its twin on the strength of a matching scoped name.
function vulnerable(input) {
  return "scopedtwin/index.js:vulnerable:" + String(input);
}

module.exports = { vulnerable };
