import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const output = process.argv[2];
if (!output || !path.isAbsolute(output) || !output.endsWith(".tar.gz")) throw new Error("Absolute delta archive path required");
const root = "docs/operational-value/proof/weekly-editors-health-check";
const predecessor = readJsonArchive(`${root}/predecessor-run-discovery-v018.json`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const previous = new Map(predecessor.manifest.members.map(row => [row.path, row]));
const beforeArchive = Buffer.from(predecessor.content, "base64");
assert.equal(hash(beforeArchive), "d26c9b6be2db853e5157154736fa5441b314442232ac123eea33c45af08f55d6");
assert.equal(previous.size, 39);
const walk = directory => readdirSync(directory).flatMap(name => {
  const file = `${directory}/${name}`;
  return statSync(file).isDirectory() ? walk(file) : [file];
});
const all = [...new Set([
  ...previous.keys(), ...walk(root),
  "scripts/acquire-weekly-editors-latest-run.mjs",
  "scripts/inspect-weekly-editors-latest-run.mjs",
  "scripts/package-weekly-editors-latest-delta.mjs",
  "tests/unit/weekly-editors-health-check-latest-run.test.mjs",
])].sort();
const members = all.flatMap(file => {
  const bytes = readFileSync(file), afterSha256 = hash(bytes);
  if (bytes.length > 256 * 1024) throw new Error(`Over-budget owned file ${file}`);
  const before = previous.get(file);
  if (before?.sha256 === afterSha256) return [];
  return [{ path: file, bytes: bytes.length, beforeSha256: before?.sha256 ?? null, sha256: afterSha256,
    change: before ? "modified" : "added" }];
});
assert.ok(members.length > 0);
const functionPath = "docs/operational-value/proof/functions/weekly-editors-health-check.mjs";
assert.equal(hash(readFileSync(functionPath)), previous.get(functionPath).sha256);
assert.ok(!members.some(row => row.path === functionPath));
execFileSync("tar", ["-czf", output, "--", ...members.map(row => row.path)], {
  env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 30000,
});
for (const member of members) {
  const bytes = execFileSync("tar", ["-xOf", output, member.path], { maxBuffer: 256 * 1024, timeout: 30000 });
  assert.equal(bytes.length, member.bytes);
  assert.equal(hash(bytes), member.sha256);
}
const manifest = {
  schemaVersion: 1, kind: "workflow-owned-verified-delta", repository: "github/gh-aw",
  workflow: "weekly-editors-health-check", archiveSha256: hash(readFileSync(output)),
  predecessorArchiveSha256: predecessor.sha256,
  predecessorManifestSha256: "c58d23c47fbee1099e692059608d714d2c6ed4a7046f1634a1ce759bc48a930e",
  predecessorCodecFile: `${root}/predecessor-run-discovery-v018.json`,
  functionIdentity: { beforeSha256: previous.get(functionPath).sha256, afterSha256: hash(readFileSync(functionPath)), changed: false },
  acquisition: { authorizedRequests: 3, performedRequests: 3, statuses: [200, 200, 200],
    slot: "returned", furtherAcquisition: "not released" },
  nativeEvidence: { originalHttpEditorReceipts: 0, actualEditorHttpToolCallsInLatestRun: 0,
    availableEditorCount: null, failedEditorCount: null },
  members, verification: "Every delta member independently extracted from archive and checked for byte length and SHA256; before identities bind to the complete39-member predecessor.",
};
const manifestPath = output.replace(/\.tar\.gz$/, ".manifest.json");
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ archive: output, archiveSha256: manifest.archiveSha256, manifest: manifestPath,
  manifestSha256: hash(readFileSync(manifestPath)), deltaMembers: members.length, functionIdentity: manifest.functionIdentity }, null, 2));
