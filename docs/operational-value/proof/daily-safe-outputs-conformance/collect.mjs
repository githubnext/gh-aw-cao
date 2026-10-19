import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { assess, checkerPath, compare, hash, nativeInventory, specPath, toolIdentity } from "./native-checker.mjs";
import { frozen } from "./discover.mjs";

const home = path.dirname(fileURLToPath(import.meta.url));
const sourcePaths = [
  ".github/workflows/daily-safe-outputs-conformance.md",
  ".github/workflows/daily-safe-outputs-conformance.lock.yml",
  ".github/workflows/shared/daily-audit-base.md",
  ".github/workflows/shared/daily-audit-discussion.md",
  ".github/workflows/shared/reporting.md",
  ".github/workflows/shared/otlp.md",
  checkerPath, specPath, "scripts/README-conformance.md",
];
const fixedNativePaths = [
  "pkg/workflow/safe_outputs_permissions.go",
  "pkg/workflow/safe_outputs_config_generation.go",
  "pkg/workflow/safe_outputs_config.go",
  "pkg/workflow/js/safe_outputs_tools.json",
  "pkg/workflow/cache_integrity.go",
  "actions/setup/sh/setup_cache_memory_git.sh",
  "actions/setup/sh/commit_cache_memory_git.sh",
];

export function verifyBlob(bytes, id) {
  if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== id) {
    throw new Error("Immutable Git blob mismatch");
  }
}

