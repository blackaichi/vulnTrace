import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type CliIo, defaultIo } from "./io.js";

interface OwnPackageManifest {
  readonly version?: string;
}

function readOwnVersion(): string {
  const packageJsonPath = path.resolve(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
  );
  const manifest = JSON.parse(
    readFileSync(packageJsonPath, "utf-8"),
  ) as OwnPackageManifest;
  return manifest.version ?? "0.0.0";
}

/** `vulntrace version` (see docs/SDD.md § 25). */
export function runVersionCommand(io: CliIo = defaultIo): number {
  io.stdout(`vulntrace ${readOwnVersion()}\n`);
  return 0;
}
