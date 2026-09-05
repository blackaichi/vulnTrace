// The PRECISE control: identical to rwf016.cjs with the cutoff removed, so
// export authority is intact and `main` is rooted by name exactly as it was
// before RWF-021. Nothing widens here, and the answer must not change.
const dep = require("fixture-lib");

function main(userInput) {
  return dep.dangerousOp(userInput);
}

module.exports = main;
