import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const repository = "github/gh-aw";
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const workflowPath = ".github/workflows/smoke-copilot-sdk.md";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const sha = value => /^[a-f0-9]{40}$/.test(value ?? "");

export function discoverClosure(entities) {
  const byNumber = new Map(entities.map(row => [row.number, row]));
  const reverse = new Map();
  for (const row of entities) for (const number of row.relatedCandidates ?? []) {
    if (!reverse.has(number)) reverse.set(number, []);
    reverse.get(number).push(row.number);
  }
  const direct = entities.filter(row => row.workflowReference?.workflowId === "smoke-copilot-sdk"
    || row.unverifiedWorkflowId === "smoke-copilot-sdk"
    || row.workflowReference?.additionalRunReferences?.some(ref => ref.workflowId === "smoke-copilot-sdk"));
  const selected = new Set(direct.map(row => row.number));
  const queue = [...selected];
  for (let at = 0; at < queue.length; at++) {
    const number = queue[at];
    for (const next of [...(byNumber.get(number)?.relatedCandidates ?? []), ...(reverse.get(number) ?? [])]) {
      if (!selected.has(next)) { selected.add(next); queue.push(next); }
    }
  }
  return {
    directNumbers: direct.map(row => row.number).sort((a, b) => a - b),
    entities: [...selected].filter(number => byNumber.has(number)).sort((a, b) => a - b)
      .map(number => byNumber.get(number)),
    absentReferences: [...selected].filter(number => !byNumber.has(number)).sort((a, b) => a - b),
    limitation: "Forward/reverse body-reference discovery, including peers through absent references; not accepted graph edges, protected creation receipts or native outcomes.",
  };
}

