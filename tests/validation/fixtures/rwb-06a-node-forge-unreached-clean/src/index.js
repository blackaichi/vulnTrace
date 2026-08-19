// RWB-06A (VT-303) -- clean, single-cause sibling of RWB-06.
//
// node-forge is a real, installed dependency (same package, same version
// 1.3.3 as RWB-06) but is never require()'d or imported anywhere in this
// source tree. Unlike RWB-06 (kept unchanged as the RWF-002 confounded
// exhibit -- see its own header comment), this entrypoint contains NO
// other unresolved or dynamic construct: no method calls on untyped
// values, no dynamic require/import, no computed property access. The
// only string operation below is a plain `+` concatenation, which is not
// a call at all and therefore produces no call-graph edge, resolved or
// otherwise.
//
// This isolates the intended thesis as the ONLY mechanism under test:
// a vulnerable package can be genuinely installed yet never reachable
// from the application's configured entrypoint.
function formatAuthHeader(token) {
  return "Bearer " + token;
}

module.exports = { formatAuthHeader };
