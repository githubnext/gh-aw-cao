#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [outputDirectory, seedArchive, seedManifest] = process.argv.slice(2);
if (!outputDirectory || !seedArchive || !seedManifest) {
  throw new Error("usage: package-smoke-drive.mjs OUTPUT-DIRECTORY VERIFIED-SEED-ARCHIVE VERIFIED-SEED-MANIFEST");
}
const output = path.resolve(outputDirectory);
mkdirSync(output, { recursive: true });
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const collect = directory => readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
  const file = `${directory}/${entry.name}`;
  if (entry.isDirectory()) return collect(file);
  if (!entry.isFile()) throw new Error(`Nonregular owned artifact: ${file}`);
  return [file];
});
const files = [
  "docs/operational-value/proof/functions/smoke-drive.mjs",
  ...collect("docs/operational-value/proof/smoke-drive"),
  "scripts/collect-smoke-drive.mjs", "scripts/native-smoke-drive.mjs", "scripts/package-smoke-drive.mjs",
  "tests/unit/operational-value-smoke-drive.test.mjs",
].sort();
const members = files.map(file => {
  const bytes = readFileSync(path.join(root, file));
  if (bytes.length > 256 * 1024) throw new Error(`Oversized owned member: ${file}`);
  if (file.endsWith(".mjs") && bytes.toString("utf8").split("\n").length >= 3000) throw new Error(`Oversized module: ${file}`);
  return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
});
const expectedSeed = JSON.parse(readFileSync(seedManifest));
if (sha256(readFileSync(seedArchive)) !== "1135075ada0f45ea04aec54323a4b9a74c345cdc90a85393d848f3d458386b40"
  || sha256(readFileSync(seedManifest)) !== "7a723df38743959ffe0b0f107508f582737c76a17f0816bf0c24d76555c617bf") {
  throw new Error("Unverified seed archive or manifest");
}
for (const member of expectedSeed.files) {
  const bytes = readFileSync(path.join(root, member.path));
  if (bytes.length !== member.bytes || sha256(bytes) !== member.sha256) throw new Error(`Modified shared dependency: ${member.path}`);
}
const list = path.join(output, "smoke-drive-owned-files.txt");
const archive = path.join(output, "smoke-drive-owned-only.tar.gz");
writeFileSync(list, `${files.join("\n")}\n`);
execFileSync("tar", ["-czf", archive, "-T", list], { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" } });
const manifest = { schemaVersion: 1, workflow: "smoke-drive", archive: path.basename(archive),
  archiveSha256: sha256(readFileSync(archive)), seedArchiveSha256: expectedSeed.archiveSha256, files: members };
writeFileSync(path.join(output, "smoke-drive-owned-only.manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const temporary = mkdtempSync(path.join(root, ".smoke-drive-replay-"));
const baseline = path.join(output, "smoke-drive-baseline.tar");
try {
  const fd = openSync(baseline, "w");
  try {
    const result = spawnSync("git", ["archive", "--format=tar", "HEAD"], { cwd: root, stdio: ["ignore", fd, "pipe"] });
    if (result.status !== 0) throw new Error(String(result.stderr));
  } finally { closeSync(fd); }
  for (const file of [baseline, path.resolve(seedArchive), archive]) {
    execFileSync("tar", ["-xf", file, "-C", temporary], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
  }
  for (const member of [...expectedSeed.files, ...members]) {
    const bytes = readFileSync(path.join(temporary, member.path));
    if (bytes.length !== member.bytes || sha256(bytes) !== member.sha256) throw new Error(`Fresh replay member mismatch: ${member.path}`);
  }
  const module = "docs/operational-value/proof/functions/smoke-drive.mjs";
  const scripts = ".github/skills/add-operational-value/scripts";
  const commands = [
    ["--test", "tests/unit/operational-value-smoke-drive.test.mjs"],
    [`${scripts}/verify-value-function.mjs`, "--collector", module],
    [`${scripts}/evaluate.mjs`, "--end", "2026-10-18T15:00:12Z", "--function", module,
      "--output-dir", "docs/operational-value/proof/smoke-drive/reports", "--refresh", "github/gh-aw", "smoke-drive"],
  ];
  const results = commands.map(args => {
    const result = spawnSync(process.execPath, args, { cwd: temporary, encoding: "utf8", maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
    return { command: ["node", ...args], status: result.status, stdout: result.stdout, stderr: result.stderr };
  });
  writeFileSync(path.join(output, "smoke-drive-fresh-replay.json"), `${JSON.stringify({
    archiveSha256: manifest.archiveSha256, sharedDependenciesVerified: expectedSeed.files.length,
    ownedMembersVerified: members.length, noSharedCaches: true, noNetwork: true, results,
  }, null, 2)}\n`);
  if (results.some(result => result.status !== 0)) throw new Error("Fresh native/standard replay failed; inspect external replay report");
  console.log(JSON.stringify({ archive, members: members.length, archiveSha256: manifest.archiveSha256,
    standardCollectorStatus: results[1].status, standardRefreshStatus: results[2].status }));
} finally {
  rmSync(temporary, { recursive: true, force: true });
  rmSync(baseline, { force: true });
  rmSync(list, { force: true });
}
