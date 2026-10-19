import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const [output] = process.argv.slice(2);
if (!output || !path.isAbsolute(output) || !output.endsWith(".tar.gz")) {
  throw new Error("usage: node scripts/package-weekly-editors-health-check.mjs ABSOLUTE_ARCHIVE.tar.gz");
}
const proof = "docs/operational-value/proof/weekly-editors-health-check";
const modulePath = "docs/operational-value/proof/functions/weekly-editors-health-check.mjs";
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const walk = directory => readdirSync(directory).flatMap(name => {
  const file = `${directory}/${name}`;
  return statSync(file).isDirectory() ? walk(file) : [file];
});
const handoff = readJsonArchive(`${proof}/handoff.json`);
const files = [
  modulePath,
  "scripts/investigate-weekly-editors-health-check.mjs",
  "scripts/package-weekly-editors-health-check.mjs",
  "scripts/acquire-weekly-editors-run-page.mjs",
  "scripts/summarize-weekly-editors-run-page.mjs",
  "tests/unit/weekly-editors-health-check-investigation.test.mjs",
  "tests/unit/weekly-editors-health-check-value.test.mjs",
  ...walk(proof),
].sort();
assert.equal(new Set(files).size, files.length);
assert.equal(digest(readFileSync(modulePath)), handoff.function.sha256);
const timeline = readJsonArchive(`${proof}/reports/github-gh-aw/weekly-editors-health-check-timeline.json`);
const pulse = readJsonArchive(`${proof}/reports/github-gh-aw/weekly-editors-health-check-pulse.json`);
assert.equal(timeline.valueFunction.sha256, handoff.function.sha256);
assert.equal(pulse.valueFunctionSha256, handoff.function.sha256);
assert.equal(timeline.snapshots.length, handoff.nativeCounts.evaluatedSnapshotAssessments);
assert.equal(timeline.snapshots.filter(row => row.metrics["available-editor-percent"] !== null).length,
  handoff.nativeCounts.acceptedNumericNativeObservations);
const members = files.map(file => {
  const bytes = readFileSync(file);
  if (bytes.length > 256 * 1024) throw new Error(`Over-budget owned file: ${file}`);
  return { path: file, bytes: bytes.length, sha256: digest(bytes) };
});
execFileSync("tar", ["-czf", output, "--", ...files], {
  env: { ...process.env, COPYFILE_DISABLE: "1" }, timeout: 30000, stdio: ["ignore", "pipe", "pipe"],
});
const archived = execFileSync("tar", ["-tzf", output], { encoding: "utf8", timeout: 30000 })
  .trim().split("\n");
assert.deepEqual(archived, files);
for (const member of members) {
  const bytes = execFileSync("tar", ["-xOf", output, member.path], { timeout: 30000, maxBuffer: 256 * 1024 });
  assert.equal(bytes.length, member.bytes);
  assert.equal(digest(bytes), member.sha256);
}
const manifest = {
  schemaVersion: 1,
  archive: path.basename(output),
  archiveSha256: digest(readFileSync(output)),
  metadata: handoff,
  members,
  verification: "Each listed archive member was independently extracted in memory and checked for exact byte length and SHA256.",
};
const manifestFile = output.replace(/\.tar\.gz$/, ".manifest.json");
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
if (statSync(manifestFile).size > 256 * 1024) throw new Error("Over-budget portable manifest");
console.log(JSON.stringify({
  archive: output, sha256: manifest.archiveSha256, manifest: manifestFile,
  manifestSha256: digest(readFileSync(manifestFile)), independentlyVerifiedMembers: members.length,
  functionSha256: handoff.function.sha256, nativeCounts: handoff.nativeCounts,
}, null, 2));
