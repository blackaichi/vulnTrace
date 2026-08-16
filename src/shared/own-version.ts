import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface OwnPackageManifest {
  readonly version?: string;
}

/**
 * VulnTrace's own installed version (see package.json). Shared by
 * `vulntrace version` and cache-key computation (docs/SDD.md § 28: "cache
 * keys must include relevant inputs and tool version" — a stale cache
 * entry from a different tool version must never be silently reused).
 */
export function readOwnVersion(): string {
  const packageJsonPath = path.resolve(
    fileURLToPath(new URL("../../package.json", import.meta.url)),
  );
  const manifest = JSON.parse(
    readFileSync(packageJsonPath, "utf-8"),
  ) as OwnPackageManifest;
  return manifest.version ?? "0.0.0";
}
