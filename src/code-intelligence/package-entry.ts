import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import {
  identifyModule,
  readInstalledPackageName,
  type KnownPackageRoots,
} from "../domain/resolved-target.js";
import type { ModuleResolver } from "./module-resolver.js";

/**
 * A bare package specifier split into the two parts Node's own resolution
 * algorithm treats separately (P1-A3): the PACKAGE NAME, which selects an
 * installed package, and the SUBPATH, which selects one of that package's
 * declared public surfaces.
 *
 * `subpath` is stored WITHOUT the `./` prefix (`"parse"`, `"lib/deep"`),
 * because that is the shape a specifier carries; {@link publicSubpathOf}
 * converts it to the `"./parse"` spelling `package.json`'s own `exports`
 * map uses, so the two spellings are never confused for each other.
 */
export interface PackageSpecifierParts {
  readonly packageName: string;
  readonly subpath?: string;
}

/**
 * Splits a BARE package specifier (`"foo"`, `"foo/parse"`,
 * `"@scope/pkg"`, `"@scope/pkg/api"`) into {@link PackageSpecifierParts},
 * handling the scoped form as a single two-segment name so a scoped
 * package's ROOT is never mistaken for the scope directory itself
 * (`node_modules/@scope/pkg`, never `node_modules/@scope` — P1-A3 § B).
 *
 * Returns `undefined` for anything that is not a bare package specifier —
 * a relative (`"./x"`, `"../x"`) or absolute path, a Node builtin (with or
 * without the `node:` prefix), a package-internal `#import`, a bare `@scope`
 * with no package after it, or a specifier with an empty segment
 * (`"foo//parse"`). Refusing rather than guessing is deliberate: every
 * caller here uses the result to decide package IDENTITY, and a specifier
 * whose shape we do not recognize must fall back to the caller's existing
 * whole-string behavior, never to a half-parsed name.
 */
export function parseBarePackageSpecifier(
  specifier: string,
): PackageSpecifierParts | undefined {
  if (specifier.length === 0) {
    return undefined;
  }
  if (specifier.startsWith("#")) {
    return undefined;
  }
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    return undefined;
  }
  if (path.isAbsolute(specifier)) {
    return undefined;
  }
  if (isBuiltin(specifier)) {
    return undefined;
  }

  const segments = specifier.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    return undefined;
  }

  const isScoped = segments[0]?.startsWith("@") ?? false;
  const nameSegmentCount = isScoped ? 2 : 1;
  if (segments.length < nameSegmentCount) {
    return undefined;
  }

  const packageName = segments.slice(0, nameSegmentCount).join("/");
  const subpathSegments = segments.slice(nameSegmentCount);
  return {
    packageName,
    subpath: subpathSegments.length > 0 ? subpathSegments.join("/") : undefined,
  };
}

/**
 * The `package.json` `"exports"` spelling of a parsed specifier's public
 * surface: `"."` for the package root, `"./parse"` for a subpath. This is
 * the key an advisory target is anchored at, and the string carried into
 * evidence so a reader can see WHICH public surface answered.
 */
export function publicSubpathOf(parts: PackageSpecifierParts): string {
  return parts.subpath === undefined ? "." : `./${parts.subpath}`;
}

/**
 * The bare specifier that names a package instance's own INSTALL
 * DIRECTORY — the last `node_modules/<dir>` segment of its canonical root
 * (`node_modules/foo-alias` → `"foo-alias"`, `node_modules/@scope/pkg` →
 * `"@scope/pkg"`), or `undefined` for an instance that lives outside any
 * `node_modules` directory (an npm workspace member, a `file:` link).
 *
 * This is P1-A3's npm-ALIAS handle (§ A). An alias install
 * (`"foo-alias": "npm:foo@1.2.3"`) puts package `foo` at
 * `node_modules/foo-alias`, so an advisory naming `foo` resolves into it
 * from no context at all — but the install directory names the very same
 * public surface, and does so as a BARE SPECIFIER, which means it goes
 * through the real `exports`/`main` algorithm rather than around it. That
 * distinction is the whole point: see
 * {@link declaresExports} for what the alternative (an absolute path to
 * the install directory) silently does instead.
 *
 * Deliberately derives only the directory NAME and never reads the
 * package's own manifest `"name"`: identity (what package is this?) is
 * already `identifyModule`'s job, and an alias's manifest name is exactly
 * the name that does NOT resolve.
 */
