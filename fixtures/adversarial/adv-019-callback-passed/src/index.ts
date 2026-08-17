import { vulnerable } from "adv-vuln-lib";

function invoke(fn: () => unknown) {
  return fn();
}

export function main() {
  return invoke(vulnerable);
}
