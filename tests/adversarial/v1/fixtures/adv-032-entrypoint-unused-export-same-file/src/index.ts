import { vulnerable, safe } from "adv-vuln-lib";

export function main() {
  return safe();
}

export function unused() {
  return vulnerable();
}