export function installDirectorySpecifier(
  packageInstance: string,
): string | undefined {
  const marker = "/node_modules/";
  const index = packageInstance.lastIndexOf(marker);
  if (index === -1) {
    return undefined;
  }
  const directory = packageInstance.slice(index + marker.length);
  if (directory.length === 0) {
    return undefined;
  }
  // Re-parsing guarantees the derived string really is a well-formed bare
  // specifier (in particular that a scoped install has both segments)
  // rather than trusting the path shape.
  return parseBarePackageSpecifier(directory) ? directory : undefined;
}

/**
 * Whether the installed instance's own `package.json` declares an
 * `"exports"` field (P1-A3 § C/§ EXPORTS ENCAPSULATION).
 *
 * This gates the absolute-install-PATH probe in
 * {@link resolveAuthoritativePackageEntries}, and the reason is a real,
 * measured divergence in Node's own semantics, not a conservatism knob.
 * For a package declaring
 *
 * ```json
 * { "main": "./legacy.js", "exports": { ".": "./modern.js" } }
 * ```
 *
 * real `node` resolves `require("pkg")` to `modern.js` — `exports` has
 * authority over `main` — but resolves `require("/abs/.../node_modules/pkg")`
 * to `legacy.js`, because a PATH request is a file-system request that
 * never consults `exports` at all. `legacy.js` is therefore not part of
 * the package's public surface under any importer, and admitting it as an
 * authoritative public entry would restore, through a different door,
 * exactly the thing RWF-030 closed: a file that merely EXISTS inside the
 * package answering for what the package publishes.
 *
 * A missing or malformed `package.json` is ordinary target-project state
 * (AGENTS.md; the same discipline as `readInstalledVersion` and
 * `readInstalledPackageName`), so it degrades to `false` — the package is
 * then treated as an `exports`-less, `main`/index package, which is what
 * an unreadable manifest leaves the real resolver doing too.
 */
export function declaresExports(packageInstance: string): boolean {
  try {
    const raw: unknown = JSON.parse(
      readFileSync(path.join(packageInstance, "package.json"), "utf-8"),
    );
    return (
      typeof raw === "object" &&
      raw !== null &&
      (raw as { exports?: unknown }).exports !== undefined &&
      (raw as { exports?: unknown }).exports !== null
    );
  } catch {
    return false;
  }
}

/**
 * One authoritative public entry of one exact installed package instance:
 * the resolved file, the public surface it was reached through, and the
 * (specifier, context) probe that established it.
 *
 * `publicSubpath` and `via` exist for EXPLAINABILITY (P1-A3
 * § EXPLAINABILITY) and carry no resolution authority of their own — they
 * describe a resolution the real module resolver already performed.
 */
export interface AuthoritativePackageEntry {
  readonly resolvedFile: string;
  readonly packageInstance: string;
  readonly publicSubpath: string;
  readonly via: string;
}

export interface ResolveAuthoritativePackageEntriesOptions {
  readonly resolver: ModuleResolver;
  /**
   * The advisory's own module specifier — which may name a package ROOT
   * (`"pkg"`) or an explicit exported SUBPATH (`"pkg/parse"`). P1-A3 § D:
   * a subpath is a distinct public surface and is anchored at
   * `exports["./parse"]`, never at `"."`.
   */
  readonly requestedModuleSpecifier: string;
  /** The exact canonical install path whose public surface is being asked for. */
  readonly packageInstance: string;
  /** The scanned project's own root-relative reference context. */
  readonly referenceContext: string;
  /** Analyzed entrypoint files, used ONLY as resolution contexts. */
  readonly entrypointFiles: readonly string[];
  readonly knownPackageRoots?: KnownPackageRoots;
  /** Per-analysis memo, keyed by (instance, specifier). */
  readonly memo?: Map<string, AuthoritativePackageEntry[]>;
}

