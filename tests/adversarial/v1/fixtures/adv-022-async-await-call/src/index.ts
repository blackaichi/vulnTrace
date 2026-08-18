import { vulnerable } from "adv-vuln-lib";

async function run() {
  return await vulnerable();
}

export async function main() {
  return await run();
}
