import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { isRepository } from "./common.mjs";

const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const zero = "0".repeat(40);

export function parseGitChanges(bytes) {
  const fields = bytes.toString("utf8").split("\0");
  const commits = [];
  const seen = new Set();
  let current;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i].trimStart();
    if (!field) continue;
    if (field === "VALUE-COMMIT") {
      const commit = fields[++i], parents = fields[++i].split(" ").filter(Boolean), timestamp = fields[++i];
      if (!sha(commit) || !parents.every(sha) || !Number.isFinite(Date.parse(timestamp))) {
        throw new Error("Malformed immutable Git history");
      }
      current = { commit, parents, at: new Date(timestamp).toISOString().replace(".000Z", "Z"), changes: [] };
      if (seen.has(commit)) throw new Error("Duplicate immutable Git history commit");
      seen.add(commit);
      commits.push(current);
    } else if (field.startsWith(":")) {
      const match = field.match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([ADMT])$/);
      const file = fields[++i];
      if (!current || !match || !file || file.includes("\0")) throw new Error("Malformed immutable Git change");
      const [, beforeMode, afterMode, beforeBlob, afterBlob, status] = match;
      current.changes.push({ path: file, beforeBlob: beforeBlob === zero ? null : beforeBlob,
        afterBlob: afterBlob === zero ? null : afterBlob, beforeMode, afterMode, status });
    } else throw new Error("Unexpected Git history record");
  }
  return commits;
}

export function gitEvidence(repository, directory) {
  if (!isRepository(repository)) throw new Error("Invalid Git evidence repository");
  const absolute = path.resolve(directory);
  mkdirSync(absolute, { recursive: true });
  const git = (args, options = {}) => execFileSync("git", ["--git-dir", absolute, ...args], {
    encoding: "utf8", timeout: 240000, maxBuffer: 128 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat" }, ...options,
  });
  const remote = `https://github.com/${repository}.git`;
  if (!existsSync(path.join(absolute, "HEAD"))) {
    if (readdirSync(absolute).length) throw new Error("Refusing to initialize a nonempty evidence directory");
    git(["init", "--bare", "--quiet"]);
    git(["remote", "add", "origin", remote]);
    git(["config", "remote.origin.promisor", "true"]);
    git(["config", "remote.origin.partialclonefilter", "blob:none"]);
  } else if (git(["config", "--get", "remote.origin.url"]).trim() !== remote
    || git(["rev-parse", "--is-bare-repository"]).trim() !== "true") {
    throw new Error("Evidence cache repository mismatch");
  }
  return {
    git,
    history(revision, baseline, since, maxCommits = 100000, paths = ["*.go"]) {
      if (![revision, baseline].every(sha) || !Number.isFinite(Date.parse(since))
        || !Number.isSafeInteger(maxCommits) || maxCommits < 1 || maxCommits > 100000
        || !Array.isArray(paths) || !paths.length || paths.length > 64
        || paths.some(value => typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 || value.includes("\0"))) {
        throw new Error("Invalid bounded Git history request");
      }
      git(["fetch", "--quiet", "--no-tags", "--filter=blob:none", `--shallow-since=${since}`, "origin", revision]);
      git(["merge-base", "--is-ancestor", baseline, revision]);
      const mainline = git(["rev-list", "--first-parent", "--max-count=100001", revision]).trim().split("\n");
      if (!mainline.includes(baseline)) throw new Error("Baseline is not in the bounded first-parent history");
      const result = parseGitChanges(git(["log", "--first-parent", "--full-history", "--raw", "--no-abbrev", "--no-renames",
        "--diff-merges=first-parent", "--format=%x00VALUE-COMMIT%x00%H%x00%P%x00%cI%x00",
        `--max-count=${maxCommits + 1}`, "-z", revision, `^${baseline}`, "--", ...paths]));
      if (result.length > maxCommits) throw new Error("Git history commit budget exhausted");
      return result.reverse();
    },
    features(blobs, analyze, { maxBlobs = 50000, maxBytes = 512 * 1024 * 1024 } = {}) {
      if (!Number.isSafeInteger(maxBlobs) || maxBlobs < 1 || maxBlobs > 200000
        || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024 * 1024) {
        throw new Error("Invalid bounded native Git acquisition budgets");
      }
      const unique = [...new Set(blobs)];
      if (!unique.every(sha) || unique.length > maxBlobs) throw new Error("Native Git blob budget exceeded");
      const features = new Map();
      let totalBytes = 0;
      for (let offset = 0; offset < unique.length; offset += 128) {
        const batch = unique.slice(offset, offset + 128);
        git(["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", "--stdin"], { input: `${batch.join("\n")}\n` });
        const bytes = git(["cat-file", "--batch"], { input: `${batch.join("\n")}\n`, encoding: null });
        let cursor = 0;
        const contents = batch.map(id => {
          const end = bytes.indexOf(10, cursor);
          const header = bytes.subarray(cursor, end).toString("ascii").split(" ");
          const size = Number(header[2]);
          if (end < 0 || header[0] !== id || header[1] !== "blob" || !Number.isSafeInteger(size)
            || size < 0 || size > 8 * 1024 * 1024) throw new Error("Invalid or oversized native Git blob");
          cursor = end + 1;
          const content = bytes.subarray(cursor, cursor + size);
          totalBytes += size;
          if (totalBytes > maxBytes) throw new Error("Native Git byte budget exceeded");
          if (content.length !== size || bytes[cursor + size] !== 10
            || createHash("sha1").update(`blob ${size}\0`).update(content).digest("hex") !== id) {
            throw new Error("Native Git blob integrity mismatch");
          }
          cursor += size + 1;
          return { id, content: new TextDecoder("utf-8", { fatal: true }).decode(content) };
        });
        if (cursor !== bytes.length) throw new Error("Unexpected native Git batch bytes");
        const values = analyze(contents);
        if (!Array.isArray(values) || values.length !== contents.length
          || values.some((value, i) => value.id !== contents[i].id)) throw new Error("Native oracle result identity mismatch");
        for (const value of values) features.set(value.id, value);
      }
      return { features, uniqueBlobs: features.size, totalBytes };
    },
  };
}