/**
 * The package's AUTHORITATIVE PUBLIC ENTRIES for one exact installed
 * instance and one requested public surface — the only files an advisory
 * target may be anchored at (P1-A2/RWF-030, extended by P1-A3).
 *
 * ## What this is
 *
 * The entry is never guessed from a filename and never found by scanning
 * the package for a file that happens to export the advisory's name.
 * It asks the SAME resolver the call graph itself used, with a bare
 * specifier, and lets the existing Node/TypeScript module-resolution
 * semantics answer: `exports` (string shorthand, `"."`, explicit
 * subpaths, conditional branches, and whatever wildcard support the
 * resolver itself has), `main`, the `index` fallback, and the file/package
 * `type` scope. VulnTrace adds no package-resolution semantics of its own
 * — a claim this module's own differential oracle
 * (`package-entry.differential-oracle.test.ts`) checks against real `node`
 * rather than against itself.
 *
 * ## The probe set
 *
 * A package can have more than one public entry file for the same public
 * surface (a conditional export is a different file under `require` than
 * under `import`), and which one is real depends on the importer. So this
 * probes a small, FIXED, fully enumerated set of (specifier, context)
 * pairs and returns every distinct file that lands inside exactly this
 * instance:
 *
 * - **contexts**: each entrypoint file, sorted, then `referenceContext`,
 *   then the instance's own `package.json`. The entrypoints are what make
 *   a conditional export resolve through the branch the analyzed
 *   application really uses (VT-204) — a `.cjs` entrypoint picks
 *   `require`, an `.mjs` one picks `import` — rather than a project-root
 *   context arbitrarily picking one. The instance's own `package.json` is
 *   the only context from which a NESTED install of a name that also
 *   exists at the top level can be reached at all.
 * - **specifiers**: (1) the advisory's own specifier; (2) the instance's
 *   INSTALL DIRECTORY as a bare specifier, plus the requested subpath —
 *   {@link installDirectorySpecifier}, which is what keeps an npm-ALIASED
 *   install resolvable while still going THROUGH `exports`; and (3) the
 *   instance's absolute install path — but ONLY when the instance declares
 *   no `exports` (see {@link declaresExports} for the measured Node
 *   divergence that makes this gate a soundness requirement, not a
 *   preference). (3) exists for instances outside any `node_modules`
 *   directory, where (2) does not apply.
 *
 * Returning the UNION rather than one winner is deliberate and unchanged
 * from P1-A2: every member is a genuine public entry under some real
 * resolution context, so the union cannot admit a non-published file; and
 * it means no answer depends on which probe ran first, on graph traversal
 * order, or on file enumeration order. The union is safe only because an
 * entry contributes a target ONLY when the call graph contains a real node
 * for that resolved file — a candidate from an inactive condition
 * materializes nothing, so an inactive branch can never manufacture a
 * negative (P1-A2's own invariant; P1-A3 § E preserves it).
 *
 * Every probe is gated on exact `packageInstance` identity, compared as a
 * whole install path by the single identity authority (`identifyModule`),
 * so no probe can answer this instance's advisory with another install's
 * entry — same-name/same-version twins and alias-vs-real side-by-side
 * installs included.
 *
 * A declaration-only or builtin resolution is skipped, never accepted: the
 * same VT-304 discipline as everywhere else — a `.d.ts` is not a runtime
 * public surface.
 *
 * ## When it returns nothing
 *
 * An empty array means the requested public surface could not be
 * established for this instance: a subpath the package does not export, a
 * package-root request against a SUBPATH-ONLY package with no `"."` entry
 * (P1-A3 § F), a wildcard pattern the resolver itself does not support, an
 * `exports` target that points at a missing or invalid file, or an alias
 * whose ownership no probe could establish. The caller MUST then refuse
 * (UNKNOWN) and never widen. There is deliberately no path from "some file
 * in this package exports this name" to "this is the advisory's target".
 */
