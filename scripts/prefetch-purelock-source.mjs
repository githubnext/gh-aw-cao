import { execFileSync } from "node:child_process";

const [cache, revision] = process.argv.slice(2);
if (!cache || !/^[a-f0-9]{40}$/.test(revision ?? "")) throw new Error("Private cache and exact source revision required");
const git = (args, input) => execFileSync("git", [`--git-dir=${cache}`, ...args], {
  encoding: "utf8", timeout: 120000, maxBuffer: 8 * 1024 * 1024,
  input, env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }, stdio: ["pipe", "pipe", "pipe"],
});
if (git(["remote", "get-url", "origin"]).trim() !== "https://github.com/github/gh-aw.git") throw new Error("Public source remote mismatch");
const rows = git(["ls-tree", "-r", revision, "--", "pkg", "cmd", "internal", "go.mod", "go.sum", "actions/setup"])
  .trim().split("\n").filter(row => !row.endsWith("_test.go") && !row.includes("\tactions/setup/")
    || row.endsWith("\tactions/setup/session_parsers.go") || /\tactions\/setup\/js\/[a-z0-9_-]+\.(?:cjs|json)$/.test(row))
  .filter(row => row.startsWith("100644 "))
  .map(row => {
    const match = row.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error("Unsupported source entry");
    return { id: match[1] };
  });
if (rows.length > 5000) throw new Error("Source batch exceeds frozen read budgets");
const ids = [...new Set(rows.map(row => row.id))];
const checks = git(["cat-file", "--batch-check"], ids.join("\n") + "\n").trim().split("\n");
const missing = checks.filter(row => row.endsWith(" missing")).map(row => row.split(" ")[0]);
if (missing.some(id => !ids.includes(id))) throw new Error("Unexpected missing blob identity");
for (let at = 0; at < missing.length; at += 100) {
  git(["fetch", "--no-tags", "--no-write-fetch-head", "origin", ...missing.slice(at, at + 100)]);
}
const sizes = git(["cat-file", "--batch-check"], ids.join("\n") + "\n").trim().split("\n").map(row => {
  const match = row.match(/^[a-f0-9]{40} blob (\d+)$/);
  if (!match || Number(match[1]) > 4 * 1024 * 1024) throw new Error("Invalid fetched blob size");
  return Number(match[1]);
});
if (sizes.reduce((sum, size) => sum + size, 0) > 64 * 1024 * 1024) throw new Error("Fetched source byte budget exceeded");
console.log(JSON.stringify({ revision, sources: rows.length, fetched: missing.length }));
