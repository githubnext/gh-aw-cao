import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const modulePrefix = "github.com/githubnext/gh-aw-cao/server/";
const minimumPercent = 80;

export function checkGoCoverage(changedFiles, profile) {
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
  try {
    const { PR_BASE_SHA: base, PR_HEAD_SHA: head } = process.env;
    if (!base || !head || !process.argv[2]) throw new Error("Base SHA, head SHA, and coverage profile are required");
    const changedFiles = execFileSync(
      "git", ["diff", "--name-only", "--diff-filter=ACMR", "-z", base, head, "--", "server/"],
      { encoding: "utf8" },
    ).split("\0").filter(Boolean);
    const results = checkGoCoverage(changedFiles, readFileSync(process.argv[2], "utf8"));
    for (const { file, total, covered, passed } of results) {
      console.log(`${passed ? "PASS" : "FAIL"} ${file}: ${total ? (covered * 100 / total).toFixed(1) + "%" : "no coverage data"} (${covered}/${total} statements)`);
    }
    if (!results.length) console.log("No modified non-test Go files to check.");
    if (results.some(({ passed }) => !passed)) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