export function collectSources(gitDirectory) {
  const responses = [], sources = [], missing = [], seen = new Set();
  const git = args => {
    try {
      const bytes = execFileSync("git", [`--git-dir=${gitDirectory}`, ...args], {
        env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "pipe"], timeout: 45000, maxBuffer: 8 * 1024 * 1024,
      });
      responses.push({ args, status: 0, stdoutBase64: bytes.toString("base64"), stderr: "" });
      return bytes;
    } catch (error) {
      if (error.status !== 128) throw error;
      responses.push({ args, status: error.status, stdoutBase64: Buffer.from(error.stdout ?? "").toString("base64"),
        stderr: String(error.stderr ?? "") });
      return null;
    }
  };
  if (git(["remote", "get-url", "origin"])?.toString().trim() !== `https://github.com/${repository}.git`) {
    throw new Error("Unexpected source-cache repository identity");
  }
  const read = (commit, file) => {
    const key = `${commit}:${file}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (!sha(commit) || !/^[\w./-]+$/.test(file) || file.split("/").some(x => x === "..")) {
      throw new Error("Unsafe immutable source reference");
    }
    const tree = git(["ls-tree", commit, "--", file]);
    const entry = tree?.toString().trim().match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!entry || entry[2] !== file) {
      missing.push({ commit, path: file, gitBlob: null, reason: tree === null ? "Tree unavailable" : "Absent or unsupported source mode" });
      return;
    }
    const bytes = git(["cat-file", "blob", entry[1]]);
    if (bytes === null) {
      missing.push({ commit, path: file, gitBlob: entry[1], reason: "Exact blob unavailable locally; no lazy fetch attempted" });
      return;
    }
    if (bytes.length > 4 * 1024 * 1024 || gitBlob(bytes) !== entry[1]) throw new Error("Immutable source mismatch or over budget");
    const content = bytes.toString("utf8");
    sources.push({ commit, path: file, gitBlob: entry[1], sha256: digest(bytes), contentBase64: bytes.toString("base64") });
    if (commit !== revision) return;
    if (file.endsWith(".md")) {
      const imports = content.match(/^imports:\s*\n((?:[ \t]+.*\n)+)/m)?.[1] ?? "";
      for (const match of imports.matchAll(/^\s+-\s+([\w./-]+\.md)\s*$/gm)) read(commit, path.posix.join(path.posix.dirname(file), match[1]));
    }
    if (/\.(cjs|mjs|js)$/.test(file)) {
      for (const match of content.matchAll(/require\(["'](\.[^"']+)["']\)|from\s+["'](\.[^"']+)["']/g)) {
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1] ?? match[2]));
        read(commit, path.posix.extname(target) ? target : `${target}.cjs`);
      }
    }
  };
  read(revision, workflowPath);
  read(revision, workflowPath.replace(/\.md$/, ".lock.yml"));
  for (const file of [
    "actions/setup/js/copilot_sdk_driver.cjs",
    "actions/setup/js/copilot_sdk_session.cjs",
    "actions/setup/js/copilot_sdk_permissions.cjs",
    "actions/setup/js/copilot_sdk_tool_config.cjs",
    "actions/setup/js/copilot_sdk_tool_budget.cjs",
    "docs/src/content/docs/specs/copilot-sdk-driver-specification.md",
  ]) read(revision, file);
  const log = git(["log", revision, "--format=%H %P %cI", "--diff-filter=A", "--", workflowPath]);
  const candidates = (log?.toString().trim().split("\n") ?? []).filter(Boolean).map(line => {
    const [commit, ...rest] = line.split(" ");
    const timestamp = rest.pop();
    return { commit, parents: rest, timestamp };
  });
  for (const candidate of candidates) {
    read(candidate.commit, workflowPath);
    read(candidate.commit, workflowPath.replace(/\.md$/, ".lock.yml"));
    for (const parent of candidate.parents) {
      read(parent, workflowPath);
      read(parent, workflowPath.replace(/\.md$/, ".lock.yml"));
    }
  }
  return { repository, repositoryId: 1036865607, revision, cutoff, sources, missing, responses,
    adoptionCandidates: candidates, adoption: null,
    adoptionMissingReason: "Addition metadata is discovery only until complete source, compiled workflow and parent contents establish actual introduction and rule applicability." };
}

export function produce({ gitDirectory, historyDirectory, outputDirectory }) {
  const source = collectSources(gitDirectory);
  const { index, entities } = readOutputHistory(historyDirectory);
  if (index.repository !== repository || index.repositoryId !== 1036865607 || index.sourceRevision !== revision
    || index.until !== cutoff || !index.complete || index.partitions.length !== 346 || entities.length !== 58048) {
    throw new Error("Frozen complete history identity/totals mismatch");
  }
  const discovery = { schemaVersion: 1, index, ...discoverClosure(entities) };
  mkdirSync(outputDirectory, { recursive: true });
  const options = { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512, spacing: 0 };
  const files = [
    ...writeJsonArchive(path.join(outputDirectory, "source.json.gz"), source, options),
    ...writeJsonArchive(path.join(outputDirectory, "discovery.json.gz"), discovery, options),
  ];
  return { sourceCount: source.sources.length, missingSources: source.missing.length,
    directCandidates: discovery.directNumbers.length, closureCandidates: discovery.entities.length,
    absentReferences: discovery.absentReferences.length, files };
}

export function importCompiledPacket(directory, outputDirectory, historical = false) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  const expectedManifest = historical ? "f149203e66f2ec72111f3ff55ee8a57cb73b560c3b92312a2f1b655fed0baa0c"
    : "efa9349fc0c7caebdc006f42eb0c4576abef8a9ff5f3eb1d99707b128445c27a";
  const expectedBlob = historical ? "d3868b2f9d1c637afbdf6895ad8b33ae0db88f3e" : "d7144cb8e1a7a8fe52b8548bd7b290f95bc5b677";
  if (digest(manifestBytes) !== expectedManifest) {
    throw new Error("Supplied compiled-packet manifest mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  const receipt = manifest.receipts.find(row => row.workflow === "smoke-copilot-sdk");
  if (manifest.repository !== repository || manifest.repositoryId !== 1036865607
    || receipt.sha !== expectedBlob
    || receipt.status !== 200 || receipt.method !== "GET") throw new Error("Compiled receipt scope mismatch");
  const original = readFileSync(path.join(directory, receipt.response));
  const bytes = readFileSync(path.join(directory, receipt.blob));
  const response = JSON.parse(original);
  if (digest(original) !== receipt.bodySha256 || original.length !== receipt.bodyBytes
    || digest(bytes) !== receipt.blobSha256 || bytes.length !== receipt.blobBytes
    || gitBlob(bytes) !== receipt.sha || response.sha !== receipt.sha || response.encoding !== "base64"
    || response.size !== bytes.length || !Buffer.from(response.content, "base64").equals(bytes)) {
    throw new Error("Compiled original response/blob mismatch");
  }
  return writeJsonArchive(path.join(outputDirectory, historical ? "run-compiled-source.json.gz" : "compiled-source.json.gz"), {
    repository, repositoryId: 1036865607, revision: historical ? "354b5c3423ea95046f4db235f9fea7bb2885aaa8" : revision,
    path: workflowPath.replace(/\.md$/, ".lock.yml"),
    gitBlob: receipt.sha, sha256: digest(bytes), contentBase64: bytes.toString("base64"),
    receipt, responseBase64: original.toString("base64"),
    parentManifestSha256: digest(manifestBytes),
    interpretation: "Exact SDK-only original and response retained; manifest's unrelated workflow contents not imported.",
  }, { maxDecodedBytes: 16 * 1024 * 1024, maxParts: 128, spacing: 0 });
}

export function importHostPacket(directory, outputDirectory, gitDirectory) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  if (digest(manifestBytes) !== "de5bc11972995560907ecb455a734dbd8a715b8805c1e3554195995370e9d986") {
    throw new Error("Protected attempt-log manifest mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  const receipt = manifest.requests.find(row => row.workflow === "smoke-copilot-sdk");
  if (manifest.repository !== repository || manifest.repositoryId !== 1036865607 || receipt.status !== 200
    || receipt.endpoint !== "repos/github/gh-aw/actions/runs/38984382289/attempts/1/logs"
    || receipt.file !== path.basename(receipt.file)) throw new Error("Protected attempt-log scope mismatch");
  const bytes = readFileSync(path.join(directory, receipt.file));
  if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256
    || receipt.sha256 !== "71a55adf3296c216aa2ff9699aca6f8f10373e8eaebcbccda7d57c4086f58847") {
    throw new Error("Protected attempt ZIP original mismatch");
  }
  const args = ["ls-tree", "354b5c3423ea95046f4db235f9fea7bb2885aaa8", "--",
    workflowPath, workflowPath.replace(/\.md$/, ".lock.yml"),
    ".github/workflows/shared/reporting.md", ".github/workflows/shared/smoke-test-brevity.md",
    "actions/setup/js/copilot_sdk_driver.cjs", "actions/setup/js/copilot_sdk_session.cjs"];
  const tree = execFileSync("git", [`--git-dir=${gitDirectory}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"], timeout: 45000, maxBuffer: 1024 * 1024,
  });
  return writeJsonArchive(path.join(outputDirectory, "protected-host-originals.json.gz"), {
    repository, repositoryId: 1036865607, runId: 38984382289, attempt: 1,
    headSha: "354b5c3423ea95046f4db235f9fea7bb2885aaa8", receipt,
    contentBase64: bytes.toString("base64"), parentManifestSha256: digest(manifestBytes),
    sourceBindings: { args, status: 0, stdoutBase64: tree.toString("base64") },
  }, { maxDecodedBytes: 16 * 1024 * 1024, maxParts: 128, spacing: 0 });
}

