import { OsvProvider } from "../../vulnerabilities/osv-provider.js";
import type {
  PackageQuery,
  RawVulnerability,
  VulnerabilityProvider,
} from "../../domain/vulnerability.js";

/** One configured advisory, in the raw OSV shape `normalizeOsvVulnerability` accepts. */
export interface SyntheticAdvisory {
  readonly id: string;
  readonly packageName: string;
  readonly ecosystem?: string;
  readonly aliases?: readonly string[];
  readonly introduced?: string;
  readonly fixed?: string;
  readonly lastAffected?: string;
}

/** Builds the raw OSV-shaped record every harness in docs/audits/ used for its synthetic provider. */
export function syntheticAdvisory(spec: SyntheticAdvisory): RawVulnerability {
  const events: Record<string, string>[] = [];
  events.push({ introduced: spec.introduced ?? "0" });
  if (spec.fixed !== undefined) {
    events.push({ fixed: spec.fixed });
  }
  if (spec.lastAffected !== undefined) {
    events.push({ last_affected: spec.lastAffected });
  }
  return {
    id: spec.id,
    aliases: spec.aliases ?? [],
    affected: [
      {
        package: {
          ecosystem: spec.ecosystem ?? "npm",
          name: spec.packageName,
        },
        ranges: [{ type: "SEMVER", events }],
      },
    ],
    references: [],
  };
}

/**
 * A hermetic {@link VulnerabilityProvider}: every query is answered from
 * `advisories` (matched by `packageName`, ignoring `version` -- the
 * analyzer's own `matchVersion` decides applicability, never the
 * provider), with no I/O of any kind. This is the default provider for
 * every case that is not specifically about provider behavior itself
 * (pagination, malformed records, cache semantics -- see
 * {@link injectedOsvProvider} for those).
 */
export function syntheticProvider(
  advisories: readonly SyntheticAdvisory[],
): VulnerabilityProvider {
  const byPackage = new Map<string, RawVulnerability[]>();
  for (const advisory of advisories) {
    const list = byPackage.get(advisory.packageName) ?? [];
    list.push(syntheticAdvisory(advisory));
    byPackage.set(advisory.packageName, list);
  }
  const provider = {
    queryPackage(query: PackageQuery): Promise<readonly RawVulnerability[]> {
      return Promise.resolve(byPackage.get(query.name) ?? []);
    },
  };
  SYNTHETIC_SPECS.set(provider, {
    // Everything the provider will ever answer, fixed now: `byPackage` is
    // private to this closure and built once.
    spec: JSON.stringify([...byPackage.entries()]),
    queryPackage: provider.queryPackage,
  });
  return provider;
}

/** Each {@link syntheticProvider}'s answers, as data (BL-089). */
const SYNTHETIC_SPECS = new WeakMap<
  object,
  { readonly spec: string; readonly queryPackage: unknown }
>();

/**
 * BL-089 — what a provider answers, as a string, when that is known as
 * data: only for a provider {@link syntheticProvider} built and nobody has
 * changed since (still exactly its one own method, the same function, a
 * plain object). `undefined` for every other provider, whose answers are
 * code, so that a scan under it is never reused
 * (`scan-reuse.ts`).
 */
export function syntheticProviderSpec(
  provider: VulnerabilityProvider,
): string | undefined {
  const entry = SYNTHETIC_SPECS.get(provider);
  if (entry === undefined) return undefined;
  const keys = Reflect.ownKeys(provider);
  if (
    keys.length !== 1 ||
    keys[0] !== "queryPackage" ||
    provider.queryPackage !== entry.queryPackage ||
    Object.getPrototypeOf(provider) !== Object.prototype
  ) {
    return undefined;
  }
  return entry.spec;
}

/**
 * The REAL {@link OsvProvider} implementation, driven only by an injected
 * `fetchImpl` -- never the ambient global `fetch`, so this helper is
 * structurally incapable of making a network call (HERMETIC, task H-0
 * step 2). Use this, not {@link syntheticProvider}, for cases that are
 * about the provider's own OSV-envelope handling: pagination
 * (`next_page_token`), malformed records, or the request shape itself
 * (see docs/audits/2026-09-premise-sweep-round-2.md's `intake2.ts`
 * PRM-65 reproduction, which this mirrors).
 *
 * `fetchImpl` has no default: TypeScript refuses a call that omits it,
 * which is what makes "this helper never touches the network" a
 * structural property of its signature rather than a documentation
 * promise.
 */
export function injectedOsvProvider(fetchImpl: typeof fetch): OsvProvider {
  return new OsvProvider({ fetchImpl });
}
