#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import {
  aggregateAttempts, parseGitTree, readOriginalPacket, readRetainedAttempts, validateRunMetadata, verifyLineage,
} from "./native-smoke-drive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "docs/operational-value/proof/smoke-drive");
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const write = (name, value) => writeFileSync(path.join(out, name), `${JSON.stringify(value, null, 2)}\n`);

export function verifyPacket(directory, expectedDigest) {
  const manifestBytes = readFileSync(path.join(directory, "manifest.json"));
  if (sha256(manifestBytes) !== expectedDigest) throw new Error("Original acquisition manifest digest mismatch");
  const manifest = JSON.parse(manifestBytes);
  if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607) throw new Error("Packet repository mismatch");
  const receipts = manifest.requests.filter(row => row.workflow === "smoke-drive");
  for (const row of receipts) {
    if (typeof row.file !== "string" || path.basename(row.file) !== row.file) throw new Error("Unsafe acquisition path");
    const bytes = readFileSync(path.join(directory, row.file));
    if (bytes.length !== row.bytes || sha256(bytes) !== row.sha256) throw new Error("Original acquisition bytes mismatch");
  }
  return { upstreamManifestSha256: expectedDigest, repository: manifest.repository,
    repositoryId: manifest.repositoryId, requests: receipts };
}

