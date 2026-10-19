import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const proof = "docs/operational-value/proof/smoke-copilot-sdk";
const modulePath = "docs/operational-value/proof/functions/smoke-copilot-sdk.mjs";
const owned = [modulePath, proof, "scripts/collect-smoke-copilot-sdk.mjs",
  "scripts/native-smoke-copilot-sdk.mjs", "scripts/package-smoke-copilot-sdk.mjs",
  "tests/unit/operational-value-smoke-copilot-sdk.test.mjs"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const seedHash = "b30a55ef9a389bbce4500270bfdac715c87bbd9cef68e3463e9661de873ef835";
const seedManifestHash = "e15c42d73b26ceb2cc560378f25a28155bc5454ef929e861ffd9bacc57bf09fd";
const write = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function members(directory, entries = owned) {
  return entries.flatMap(name => {
    const file = path.join(directory, name), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${name}`);
    if (stat.isDirectory()) return members(directory, readdirSync(file).sort().map(child => `${name}/${child}`));
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error(`Unsupported or oversized member: ${name}`);
    if (name.endsWith(".mjs") && readFileSync(file, "utf8").split("\n").length > 3000) throw new Error(`Oversized module: ${name}`);
    return [{ path: name, bytes: stat.size, sha256: hash(readFileSync(file)) }];
  });
}

function run(directory, command, args, expected = 0) {
  const result = spawnSync(command, args, { cwd: directory, encoding: "utf8", timeout: 120000,
    maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_NO_LAZY_FETCH: "1" } });
  if (result.error) throw result.error;
  const record = { command, args, expectedStatus: expected, status: result.status, stdout: result.stdout, stderr: result.stderr };
  if (result.status !== expected) throw new Error(JSON.stringify(record));
  return record;
}

function validate(directory, endAt, outputDirectory) {
  const records = [
    run(directory, process.execPath, ["--test", "tests/unit/operational-value-smoke-copilot-sdk.test.mjs"]),
    run(directory, process.execPath, [".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", modulePath]),
    run(directory, process.execPath, ["scripts/native-smoke-copilot-sdk.mjs"]),
  ];
  const args = [".github/skills/add-operational-value/scripts/evaluate.mjs", "--root", directory,
    "--function", modulePath, "--output-dir", outputDirectory, "--end"];
  const frozenArgs = [...args];
  frozenArgs[frozenArgs.indexOf("--output-dir") + 1] = `${outputDirectory}-frozen`;
  const frozen = run(directory, process.execPath, [...frozenArgs, "2026-10-18T15:00:12Z", "github/gh-aw", "smoke-copilot-sdk"]);
  records.push(frozen);
  records.push(run(directory, process.execPath, [...args, endAt, "github/gh-aw", "smoke-copilot-sdk"]));
  return records;
}

function extract(archive, directory, expected) {
  const listed = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  if (listed.length !== expected.length || new Set(listed).size !== listed.length
    || listed.some(file => !expected.some(entry => entry.path === file))) throw new Error("Archive member-set mismatch");
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  for (const entry of expected) {
    const target = path.join(directory, entry.path), stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes
      || hash(readFileSync(target)) !== entry.sha256) throw new Error(`Extracted member mismatch: ${entry.path}`);
  }
}

const args = process.argv.slice(2);
if (args.length !== 3) throw new Error("usage: package-smoke-copilot-sdk.mjs SEED.tar.gz SEED.manifest.json EXTERNAL_OUTPUT_DIR");
const [seed, seedManifestFile, output] = args.map(value => path.resolve(value));
if (output === root || output.startsWith(`${root}/`)) throw new Error("Delivery output must be outside the repository");
if (hash(readFileSync(seed)) !== seedHash || hash(readFileSync(seedManifestFile)) !== seedManifestHash) {
  throw new Error("Seed archive/manifest hash mismatch");
}
const seedManifest = JSON.parse(readFileSync(seedManifestFile));
if (seedManifest.files.length !== 32 || seedManifest.archiveSha256 !== seedHash) throw new Error("Seed manifest mismatch");
mkdirSync(output, { recursive: true });
const endAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const records = validate(root, endAt, `${proof}/prospective`);
writeJsonArchive(path.join(root, proof, "validation.json.gz"), {
  schemaVersion: 1, endAt, records,
  interpretation: "Actual frozen standard evaluation admits two partial native operation facets from one contemporaneous source/SDK/host-verified run. Full goal, reporting completeness, other eras, baseline improvement and costs remain unknown. Original predecessor instrument/rejection is preserved separately.",
}, { spacing: 0, maxDecodedBytes: 16 * 1024 * 1024 });
const files = members(root);
const archive = path.join(output, "smoke-copilot-sdk-owned.tar.gz");
const manifestFile = path.join(output, "smoke-copilot-sdk-owned.manifest.json");
execFileSync("tar", ["-czf", archive, "-C", root, ...files.map(row => row.path)]);
const manifest = { schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8", cutoff: "2026-10-18T15:00:12Z",
  seedSha256: seedHash, seedManifestSha256: seedManifestHash, archiveSha256: hash(readFileSync(archive)), files };
write(manifestFile, manifest);
const work = mkdtempSync(path.join(root, ".sdk-portable-replay-"));
try {
  const baseline = path.join(work, "baseline.tar"), fresh = path.join(work, "fresh");
  mkdirSync(fresh);
  execFileSync("git", ["archive", "--format=tar", "--output", baseline, "HEAD"], { cwd: root });
  execFileSync("tar", ["-xf", baseline, "-C", fresh]);
  extract(seed, fresh, seedManifest.files);
  extract(archive, fresh, files);
  const replay = validate(fresh, endAt, path.join(work, "replay-output"));
  write(path.join(output, "smoke-copilot-sdk-replay.json"), {
    schemaVersion: 1, baseline: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    seedSha256: seedHash, archiveSha256: manifest.archiveSha256,
    manifestSha256: hash(readFileSync(manifestFile)), endAt,
    sharedGitOrHistoryAccess: false, records: replay,
    interpreter: JSON.parse(replay[2].stdout),
  });
} finally {
  if (!work.startsWith(`${root}/.sdk-portable-replay-`) || !existsSync(work)) throw new Error("Unsafe replay cleanup");
  rmSync(work, { recursive: true });
}
console.log(JSON.stringify({ archive, archiveSha256: manifest.archiveSha256,
  manifest: manifestFile, manifestSha256: hash(readFileSync(manifestFile)),
  files: files.length, independentReplay: "passed", endAt }, null, 2));
