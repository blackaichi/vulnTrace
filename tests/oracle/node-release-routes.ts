/**
 * Task BL-114 (docs/tasks/BL-114-loader-inventory-node-releases.md): which
 * Node releases take each loader route a stored property can redirect, as
 * measured with real Node (`scripts/bl114-loader-inventory-releases/`,
 * results in its `releases.md`). An oracle case whose real-Node ground
 * truth depends on the release asserts the ground truth of the release it
 * runs on from this table.
 *
 * Each range starts at a measured release and ends at a measured change or
 * at the next major line. Releases of a line later than the last one
 * measured are assumed to keep its behaviour, so a change surfaces as a
 * failing ground-truth assertion (re-measure), never as a skipped one. A
 * release no range covers (an odd line, a line not measured, a release
 * older than the first one measured) throws: measure it and add it here.
 */

export type LoaderRoute =
  /** BL-111's: an ES module load reads its load context's `source` by inheritance, reached by `import()`. */
  | "import-source"
  /** RWF-158: `require()` of an ES module loads its static dependencies through a load context that inherits `source`. */
  | "require-esm-source"
  /** v20's `trySelf` destructures `{ data, path }` from `false` for a module with no package scope. */
  | "try-self-scope"
  /** RWF-160: `Module.prototype.load`'s `this.paths ??= …` keeps a lookup list a new module inherits. */
  | "inherited-paths";

interface ReleaseRange {
  /** The first release of the range: measured. */
  readonly from: string;
  /** The first release after the range (exclusive), when one was measured. */
  readonly before?: string;
  readonly live: boolean;
  /** The releases measured in the range. */
  readonly measured: readonly string[];
}

const LINE_20 = { from: "20.19.0", before: "21.0.0" } as const;
const LINE_22 = { from: "22.11.0", before: "23.0.0" } as const;
const LINE_26 = { from: "26.0.0", before: "27.0.0" } as const;

export const RELEASE_ROUTES: Readonly<
  Record<LoaderRoute, readonly ReleaseRange[]>
> = {
  "import-source": [
    { ...LINE_20, live: true, measured: ["20.19.0", "20.20.2"] },
    { ...LINE_22, live: true, measured: ["22.11.0", "22.12.0", "22.23.4"] },
    {
      from: "24.0.0",
      before: "24.12.0",
      live: true,
      measured: ["24.0.0", "24.11.1"],
    },
    {
      from: "24.12.0",
      before: "25.0.0",
      live: false,
      measured: ["24.12.0", "24.22.1"],
    },
    { ...LINE_26, live: false, measured: ["26.0.0", "26.12.1"] },
  ],
  "require-esm-source": [
    { ...LINE_20, live: true, measured: ["20.19.0", "20.20.2"] },
    // `require()` of an ES module throws ERR_REQUIRE_ESM before v22.12.0.
    { from: "22.11.0", before: "22.12.0", live: false, measured: ["22.11.0"] },
    {
      from: "22.12.0",
      before: "23.0.0",
      live: true,
      measured: ["22.12.0", "22.23.4"],
    },
    {
      from: "24.0.0",
      before: "24.12.0",
      live: true,
      measured: ["24.0.0", "24.11.1"],
    },
    {
      from: "24.12.0",
      before: "25.0.0",
      live: false,
      measured: ["24.12.0", "24.22.1"],
    },
    { ...LINE_26, live: false, measured: ["26.0.0", "26.12.1"] },
  ],
  "try-self-scope": [
    { ...LINE_20, live: true, measured: ["20.19.0", "20.20.2"] },
    { ...LINE_22, live: false, measured: ["22.11.0", "22.12.0", "22.23.4"] },
    {
      from: "24.0.0",
      before: "25.0.0",
      live: false,
      measured: ["24.0.0", "24.11.1", "24.12.0", "24.22.1"],
    },
    { ...LINE_26, live: false, measured: ["26.0.0", "26.12.1"] },
  ],
  "inherited-paths": [
    { ...LINE_20, live: false, measured: ["20.19.0", "20.20.2"] },
    // `this.paths = …` before v22.15.0, `this.paths ??= …` from it (bisected).
    {
      from: "22.11.0",
      before: "22.15.0",
      live: false,
      measured: ["22.11.0", "22.12.0", "22.13.1", "22.14.0"],
    },
    {
      from: "22.15.0",
      before: "23.0.0",
      live: true,
      measured: ["22.15.0", "22.15.1", "22.20.0", "22.23.4"],
    },
    {
      from: "24.0.0",
      before: "25.0.0",
      live: true,
      measured: ["24.0.0", "24.11.1", "24.12.0", "24.22.1"],
    },
    { ...LINE_26, live: true, measured: ["26.0.0", "26.12.1"] },
  ],
};

function compare(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether real Node takes `route` on `version` (default: the release
 * running this process, which is the one an oracle case's ground truth
 * runs on). Throws for a release no measured range covers.
 */
export function routeLive(
  route: LoaderRoute,
  version: string = process.versions.node,
): boolean {
  const range = RELEASE_ROUTES[route].find(
    (r) =>
      compare(version, r.from) >= 0 &&
      (r.before === undefined || compare(version, r.before) < 0),
  );
  if (range === undefined) {
    throw new Error(
      `BL-114: route "${route}" is not measured on Node v${version}; run scripts/bl114-loader-inventory-releases/ on it and add it to RELEASE_ROUTES (tests/oracle/node-release-routes.ts)`,
    );
  }
  return range.live;
}
