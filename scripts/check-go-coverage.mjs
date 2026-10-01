import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const modulePrefix = "github.com/githubnext/gh-aw-cao/server/";
const minimumPercent = 80;
const root = path.resolve(import.meta.dirname, "..");

export function changedGoFiles(baseRef, cwd = root) {
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let mergeBase;
  try {
    mergeBase = git("merge-base", baseRef, "HEAD").trim();
  } catch {
    throw new Error(`Cannot find a local merge base with ${baseRef}; fetch the base branch or set GO_COVERAGE_BASE_REF`);
  }
  const names = [
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", mergeBase, "HEAD", "--", "server/"],
    ["diff", "--name-only", "--diff-filter=ACMR", "-z", "HEAD", "--", "server/"],
    ["ls-files", "--others", "--exclude-standard", "-z", "--", "server/"],
  ];
  return [...new Set(names.flatMap((args) => git(...args).split("\0").filter(Boolean)))]
    .filter((file) => file.startsWith("server/") && file.endsWith(".go") && !file.endsWith("_test.go"))
    .filter((file) => existsSync(path.join(cwd, file)));
}

export function checkGoCoverage(changedFiles, profile) {
  if (!/^mode: (set|count|atomic)\r?$/.test(profile.split("\n", 1)[0])) {
    throw new Error("Invalid Go coverage profile header");
  }
  const blocks = new Map();
  for (const line of profile.split(/\r?\n/).slice(1)) {
    if (!line) continue;
    const match = /^(.+):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
    if (!match || !match[1].startsWith(modulePrefix)) {
      throw new Error(`Invalid Go coverage profile entry: ${line}`);
    }
    const file = `server/${match[1].slice(modulePrefix.length)}`;
    const key = `${file}:${match[2]}`;
    const statements = Number(match[3]);
    const count = Number(match[4]);
    const previous = blocks.get(key);
    if (previous && previous.statements !== statements) throw new Error(`Inconsistent Go coverage block: ${key}`);
    blocks.set(key, { file, statements, covered: count > 0 || (previous?.covered ?? false) });
  }
  const files = new Map();
  for (const { file, statements, covered } of blocks.values()) {
    const totals = files.get(file) ?? { total: 0, covered: 0 };
    totals.total += statements;
    if (covered) totals.covered += statements;
    files.set(file, totals);
  }

  const results = [];
  for (const file of changedFiles) {
    if (!file.startsWith("server/") || !file.endsWith(".go") || file.endsWith("_test.go")) continue;
    const { total = 0, covered = 0 } = files.get(file) ?? {};
    results.push({ file, total, covered, passed: total > 0 && covered * 100 >= minimumPercent * total });
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let directory;
  try {
    const baseRef = process.env.GO_COVERAGE_BASE_REF || "origin/main";
    const changedFiles = changedGoFiles(baseRef);
    if (!changedFiles.length) {
      console.log("No modified non-test Go files to check.");
      process.exit(0);
    }
    directory = mkdtempSync(path.join(tmpdir(), "cao-go-coverage-"));
    const profilePath = path.join(directory, "coverage.out");
    execFileSync("go", ["-C", "server", "test", "-coverpkg=./...", `-coverprofile=${profilePath}`, "./..."], {
      cwd: root,
      stdio: "inherit",
    });
    const results = checkGoCoverage(changedFiles, readFileSync(profilePath, "utf8"));
    for (const { file, total, covered, passed } of results) {
      console.log(`${passed ? "PASS" : "FAIL"} ${file}: ${total ? (covered * 100 / total).toFixed(1) + "%" : "no coverage data"} (${covered}/${total} statements)`);
    }
    if (results.some(({ passed }) => !passed)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}
