import { vulnerable } from "adv-vuln-lib";

function wrapper() {
  return vulnerable();
}

export function main() {
  return "safe path, wrapper never called";
}
