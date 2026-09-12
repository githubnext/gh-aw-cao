import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const suites = [
  {
    name: "root",
    manifest: "aw.yml",
    testPattern: "root package",
    prefixes: [
      ".github/aw/cao-evolution/graders/",
      ".github/aw/dependabot/graders/",
      ".github/aw/optimization/graders/",
      ".github/workflows/graders/aw-failures-",
      ".github/workflows/graders/aw-maintenance-",
      ".github/workflows/graders/dependabot-",
      ".github/workflows/graders/optimization-",
      ".github/workflows/shared/",
    ],
  },
  {
    name: "activity",
    manifest: "activity/aw.yml",
    testPattern: "focused activity package contract",
    prefixes: [".github/workflows/activity."],
  },
  {
    name: "CAO Evolution",
    manifest: "cao-evolution/aw.yml",
    testPattern: "focused CAO Evolution package contract",
    prefixes: [
      ".github/aw/cao-evolution/graders/",
      ".github/workflows/graders/aw-failures-",
      ".github/workflows/graders/aw-maintenance-",
      ".github/workflows/aw-failures-",
      ".github/workflows/aw-maintenance-compiler-",
      ".github/workflows/cao-evolution",
      ".github/workflows/shared/",
    ],
  },
  {
    name: "EU CRA",
    manifest: "eu-cra-compliance/aw.yml",
    testPattern: "focused EU CRA package contract",
    prefixes: [
      ".github/aw/eu-cra-compliance/graders/",
      ".github/workflows/eu-cra-compliance",
      ".github/workflows/graders/eu-cra-compliance",
      ".github/workflows/shared/",
    ],
  },
  {
    name: "UK AI Advisory",
    manifest: "uk-ai-advisory/aw.yml",
    testPattern: "focused UK AI Advisory package contract",
    prefixes: [
      ".github/workflows/shared/",
      ".github/workflows/uk-ai-advisory",
    ],
  },
  {
    name: "SelfCare",
    manifest: "self-care/aw.yml",
    testPattern: "focused SelfCare package contract",
    prefixes: [
      ".github/aw/self-care/graders/",
      ".github/workflows/graders/self-care-",
      ".github/workflows/self-care",
      ".github/workflows/shared/",
    ],
  },
  {
    name: "Software Development Practices",
    manifest: "software-development-practices/aw.yml",
    testPattern: "focused Software Development Practices package contract",
    prefixes: [
      ".github/aw/software-development-practices/graders/",
      ".github/workflows/graders/software-development-practices-",
      ".github/workflows/shared/",
      ".github/workflows/software-development-practices",
    ],
  },
  {
    name: "dashboard",
    manifest: "dashboard/aw.yml",
    testPattern: "dashboard package contract|--force restores dashboard",
    prefixes: [".github/workflows/dashboard-"],
  },
  {
    name: "Dependabot",
    manifest: "dependabot/aw.yml",
    testPattern: "update replaces",
    prefixes: [
      ".github/aw/dependabot/graders/",
      ".github/workflows/graders/dependabot-",
      ".github/workflows/dependabot",
      ".github/workflows/shared/",
    ],
  },
];

function sourcePath(manifest, source) {
  if (source.startsWith(".github/")) return source;
  return posix.normalize(posix.join(posix.dirname(manifest), source));
}

function resourceSourcePath(manifest, source) {
  return posix.normalize(posix.join(posix.dirname(manifest), source));
}

function packageSources(root, suite) {
  const sources = [];
  const visited = new Set();
  const collect = (manifestPath) => {
    if (visited.has(manifestPath)) return;
    visited.add(manifestPath);
    sources.push(manifestPath);
    const manifest = parse(readFileSync(join(root, manifestPath), "utf8"));
    for (const entry of manifest.includes ?? []) {
      const source = sourcePath(manifestPath, typeof entry === "string" ? entry : entry.source);
      if (typeof entry === "string" && posix.basename(source) === "aw.yml") {
        collect(source);
      } else {
        sources.push(source);
      }
    }
    for (const entry of manifest.resources ?? []) {
      sources.push(resourceSourcePath(manifestPath, entry.source));
    }
  }
  collect(suite.manifest);
  return sources;
}

export function selectPackageLifecycleSuites(changedFiles, root = process.cwd()) {
  if (changedFiles === null) return suites.map(({ name, testPattern }) => ({ name, "test-pattern": testPattern }));

  const normalized = changedFiles.map((file) => file.replaceAll("\\", "/"));
  if (normalized.some((file) => [
    "scripts/package-lifecycle-matrix.mjs",
    "tests/integration/package-lifecycle.test.mjs",
  ].includes(file))) {
    return selectPackageLifecycleSuites(null, root);
  }
  return suites
    .filter((suite) => {
      const packageDirectory = posix.dirname(suite.manifest);
      const prefixes = packageDirectory === "."
        ? suite.prefixes
        : [`${packageDirectory}/`, ...suite.prefixes];
      if (normalized.some((file) => file === suite.manifest || prefixes.some((prefix) => file.startsWith(prefix)))) {
        return true;
      }
      const sources = new Set(packageSources(root, suite));
      return normalized.some((file) => sources.has(file));
    })
    .map(({ name, testPattern }) => ({ name, "test-pattern": testPattern }));
}

function changedFiles(base, head, root) {
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", base, head], {
    cwd: root,
    encoding: "utf8",
  }).trim().split("\n").filter(Boolean);
}

const invokedPath = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = process.argv[2] === "--all"
    ? null
    : changedFiles(process.argv[2], process.argv[3], root);
  process.stdout.write(JSON.stringify({ include: selectPackageLifecycleSuites(files, root) }));
}
