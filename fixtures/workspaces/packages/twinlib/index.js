"use strict";

// The WORKSPACE copy of `twinlib@1.0.0`. Byte-for-byte the same manifest
// name and version as the separately installed copy at
// node_modules/twinlib -- and a completely different implementation. The
// two must never share a PackageInstance, evidence, or verdict.
function safe(input) {
  return "workspace twinlib/index.js:safe:" + String(input);
}

module.exports = { safe };
