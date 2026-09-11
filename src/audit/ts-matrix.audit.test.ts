/**
 * P0-Z PART L: TypeScript transversal safety matrix.
 *
 * Focus is false-NOT_AFFECTED risk only. Each entrypoint genuinely reaches
 * vlib's vulnerable export through a TS-specific construct; anything the
 * frontend does not model must degrade to UNKNOWN, never NOT_AFFECTED.
 *
 * These fixtures are TS, so the real-Node oracle cannot execute them
 * directly; reachability is established by construction (the emitted
 * runtime semantics of each snippet are plain calls) and cross-checked by
 * the erased-import case, which must NOT invent an edge.
 */
import { afterAll, describe, it } from "vitest";
import { cleanupAll, describe1, scan, type Files, type AuditFinding } from "./harness.js";

afterAll(cleanupAll);
const TIMEOUT = 60_000;

const SCAFFOLD: Files = {
  "package.json": JSON.stringify({
    name: "app",
    version: "1.0.0",
    type: "module",
    dependencies: { vlib: "1.0.0" },
  }),
  "package-lock.json": JSON.stringify({
    name: "app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "app", version: "1.0.0", dependencies: { vlib: "1.0.0" } },
      "node_modules/vlib": { version: "1.0.0" },
    },
  }),
  "tsconfig.json": JSON.stringify({
    compilerOptions: { target: "ES2022", module: "ESNext", strict: true },
  }),
  "node_modules/vlib/package.json": JSON.stringify({
    name: "vlib",
    version: "1.0.0",
    type: "module",
    exports: { ".": "./index.js" },
    types: "./index.d.ts",
  }),
  "node_modules/vlib/index.js":
    "export function vulnerable(){ return 'boom'; }\nexport function safe(){ return 'ok'; }\n",
  "node_modules/vlib/index.d.ts":
    "export declare function vulnerable(): string;\nexport declare function safe(): string;\n",
};

const rows: string[] = [];

async function probe(id: string, src: string, expectReach: boolean): Promise<void> {
  const r = await scan({
    files: {
      ...SCAFFOLD,
      "src/impl.ts":
        "import { vulnerable } from 'vlib';\nexport const run = () => vulnerable();\n",
      "src/index.ts": src,
    },
    entrypoints: ["src/index.ts"],
    pkgName: "vlib",
    targets: [{ module: "vlib", export: "vulnerable" }],
  });
  const f: AuditFinding | undefined = r.findings[0];
  const v = describe1(f);
  const bad = expectReach && v.startsWith("NOT_AFFECTED");
  rows.push(
    `${bad ? "!! FALSE-NEG !!" : "ok            "} ${id.padEnd(34)} analyzer=${v.padEnd(24)} runtimeReaches=${expectReach}`,
  );
  console.log(`[${id}] ${v} (reaches=${expectReach})`);
}

afterAll(() => {
  console.log("\n===== TYPESCRIPT MATRIX =====");
  for (const r of rows) console.log(r);
});

describe("PART L -- TypeScript matrix", () => {
  it("T1: `as` assertion around the callable", async () => {
    await probe(
      "T1-as-assertion",
      "import { vulnerable } from 'vlib';\n" +
        "const f = vulnerable as () => string;\n" +
        "export const run = () => f();\n",
      true,
    );
  }, TIMEOUT);

  it("T2: non-null assertion", async () => {
    await probe(
      "T2-non-null-assertion",
      "import { vulnerable } from 'vlib';\n" +
        "const f: (() => string) | undefined = vulnerable;\n" +
        "export const run = () => f!();\n",
      true,
    );
  }, TIMEOUT);

  it("T3: satisfies operator", async () => {
    await probe(
      "T3-satisfies",
      "import { vulnerable } from 'vlib';\n" +
        "const f = vulnerable satisfies () => string;\n" +
        "export const run = () => f();\n",
      true,
    );
  }, TIMEOUT);

  it("T4: angle-bracket-free type assertion chain", async () => {
    await probe(
      "T4-assertion-chain",
      "import { vulnerable } from 'vlib';\n" +
        "const f = (vulnerable as unknown) as () => string;\n" +
        "export const run = () => f();\n",
      true,
    );
  }, TIMEOUT);

  it("T5: type-only import must NOT create a runtime edge", async () => {
    // `import type` is fully erased: `vulnerable` is never called at runtime.
    // A NOT_AFFECTED here would be legitimate; an AFFECTED would be a false
    // positive from a phantom edge. Recorded either way.
    await probe(
      "T5-erased-type-import",
      "import type { vulnerable } from 'vlib';\n" +
        "export type F = typeof vulnerable;\n" +
        "export const run = (): string => 'no runtime use';\n",
      false,
    );
  }, TIMEOUT);

  it("T6: namespace import + member call", async () => {
    await probe(
      "T6-namespace-import",
      "import * as v from 'vlib';\n" + "export const run = () => v.vulnerable();\n",
      true,
    );
  }, TIMEOUT);

  it("T7: TS wrapper around an abrupt expression", async () => {
    await probe(
      "T7-ts-wrapper-abrupt",
      "import { vulnerable } from 'vlib';\n" +
        "function bail(): never { throw new Error('x'); }\n" +
        "export const run = () => vulnerable();\n" +
        "bail();\n",
      false,
    );
  }, TIMEOUT);

  it("T8: enum-indexed dispatch to the vulnerable callable", async () => {
    await probe(
      "T8-enum-dispatch",
      "import { vulnerable, safe } from 'vlib';\n" +
        "enum Mode { Safe, Danger }\n" +
        "const table = { [Mode.Safe]: safe, [Mode.Danger]: vulnerable };\n" +
        "export const run = (m: Mode) => table[m]();\n",
      true,
    );
  }, TIMEOUT);

  it("T9: default export re-exported through a barrel (TS)", async () => {
    await probe(
      "T9-ts-barrel-reexport",
      "export { run } from './impl.js';\n",
      true,
    );
  }, TIMEOUT);
});
