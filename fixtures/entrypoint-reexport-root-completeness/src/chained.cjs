// P0-Z -- TWO-HOP re-export chain. The incompleteness must not be dropped
// just because the forwarding is indirect: this file forwards to
// ./hop.cjs, which itself forwards to ./impl.cjs.
module.exports = require("./hop.cjs");