export function collect(cache, output = home) {
  const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    timeout: 45000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (git(["remote", "get-url", "origin"]).toString().trim() !== "https://github.com/github/gh-aw.git") {
    throw new Error("Public cache repository mismatch");
  }
  mkdirSync(path.join(output, "blobs"), { recursive: true });
  const sources = new Map(), missing = new Map();
  let readBytes = 0;
  const blob = id => {
    if (sources.has(id)) return sources.get(id);
    if (missing.has(id)) return null;
    const available = execFileSync("git", [`--git-dir=${cache}`, "cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
      input: `${id}\n`, encoding: "utf8", timeout: 10000, maxBuffer: 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    }).trim();
    if (available === `${id} missing`) {
      missing.set(id, { id, reason: "immutable-blob-not-retained-offline",
        endpoint: `repos/${frozen.repository}/git/blobs/${id}` });
      return null;
    }
    const match = available.match(/^([a-f0-9]{40}) blob (\d+)$/);
    if (!match || match[1] !== id) throw new Error("Unexpected immutable source object");
    const size = Number(match[2]);
    if (size > 4 * 1024 * 1024 || readBytes + size > 64 * 1024 * 1024) {
      missing.set(id, { id, reason: "bounded-source-closure-budget-exhausted" });
      return null;
    }
    const bytes = git(["cat-file", "blob", id]);
    verifyBlob(bytes, id);
    readBytes += bytes.length;
    const record = { id, sha256: hash(bytes), bytes: bytes.length, contentBase64: bytes.toString("base64") };
    writeJsonArchive(path.join(output, "blobs", `${id}.json.gz`), record);
    sources.set(id, record);
    return record;
  };
  const tree = commit => Object.fromEntries(git(["ls-tree", "-r", commit]).toString("utf8").trim().split("\n")
    .map(line => {
      const match = line.match(/^(\d+) blob ([a-f0-9]{40})\t(.+)$/);
      return match ? [match[3], { mode: match[1], id: match[2] }] : null;
    }).filter(Boolean));
  const frozenTree = tree(frozen.revision);
  if (frozenTree[sourcePaths[0]]?.id !== frozen.sourceBlob) throw new Error("Frozen source blob mismatch");
  const closure = sourcePaths.map(file => {
    const entry = frozenTree[file];
    if (!entry) throw new Error(`Frozen authority source missing: ${file}`);
    const record = blob(entry.id);
    if (!record) throw new Error(`Frozen authority source unavailable: ${file} (${entry.id})`);
    return { file, ...entry, sha256: record.sha256 };
  });
  const checker = Buffer.from(sources.get(frozenTree[checkerPath].id).contentBase64, "base64").toString("utf8");
  const inventory = nativeInventory(checker);
  if (new Set(inventory.map(row => row.id)).size !== inventory.length || inventory.length !== 55) {
    throw new Error("Unexpected native checker inventory");
  }
  const endpoint = Date.parse(frozen.cutoff);
  const cutoffs = Array.from({ length: 6 }, (_, i) => new Date(endpoint - (5 - i) * 7 * 86400000).toISOString().replace(".000Z", "Z"));
  const snapshots = cutoffs.map(at => {
    const commit = git(["rev-list", "--first-parent", "-1", `--before=${at}`, frozen.revision]).toString().trim();
    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Missing immutable first-parent cutoff");
    const entries = tree(commit);
    const paths = [...new Set([...Object.keys(entries).filter(file =>
      /^actions\/setup\/js\/[^/]+\.cjs$/.test(file) && !/test|_checks\.cjs$/.test(file)),
    ...fixedNativePaths])].filter(file => Object.hasOwn(entries, file)).sort();
    const files = Object.fromEntries(paths.map(file => {
      const entry = entries[file];
      if (!["100644", "100755"].includes(entry.mode)) throw new Error(`Unsupported native source mode: ${file}`);
      const record = blob(entry.id);
      return [file, { ...entry, ...(record ? {
        content: Buffer.from(record.contentBase64, "base64").toString("utf8"),
      } : {}) }];
    }));
    return {
      at, commit, treeDigest: hash(JSON.stringify(entries)), populationDigest: hash(JSON.stringify(paths)),
      paths: files,
      assessment: assess(files, inventory),
      eligibleFiles: paths.length,
      readFiles: paths.filter(file => files[file].content !== undefined).length,
      sourceProfile: Object.fromEntries([checkerPath, specPath, sourcePaths[0]].map(file => [file, entries[file]?.id ?? null])),
    };
  });
  const intervals = snapshots.slice(1).map((after, i) => ({
    windowStart: snapshots[i].at, windowEnd: after.at,
    beforeCommit: snapshots[i].commit, afterCommit: after.commit,
    ...compare(snapshots[i].assessment, after.assessment),
    coverageStatus: "partial",
  }));
  for (const snapshot of snapshots) {
    snapshot.paths = Object.fromEntries(Object.entries(snapshot.paths).map(([file, entry]) => {
      const { content, ...reference } = entry;
      return [file, reference];
    }));
  }
  const result = {
    schemaVersion: 1, frozen, closure, toolchain: toolIdentity(), inventory, snapshots, intervals,
    sourceCount: sources.size, readBytes, missing: [...missing.values()],
    scope: {
      repositoryVisibility: "public per shared identity-verified source inventory",
      acquisition: "read-only local immutable Git; no fetched source code executed",
      discovery: "whole retained surviving issue/PR candidate inventory",
      history: "six weekly immutable cutoffs over the last 35 days; earlier periods are unavailable, not zero",
      native: "independent replay of explicitly enumerated native lexical predicates; all 55 checker rules remain inventoried",
      unimplementedRules: inventory.filter(rule => !snapshots.at(-1).assessment.rows.some(row => row.rule === rule.id)),
      fullGoalCompletion: null,
      fullGoalMissing: [
        "Native structural predicates do not prove behavior, exploit resistance, target authorization, or regression safety.",
        "The frozen checker (1.29.8) is behind specification 1.29.12.",
        "Native shell control flow is not executed; per-function diagnostics are measured independently, not summary counters or a successful checker run.",
        "All unmatched checker predicates and unavailable source blobs remain open evidence scope.",
        "Independent workflow-to-remediation graph and protected creation receipts have not been acquired.",
      ],
    },
  };
  writeJsonArchive(path.join(output, "native-evidence.json.gz"), result);
  const replay = readJsonArchive(path.join(output, "native-evidence.json.gz"));
  if (hash(JSON.stringify(replay)) !== hash(JSON.stringify(result))) throw new Error("Native evidence replay mismatch");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node collect.mjs READ-ONLY-BARE-GIT-CACHE");
  const result = collect(process.argv[2]);
  console.log(JSON.stringify({
    sourceCount: result.sourceCount, readBytes: result.readBytes, missingBlobs: result.missing.length,
    snapshots: result.snapshots.map(row => ({ at: row.at, readFiles: row.readFiles, eligibleFiles: row.eligibleFiles,
      violations: row.assessment.rows.filter(r => r.status === "fail" && !r.suppressed).length })),
    intervals: result.intervals.map(row => ({ end: row.windowEnd, remediated: row.remediated.length })),
  }, null, 2));
}
