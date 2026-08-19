// This application formats outgoing request headers. It does not use
// TLS/certificate handling of any kind -- node-forge is a real, installed
// dependency (left over from a removed feature) but is never
// require()'d or imported anywhere in this source tree.
function formatAuthHeader(token) {
  return `Bearer ${token.trim()}`;
}

module.exports = { formatAuthHeader };