export function retainPacket(directory, expectedDigest, name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error("Invalid packet name");
  const packet = verifyPacket(directory, expectedDigest);
  const destination = path.join(out, "originals", name);
  mkdirSync(destination, { recursive: true });
  for (const row of packet.requests) copyFileSync(path.join(directory, row.file), path.join(destination, row.file));
  writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify(packet, null, 2)}\n`);
  return packet.requests.length;
}

export function retainSourcePacket(directory, expectedDigest) {
  const raw = readFileSync(path.join(directory, "manifest.json"));
  if (sha256(raw) !== expectedDigest) throw new Error("Source acquisition manifest digest mismatch");
  const manifest = JSON.parse(raw);
  if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607) throw new Error("Source scope mismatch");
  const receipts = manifest.receipts.filter(row => row.workflow === "smoke-drive");
  const destination = path.join(out, "originals", "compiled");
  mkdirSync(destination, { recursive: true });
  for (const row of receipts) {
    for (const [name, bytes, digest] of [[row.response, row.bodyBytes, row.bodySha256], [row.blob, row.blobBytes, row.blobSha256]]) {
      if (typeof name !== "string" || path.basename(name) !== name) throw new Error("Unsafe source path");
      const content = readFileSync(path.join(directory, name));
      if (content.length !== bytes || sha256(content) !== digest) throw new Error("Original source bytes mismatch");
      copyFileSync(path.join(directory, name), path.join(destination, name));
    }
    const blob = readFileSync(path.join(destination, row.blob));
    const response = JSON.parse(readFileSync(path.join(destination, row.response)));
    if (response.sha !== row.sha || response.encoding !== "base64"
      || !Buffer.from(response.content, "base64").equals(blob)
      || createHash("sha1").update(`blob ${blob.length}\0`).update(blob).digest("hex") !== row.sha) {
      throw new Error("Original compiled Git blob mismatch");
    }
  }
  writeFileSync(path.join(destination, "manifest.json"), `${JSON.stringify({
    upstreamManifestSha256: expectedDigest, repository: manifest.repository, repositoryId: manifest.repositoryId, receipts,
  }, null, 2)}\n`);
  return receipts.length;
}

export function candidateClosure(entities, workflow = "smoke-drive") {
  const byNumber = new Map(entities.map(row => [row.number, row]));
  const selected = new Set(entities.filter(row =>
    row.workflowReference?.workflowId === workflow || row.unverifiedWorkflowId === workflow).map(row => row.number));
  const direct = [...selected];
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of entities) {
      if (selected.has(row.number) || row.relatedCandidates.some(number => selected.has(number))) {
        for (const number of [row.number, ...row.relatedCandidates]) {
          if (!selected.has(number)) { selected.add(number); changed = true; }
        }
      }
    }
  }
  return {
    direct: direct.sort((a, b) => a - b),
    entities: [...selected].filter(number => byNumber.has(number)).sort((a, b) => a - b).map(number => byNumber.get(number)),
    absentReferences: [...selected].filter(number => !byNumber.has(number)).sort((a, b) => a - b),
  };
}

export function collectDiscovery(historyDirectory, gitDirectory) {
  const { index, entities } = readOutputHistory(historyDirectory);
  if (index.repository !== "github/gh-aw" || index.repositoryId !== 1036865607
    || index.sourceRevision !== "c86377ec47b38f0b5af463277ee55d1d03d08da8"
    || index.until !== "2026-10-18T15:00:12Z" || !index.complete) throw new Error("Frozen history scope mismatch");
  const closure = candidateClosure(entities);
  mkdirSync(out, { recursive: true });
  write("discovery.json", {
    schemaVersion: 1, repository: index.repository, repositoryId: index.repositoryId,
    until: index.until, sourceRevision: index.sourceRevision, ...closure,
    custody: {
      historyIndexSha256: sha256(readFileSync(path.join(historyDirectory, "history.json.gz"))),
      totalEntitiesVerified: entities.length, partitionsVerified: index.partitions.length,
      partitions: index.partitions.map(({ file, count, sha256: digest, observedAt }) =>
        ({ file, count, sha256: digest, observedAt })),
      acquisitionStartedAt: index.startedAt, acquisitionCompletedAt: index.completedAt,
    },
    coverage: "Complete direct and bidirectional transitive candidate closure within supplied surviving issue/PR inventory; not all workflow executions, comments, deleted or edited-away outputs.",
    outcomeCount: null,
  });
  const contracts = JSON.parse(gunzipSync(readFileSync(path.join(root, "docs/operational-value/gh-aw-census/contracts.json.gz"))));
  write("frozen-standard-contract.json", contracts.contracts.find(row => row.path === ".github/workflows/smoke-drive.md"));
  const sources = [".github/workflows/smoke-drive.md", ".github/workflows/shared/smoke-test-brevity.md",
    ".github/workflows/shared/reporting.md"];
  const files = sources.map(source => {
    const bytes = execFileSync("git", [`--git-dir=${gitDirectory}`, "show", `${index.sourceRevision}:${source}`],
      { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
    const gitBlob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (source === sources[0] && gitBlob !== "b807269a21552c0e6ac518da7c44056024047e95") throw new Error("Frozen source blob mismatch");
    return { path: source, gitBlob, bytes: bytes.length, sha256: sha256(bytes), text: bytes.toString("utf8") };
  });
  write("source.json", { revision: index.sourceRevision, files });
  return { direct: closure.direct.length, closure: closure.entities.length, absent: closure.absentReferences.length };
}

export function collectSourceProfiles(gitDirectory) {
  const packet = readOriginalPacket(path.join(out, "originals/metadata"));
  const runs = packet.requests.filter(row => /^repos\/github\/gh-aw\/actions\/runs\/\d+$/.test(row.receipt.endpoint))
    .map(row => {
      const run = JSON.parse(row.bytes);
      return validateRunMetadata(run, run.id);
    });
  const profiles = runs.map(({ runId, head: revision }) => {
    const paths = [".github/workflows/smoke-drive.md", ".github/workflows/smoke-drive.lock.yml",
      ".github/workflows/shared/smoke-test-brevity.md", ".github/workflows/shared/reporting.md"];
    const git = args => execFileSync("git", [`--git-dir=${gitDirectory}`, ...args],
      { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
    const tree = git(["ls-tree", revision, ...paths]).toString("utf8");
    const files = tree.trim().split("\n").map(line => {
      const match = /^100644 blob ([a-f0-9]{40})\t(.+)$/.exec(line);
      if (!match) throw new Error("Unexpected source tree mode");
      const [, gitBlob, source] = match;
      if (source.endsWith(".lock.yml")) return { path: source, gitBlob, readableBytes: false,
        missingReason: "Tree identity known; original compiled bytes requested separately." };
      const bytes = git(["cat-file", "blob", gitBlob]);
      if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== gitBlob) {
        throw new Error("Native source object mismatch");
      }
      return { path: source, gitBlob, bytes: bytes.length, sha256: sha256(bytes), text: bytes.toString("utf8") };
    });
    if (files.length !== paths.length) throw new Error("Incomplete native source tree");
    const commit = git(["cat-file", "commit", revision]);
    if (createHash("sha1").update(`commit ${commit.length}\0`).update(commit).digest("hex") !== revision) {
      throw new Error("Native commit object mismatch");
    }
    let next = /^tree ([a-f0-9]{40})$/m.exec(commit.toString("utf8"))?.[1];
    const trees = [];
    for (const name of [".github", "workflows", "shared", null]) {
      const bytes = git(["cat-file", "tree", next]);
      if (createHash("sha1").update(`tree ${bytes.length}\0`).update(bytes).digest("hex") !== next) {
        throw new Error("Native source tree object mismatch");
      }
      trees.push({ gitTree: next, bytesBase64: bytes.toString("base64"), sha256: sha256(bytes) });
      if (name !== null) {
        const child = parseGitTree(bytes).find(row => row.name === name && row.mode === "40000");
        if (!child) throw new Error("Incomplete native source/import tree path");
        next = child.sha;
      }
    }
    return { runId, revision, files, trees, commit: { text: commit.toString("utf8"), sha256: sha256(commit) } };
  });
  write("source-profiles.json", { repository: "github/gh-aw", profiles });
  return profiles.length;
}

export function collectLineage(gitDirectory) {
  const git = (type, sha) => {
    const bytes = execFileSync("git", [`--git-dir=${gitDirectory}`, "cat-file", type, sha],
      { env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
    if (createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex") !== sha) {
      throw new Error("Lineage Git object mismatch");
    }
    return bytes;
  };
  const recover = commit => {
    const bytes = git("commit", commit), text = bytes.toString("utf8");
    const parent = /^parent ([a-f0-9]{40})$/m.exec(text)?.[1] ?? null;
    const seconds = /^committer .+ (\d+) [+-]\d{4}$/m.exec(text)?.[1];
    if (!seconds) throw new Error("Missing authoritative commit timestamp");
    let sha = /^tree ([a-f0-9]{40})$/m.exec(text)?.[1];
    const trees = [];
    for (const name of [".github", "workflows", null]) {
      const raw = git("tree", sha), entries = parseGitTree(raw);
      trees.push({ gitTree: sha, bytesBase64: raw.toString("base64"), sha256: sha256(raw) });
      if (name === null) {
        const files = entries.filter(row => ["smoke-drive.md", "smoke-drive.lock.yml"].includes(row.name));
        return { commit, at: new Date(Number(seconds) * 1000).toISOString().replace(".000Z", "Z"),
          parent, commitBytesBase64: bytes.toString("base64"), trees, files };
      }
      const child = entries.find(row => row.name === name && row.mode === "40000");
      if (!child) throw new Error("Missing lineage tree path");
      sha = child.sha;
    }
  };
  const addition = recover("bc565025e57baa1395065fb45c19f3d2b235c4a0");
  if (addition.parent !== "01fb3b77f0e9478f91653232d2d89680dfad6678") throw new Error("Wrong actual introduction parent");
  const parent = recover(addition.parent);
  if (addition.files.length !== 2 || parent.files.length !== 0
    || addition.files.find(row => row.name === "smoke-drive.md")?.sha !== "53207eeb06a8051204147bcb5c7d08a7f90dd4dc"
    || addition.files.find(row => row.name === "smoke-drive.lock.yml")?.sha !== "1eb3c45688723558ee6342ecdf2154c6dd0e340a") {
    throw new Error("Actual source/compiled addition not established");
  }
  write("lineage.json", verifyLineage({ schemaVersion: 1, repository: "github/gh-aw",
    actualAdoption: { commit: addition.commit, at: addition.at },
    baseline: { commit: parent.commit, at: parent.at },
    proof: { addition, parent },
    sourceEraLimitation: "Introduction identity is established; adoption source bytes are separately required for original-goal compatibility. Current native measurements use their own exact-head source, explicitly retrospectively.",
    correctionToPredecessor: "53207eeb06a8051204147bcb5c7d08a7f90dd4dc was a missing source blob, not a missing ancestor commit. The unresolved predecessor is preserved.",
  }));
  return { actualAdoption: addition.at, parentAt: parent.at };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === "--lineage") {
    console.log(JSON.stringify(collectLineage(path.resolve(process.argv[3]))));
    process.exit(0);
  }
  if (process.argv[2] === "--native") {
    const attempts = readRetainedAttempts(out);
    const windows = [
      ["2026-10-04T15:00:12Z", "2026-10-11T15:00:12Z"],
      ["2026-10-11T15:00:12Z", "2026-10-18T15:00:12Z"],
    ].map(([windowStart, windowEnd]) => aggregateAttempts(attempts, { windowStart, windowEnd, observedAt: windowEnd }));
    write("native-facts.json", { schemaVersion: 1, repository: "github/gh-aw",
      cutoff: "2026-10-18T15:00:12Z",
      acceptanceSha256: sha256(readFileSync(path.join(out, "acceptance.json"))),
      interpretation: "Explicit same-source retrospective case study; not an ex-ante historical evaluation or continuous deployment.",
      attempts, windows, recentMovement: null,
      recentMovementMissingReason: "Latest retained cohort is partial and immediately preceding equal period has no native originals.",
      cost: "not measured", keep: "not rated",
      unknown: ["Stored drive state across runs", "Actual git-log access in unexecuted agents",
        "Unretained attempts and source eras", "Complete historical attainment", "Exclusive causation"],
      skillImprovement: JSON.parse(readFileSync(path.join(out, "acceptance.json"))).skillImprovement,
    });
    console.log(JSON.stringify({ attempts: attempts.length, latest: windows.at(-1) }));
    process.exit(0);
  }
  if (process.argv[2] === "--compiled") {
    console.log(JSON.stringify({ compiled: retainSourcePacket(process.argv[3], process.argv[4]) }));
    process.exit(0);
  }
  if (process.argv[2] === "--sources") {
    console.log(JSON.stringify({ profiles: collectSourceProfiles(path.resolve(process.argv[3])) }));
    process.exit(0);
  }
  if (process.argv[2] === "--packet") {
    const [directory, digest, name] = process.argv.slice(3);
    console.log(JSON.stringify({ retained: retainPacket(directory, digest, name) }));
    process.exit(0);
  }
  const [history, git] = process.argv.slice(2);
  if (!history || !git) throw new Error("usage: collect-smoke-drive.mjs VERIFIED-HISTORY READ-ONLY-BARE-GIT");
  console.log(JSON.stringify(collectDiscovery(path.resolve(history), path.resolve(git))));
}
