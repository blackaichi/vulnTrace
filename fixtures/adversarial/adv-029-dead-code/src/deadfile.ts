import { vulnerable } from "adv-vuln-lib";

export function deadEntry() {
  return vulnerable();
}