export function importAdoptionPacket(directory, outputDirectory) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  if (digest(manifestBytes) !== "610f47d3279fb279cff0017301864c6e0ca72fa70c6bc5f41a528fef5a23e101") {
    throw new Error("Adoption original manifest mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  const originals = manifest.receipts.map(receipt => {
    if (receipt.workflow !== "smoke-copilot-sdk" || receipt.status !== 200
      || receipt.blob !== path.basename(receipt.blob) || receipt.response !== path.basename(receipt.response)) {
      throw new Error("Adoption original receipt scope mismatch");
    }
    const content = readFileSync(path.join(directory, receipt.blob));
    const response = readFileSync(path.join(directory, receipt.response));
    if (digest(content) !== receipt.blobSha256 || content.length !== receipt.blobBytes
      || gitBlob(content) !== receipt.sha || digest(response) !== receipt.bodySha256
      || response.length !== receipt.bodyBytes || !Buffer.from(JSON.parse(response).content, "base64").equals(content)) {
      throw new Error("Adoption original bytes mismatch");
    }
    return { receipt, contentBase64: content.toString("base64"), responseBase64: response.toString("base64") };
  });
  return writeJsonArchive(path.join(outputDirectory, "adoption-originals.json.gz"), {
    repository, repositoryId: 1036865607, parentManifestSha256: digest(manifestBytes), originals,
  }, { maxDecodedBytes: 16 * 1024 * 1024, maxParts: 128, spacing: 0 });
}

