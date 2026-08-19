const consumer = require("consumer");

// Reaches ONLY the NESTED url-parse@1.4.7 instance, via consumer's own
// require("url-parse") -- which resolves to
// node_modules/consumer/node_modules/url-parse (Node's nearest-
// node_modules-wins resolution), never the fixture's own top-level
// node_modules/url-parse.
//
// The top-level url-parse@1.4.4 instance (see package.json) is a real,
// genuinely installed direct dependency -- but nothing reachable from
// this entrypoint ever calls require("url-parse") directly, so it is
// never touched. No npm alias is involved anywhere: both instances are
// plain, real, differently-versioned url-parse installs at different
// paths, the same shape npm itself produces whenever a transitive
// dependency needs a version its consumers don't share (contrast with
// RWB-09, which specifically tests npm-aliased identity instead).
function checkNestedUrl(rawUrl) {
  return consumer.parseNested(rawUrl);
}

module.exports = { checkNestedUrl };
