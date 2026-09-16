/**
 * FOUNDATION F7 — the documentation reference check.
 *
 *   node scripts/check-docs.mjs
 *
 * Deliberately NARROW, and deliberately not a documentation framework
 * (F7 § 30, § 44). It answers two questions a reader would otherwise
 * answer by hitting a dead end:
 *
 * 1. Does every `npm run <script>` named in the documentation exist in
 *    `package.json`?
 * 2. Does every repository path the documentation points at exist?
 *
 * It does NOT lint prose, check external URLs (which would make the run
 * network-dependent, the exact property `test:foundation` exists to avoid)
 * or validate markdown anchors into other people's files.
 *
 * WHY THIS EXISTS. `docs/REAL-WORLD-BENCHMARK-AUDIT-V0.1.md` was cited as
 * a source by six committed files, in four different directories, and had
 * never been committed at any point in the repository's history. Six
 * citations of a document that does not exist is not a typo anyone was
 * going to notice by reading.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

/**
 * The documents under review.
 *
 * Scoped to the authoritative set plus the repository's front matter,
 * rather than every markdown file in the tree: `docs/history/`, the
 * adversarial and validation records and the per-fixture READMEs are
 * HISTORICAL records of what was true when they were written, and holding
 * them to today's filenames would either produce permanent noise or
 * pressure someone into editing a record. Where one of those cites
 * something that does not exist, the citation is annotated in place (see
 * `docs/OPEN-DEBTS.md`).
 */
const REVIEWED = [
  "README.md",
  "AGENTS.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "docs/ARCHITECTURE.md",
  "docs/SOUNDNESS-CONTRACT.md",
  "docs/SCORECARD.md",
  "docs/OPEN-DEBTS.md",
];

const scripts = new Set(
  Object.keys(
    JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"))
      .scripts,
  ),
);

const problems = [];

/** `npm run x` / `npm test` mentioned anywhere, including inside fences. */
function checkCommands(file, text) {
  for (const match of text.matchAll(/npm run ([a-z][\w:-]*)/g)) {
    if (!scripts.has(match[1])) {
      problems.push(`${file}: npm run ${match[1]} — no such script`);
    }
  }
}

/** Top-level directories a backticked path may be rooted at. */
const REPO_ROOTS = new Set([
  "src",
  "docs",
  "scripts",
  "schemas",
  "fixtures",
  "tests",
  "rules",
  "config",
  ".github",
]);

/**
 * Directories inside `src/`. The codebase refers to its own modules
 * src-relatively (`cli/scan.ts`, `domain/uncertainty.ts`) as often as it
 * does from the repository root, and both spellings should be checked.
 */
const SRC_ROOTS = new Set(
  fs
    .readdirSync(path.join(ROOT, "src"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
);

/**
 * Repository paths, from two syntaxes with two different base directories.
 *
 * A markdown link is relative to the document it sits in; a backticked
 * path names a location in the repository. Conflating the two is how a
 * checker produces a page of false positives for correct documentation.
 *
 * Backticked tokens are only checked when their first segment is a real
 * top-level directory (or a `src/` subdirectory). Documentation is full of
 * ILLUSTRATIVE paths — `pkg/other.js`, `qs/lib/index.js`,
 * `node_modules/foo` — which name a shape rather than a file here, and
 * demanding those exist would force the prose to stop using examples.
 */
function checkPaths(file, rawText) {
  // Fenced blocks are SOURCE, not references. `return lib[name](x)` is a
  // line of JavaScript, and reading it as a markdown link to a file
  // called `x` is how a link checker earns its reputation.
  const text = rawText.replace(/^```[\s\S]*?^```/gm, "");

  /** `candidate -> absolute paths any one of which satisfies it`. */
  const candidates = new Map();

  const add = (candidate, ...bases) => {
    const existing = candidates.get(candidate) ?? [];
    candidates.set(candidate, [
      ...existing,
      ...bases.map((base) => path.resolve(base, candidate)),
    ]);
  };

  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    add(target.split("#")[0], path.dirname(path.join(ROOT, file)));
  }

  for (const match of text.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim().replace(/[.,;:]$/, "");
    if (!/^[\w./@-]+$/.test(token)) continue;
    const stripped = token.replace(/\/$/, "");
    if (!stripped.includes("/")) continue;
    if (
      !/\.(ts|mts|mjs|js|json|md|yml)$/.test(stripped) &&
      !token.endsWith("/")
    ) {
      continue;
    }
    const first = stripped.split("/")[0];
    if (REPO_ROOTS.has(first)) add(stripped, ROOT);
    else if (SRC_ROOTS.has(first)) add(stripped, path.join(ROOT, "src"));
  }

  for (const [candidate, bases] of candidates) {
    // `src/domain/foo.js` is how TypeScript's own ESM imports spell
    // `src/domain/foo.ts`; accept either.
    const alternatives = bases.flatMap((resolved) => [
      resolved,
      resolved.replace(/\.js$/, ".ts"),
      resolved.replace(/\.mjs$/, ".ts"),
    ]);
    if (!alternatives.some((option) => fs.existsSync(option))) {
      problems.push(`${file}: ${candidate} — no such file`);
    }
  }
}

for (const file of REVIEWED) {
  const absolute = path.join(ROOT, file);
  if (!fs.existsSync(absolute)) {
    problems.push(`${file} — reviewed document is missing`);
    continue;
  }
  const text = fs.readFileSync(absolute, "utf-8");
  checkCommands(file, text);
  checkPaths(file, text);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.stderr.write(`\n${problems.length} broken reference(s).\n`);
  process.exit(1);
}

process.stdout.write(
  `checked ${REVIEWED.length} documents: every npm script and repository path resolves.\n`,
);
