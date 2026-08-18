import { vulnerable } from "adv-vuln-lib";

export function main() {
  if (false) {
    return vulnerable();
  }
  return "always this branch";
}