export function importCandidatePacket(directory, outputDirectory) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  if (digest(manifestBytes) !== "c89c134d65b70d8bf9c603cd85cc731b1e53088282b5470771d852a8105abeed") {
    throw new Error("Supplied native-candidate manifest mismatch");
  }
  const manifest = JSON.parse(manifestBytes);
  if (manifest.repository !== repository || manifest.repositoryId !== 1036865607 || manifest.complete !== true) {
    throw new Error("Native-candidate packet scope mismatch");
  }
  const requests = manifest.requests.filter(row => row.workflow === "smoke-copilot-sdk").map(receipt => {
    if (receipt.status !== 200 || receipt.method !== "GET" || receipt.file !== path.basename(receipt.file)) {
      throw new Error("Invalid native-candidate acquisition receipt");
    }
    const bytes = readFileSync(path.join(directory, receipt.file));
    if (bytes.length !== receipt.bytes || digest(bytes) !== receipt.sha256) throw new Error("Native-candidate original mismatch");
    return { receipt, contentBase64: bytes.toString("base64") };
  });
  if (requests.length !== 4) throw new Error("Incomplete SDK candidate packet");
  const document = suffix => JSON.parse(Buffer.from(requests.find(row => row.receipt.endpoint.endsWith(suffix))?.contentBase64 ?? "", "base64"));
  const run = document("/38984382289"), jobs = document("/attempts/1/jobs?per_page=100");
  const artifacts = document("/artifacts?per_page=100");
  const zip = requests.find(row => row.receipt.endpoint.endsWith("/12081509894/zip"));
  if (run.id !== 38984382289 || run.run_attempt !== 1 || run.repository?.id !== 1036865607
    || run.repository?.full_name !== repository || run.repository?.private !== false
    || run.head_sha !== "354b5c3423ea95046f4db235f9fea7bb2885aaa8"
    || run.path !== ".github/workflows/smoke-copilot-sdk.lock.yml" || run.event !== "schedule"
    || jobs.total_count !== jobs.jobs?.length || !jobs.jobs.some(row => row.id === 117252704344 && row.name === "agent")
    || artifacts.total_count !== artifacts.artifacts?.length) throw new Error("Native candidate run/job/artifact identity mismatch");
  const artifact = artifacts.artifacts.find(row => row.id === 12081509894);
  if (artifact?.name !== "agent" || artifact.workflow_run?.id !== run.id
    || artifact.workflow_run?.head_sha !== run.head_sha || artifact.digest !== `sha256:${zip?.receipt.sha256}`
    || artifact.size_in_bytes !== zip?.receipt.bytes
    || zip?.receipt.sha256 !== "5f0ef590e353a92100110e24de01375dee177e74a1f06cf067d5a7c0e17d1596") {
    throw new Error("Native original ZIP provider digest mismatch");
  }
  return writeJsonArchive(path.join(outputDirectory, "candidate-originals.json.gz"), {
    repository, repositoryId: 1036865607, runId: run.id, attempt: run.run_attempt, headSha: run.head_sha,
    parentManifestSha256: digest(manifestBytes), requests,
    interpretation: "Verified original acquisition and provider ZIP identity; neither implies independent native-effect acceptance.",
  }, { maxDecodedBytes: 16 * 1024 * 1024, maxParts: 128, spacing: 0 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args[0] === "--adoption-packet" && args.length === 2) {
    console.log(JSON.stringify(importAdoptionPacket(args[1], path.join(root, "docs/operational-value/proof/smoke-copilot-sdk"))));
    process.exit(0);
  }
  if (args[0] === "--host-packet" && args.length === 3) {
    console.log(JSON.stringify(importHostPacket(args[1], path.join(root, "docs/operational-value/proof/smoke-copilot-sdk"), args[2])));
    process.exit(0);
  }
  if (args[0] === "--run-source-packet" && args.length === 2) {
    console.log(JSON.stringify(importCompiledPacket(args[1], path.join(root, "docs/operational-value/proof/smoke-copilot-sdk"), true)));
    process.exit(0);
  }
  if (args[0] === "--candidate-packet" && args.length === 2) {
    console.log(JSON.stringify(importCandidatePacket(args[1], path.join(root, "docs/operational-value/proof/smoke-copilot-sdk"))));
    process.exit(0);
  }
  if (args[0] === "--compiled-packet" && args.length === 2) {
    console.log(JSON.stringify(importCompiledPacket(args[1], path.join(root, "docs/operational-value/proof/smoke-copilot-sdk"))));
    process.exit(0);
  }
  if (args.length !== 2) throw new Error("usage: collect-smoke-copilot-sdk.mjs READONLY_GIT_DIR READONLY_HISTORY_DIR");
  console.log(JSON.stringify(produce({ gitDirectory: args[0], historyDirectory: args[1],
    outputDirectory: path.join(root, "docs/operational-value/proof/smoke-copilot-sdk") }), null, 2));
}