export async function resolveAuthoritativePackageEntries(
  options: ResolveAuthoritativePackageEntriesOptions,
): Promise<AuthoritativePackageEntry[]> {
  const {
    resolver,
    requestedModuleSpecifier,
    packageInstance,
    referenceContext,
    entrypointFiles,
    knownPackageRoots,
    memo,
  } = options;

  // A rule commonly carries several targets naming the same module, and a
  // project commonly has several entrypoints. The probe set is small and
  // bounded either way, but it is also a pure function of (instance,
  // specifier) for one analysis, and the resolver has no cache of its own
  // -- so compute it once per analysis rather than once per target.
  // NUL-separated: an install path and a module specifier can both
  // contain any ordinary character, so a printable separator could
  // collide two genuinely different keys into one.
  const memoKey = `${packageInstance}\u0000${requestedModuleSpecifier}`;
  const cached = memo?.get(memoKey);
  if (cached) {
    return cached;
  }

  const parts = parseBarePackageSpecifier(requestedModuleSpecifier);
  const publicSubpath = parts ? publicSubpathOf(parts) : ".";

  const contexts = [
    ...[...entrypointFiles].sort(),
    referenceContext,
    path.join(packageInstance, "package.json"),
  ];

  const specifiers = new Set<string>([requestedModuleSpecifier]);

  // The install-directory substitution is an ALIAS handle, and it is gated
  // on OWNERSHIP, never on path shape: the instance's own manifest must
  // declare the advisory's package name. That is the package itself saying
  // "I am `foo`" -- npm writes exactly that for an alias install
  // (`"foo-alias": "npm:foo@1.2.3"` installs a package whose manifest name
  // is `foo`). Without this gate, any instance would answer a request for
  // ANY package name with its own root entry, because the substituted
  // specifier resolves into the instance by construction and the
  // instance-identity check below would pass trivially. Two same-basename
  // packages under different scopes (`@scope/pkg` vs `@other/pkg`) are the
  // shape that makes that concrete.
  const installDirectory = installDirectorySpecifier(packageInstance);
  const manifestName = readInstalledPackageName(packageInstance);
  if (
    installDirectory &&
    parts &&
    manifestName !== undefined &&
    manifestName === parts.packageName
  ) {
    specifiers.add(
      parts.subpath === undefined
        ? installDirectory
        : `${installDirectory}/${parts.subpath}`,
    );
  }

  // The absolute-install-PATH probe bypasses `exports` entirely in real
  // Node (see `declaresExports`), so it is admissible only for a package
  // that declares none -- there, a path request and a bare request agree
  // by construction, both landing on `main`/`index`.
  if (!declaresExports(packageInstance)) {
    specifiers.add(
      parts?.subpath === undefined
        ? packageInstance
        : path.join(packageInstance, parts.subpath),
    );
  }

  const byResolvedFile = new Map<string, AuthoritativePackageEntry>();
  for (const specifier of specifiers) {
    for (const context of contexts) {
      const resolution = await resolver.resolve(specifier, context);
      if (resolution.kind !== "resolved") {
        continue;
      }
      if (
        identifyModule(resolution.resolvedFileName, knownPackageRoots)
          .packageInstance !== packageInstance
      ) {
        continue;
      }
      // First probe to reach a given file wins the `via` label only; the
      // FILE is what carries authority, and the probe order is fixed, so
      // this cannot change which files are returned.
      if (!byResolvedFile.has(resolution.resolvedFileName)) {
        byResolvedFile.set(resolution.resolvedFileName, {
          resolvedFile: resolution.resolvedFileName,
          packageInstance,
          publicSubpath,
          via: `specifier "${specifier}" from "${context}"`,
        });
      }
    }
  }

  const entries = [...byResolvedFile.values()].sort((a, b) =>
    a.resolvedFile < b.resolvedFile
      ? -1
      : a.resolvedFile > b.resolvedFile
        ? 1
        : 0,
  );
  memo?.set(memoKey, entries);
  return entries;
}
