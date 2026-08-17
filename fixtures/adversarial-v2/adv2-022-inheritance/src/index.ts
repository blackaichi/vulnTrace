import { MySub } from "./sub.js";

export function main() {
  const instance = new MySub();
  return instance.dangerousOp();
}
