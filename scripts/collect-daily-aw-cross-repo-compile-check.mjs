#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readOutputHistory } from "../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const slug = "daily-aw-cross-repo-compile-check";
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
const repository = "github/gh-aw";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const output = path.resolve(`docs/operational-value/proof/${slug}`);
const sourcePaths = [
  `.github/workflows/${slug}.md`,
  `.github/workflows/${slug}.lock.yml`,
  ".github/workflows/shared/reporting.md",
  ".github/workflows/shared/otlp.md",
  "docs/src/content/docs/reference/compilation-process.md",
  "pkg/cli/compile_args.go",
  "pkg/cli/compile_config.go",
  "pkg/cli/compile_orchestrator.go",
  "pkg/cli/compile_pipeline.go",
  "pkg/cli/fix_command.go",
  "pkg/cli/fix_codemods.go",
];

export function retainInputs(gitDirectory, historyDirectory, sourcePacket) {
  const git = args => execFileSync("git", [`--git-dir=${path.resolve(gitDirectory)}`, ...args], {
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 8 * 1024 * 1024, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
  });
  if (git(["remote", "get-url", "origin"]).toString().trim() !== "https://github.com/github/gh-aw.git") {
    throw new Error("Public source cache identity mismatch");
  }
  const sources = sourcePaths.map(file => {
    const entry = git(["ls-tree", "-r", revision, "--", file]).toString().trim();
    const match = entry.match(/^100644 blob ([a-f0-9]{40})\t(.+)$/);
    if (!match || match[2] !== file) throw new Error(`Unsupported source tree entry: ${file}`);
    const gitBlob = match[1];
    let bytes;
    try {
      bytes = git(["cat-file", "blob", gitBlob]);
    } catch (error) {
      if (error.status !== 128 || !/Not a valid object name|could not get object info|bad file/i.test(String(error.stderr))) {
        throw error;
      }
      return { path: file, gitBlob, status: "missing-local-object",
        endpoint: `repos/${repository}/git/blobs/${gitBlob}`, acquisitionAuthorized: false };
    }
    if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== gitBlob) {
      throw new Error(`Source blob identity mismatch: ${file}`);
    }
    return { path: file, gitBlob, sha256: sha256(bytes), bytes: bytes.length,
      status: "preserved", content: bytes.toString("base64") };
  });
  if (sourcePacket) {
    const manifestBytes = readFileSync(path.join(sourcePacket, "manifest.json"));
    const manifest = JSON.parse(manifestBytes);
    if (manifest.repository !== repository || manifest.repositoryId !== 1036865607 || !manifest.complete) {
      throw new Error("Provider source packet scope mismatch");
    }
    const receipt = manifest.receipts.find(row => row.workflow === slug && row.sha === "d467506953667aaa20c50b9e539cb1bbfdabb927");
    if (!receipt || receipt.status !== 200 || receipt.method !== "GET"
      || receipt.endpoint !== `repos/${repository}/git/blobs/${receipt.sha}`
      || receipt.response !== `${receipt.sha}.response.json` || receipt.blob !== `${receipt.sha}.blob`) {
      throw new Error("Provider source receipt identity mismatch");
    }
    const body = readFileSync(path.join(sourcePacket, receipt.response));
    const bytes = readFileSync(path.join(sourcePacket, receipt.blob));
    const response = JSON.parse(body);
    const decoded = Buffer.from(response.content.replace(/\n/g, ""), "base64");
    if (sha256(body) !== receipt.bodySha256 || body.length !== receipt.bodyBytes
      || bytes.length !== receipt.blobBytes || sha256(bytes) !== receipt.blobSha256
      || response.sha !== receipt.sha || response.encoding !== "base64" || response.size !== bytes.length
      || !bytes.equals(decoded)
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== receipt.sha) {
      throw new Error("Provider source packet digest mismatch");
    }
    sources[1] = { path: sourcePaths[1], gitBlob: receipt.sha, sha256: sha256(bytes),
      bytes: bytes.length, status: "preserved", content: bytes.toString("base64") };
    mkdirSync(output, { recursive: true });
    writeJsonArchive(path.join(output, "compiled-provider.json.gz"), {
      schemaVersion: 1, repository, repositoryId: manifest.repositoryId,
      manifestSha256: sha256(manifestBytes), receipt, originalBody: body.toString("base64"),
      decodedBlob: bytes.toString("base64"),
    });
  }
  const workflow = sources[0];
  if (workflow.gitBlob !== "a4726c28d67f33d3d45e0ff288aaffdfd0498233" || workflow.status !== "preserved") {
    throw new Error("Frozen workflow identity mismatch");
  }
  const { index, entities } = readOutputHistory(historyDirectory);
  if (index.repository !== repository || index.repositoryId !== 1036865607
    || index.until !== cutoff || index.sourceRevision !== revision || !index.complete
    || index.partitions.length !== 346 || index.totalEntities !== 58048) {
    throw new Error("Shared discovery inventory identity mismatch");
  }
  const selected = entities.filter(row => row.workflowReference?.workflowId === slug || row.unverifiedWorkflowId === slug);
  mkdirSync(output, { recursive: true });
  writeJsonArchive(path.join(output, "sources.json.gz"), { schemaVersion: 1, repository,
    repositoryId: index.repositoryId, revision, cutoff, sources });
  writeJsonArchive(path.join(output, "discovery.json.gz"), {
    schemaVersion: 1, index, indexFileSha256: sha256(readFileSync(path.join(historyDirectory, "history.json.gz"))),
    verifiedPartitions: index.partitions.length, verifiedEntities: entities.length,
    selected, interpretation: "Discovery only. Editable markers, state, runs and summaries are not compilation evidence.",
  });
  return { sources: sources.map(({ content, ...row }) => row), selectedEntities: selected.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (![4, 5].includes(process.argv.length)) throw new Error("Usage: collect-daily-aw-cross-repo-compile-check.mjs READ_ONLY_GIT_DIR HISTORY_ROOT [SOURCE_PACKET]");
  console.log(JSON.stringify(retainInputs(process.argv[2], process.argv[3], process.argv[4]), null, 2));
}
