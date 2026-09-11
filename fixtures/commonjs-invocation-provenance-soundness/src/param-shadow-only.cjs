// A fourth entrypoint reaching only the parameter-shadow control module,
// and — unlike the other control entrypoints — it CALLS the exported
// value. That is what makes the assertion meaningful: the module's later
// export write must still be attributable, so the call resolves to
// `safeOp`. If a wrapper parameter were crossed again and the module's
// authority withdrawn, the whole exported value would be ambiguous and
// nothing would resolve.
const paramShadow = require("fixture-lib/param-shadow");

module.exports = function main(input) {
  return paramShadow(input);
};
