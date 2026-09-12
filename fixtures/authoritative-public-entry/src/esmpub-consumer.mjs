import { vulnerable, runOther } from "esmpub-lib";

export function main(input) {
  return vulnerable(input) + "|" + runOther(input);
}
