import { vulnerable } from "adv-vuln-lib";

export function main() {
  if (1 === 1) {
    return vulnerable();
  }
  return "unreachable branch";
}
