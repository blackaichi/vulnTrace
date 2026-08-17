import { vulnerable, safe } from "adv-vuln-lib";

export function main() {
  safe();
  return vulnerable();
}
