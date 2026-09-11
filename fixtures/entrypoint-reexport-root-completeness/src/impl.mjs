import dep from "fixture-lib";

export function run(userInput) {
  return dep.dangerousOp(userInput);
}

export function safe(userInput) {
  return "safe:" + userInput;
}
