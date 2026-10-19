import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(process.argv[2] ?? "");
assert.ok(process.argv[2] && !output.startsWith(`${root}${path.sep}`), "Delivery must be outside the checkout");
assert.ok(!existsSync(output), "Use a new, empty delivery directory");
mkdirSync(output, { recursive: true });
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const walk = relative => readdirSync(path.join(root, relative)).toSorted().flatMap(name => {
  assert.ok(!name.startsWith("._") && name !== ".DS_Store");
  const file = `${relative}/${name}`;
  const info = lstatSync(path.join(root, file));
  assert.ok(!info.isSymbolicLink(), "Delivery must not contain symlinks");
  return info.isDirectory() ? walk(file) : [file];
});
const owned = [
  ...["stale-pr-cleanup", "draft-pr-cleanup", "sub-issue-closer"].map(slug => `docs/operational-value/proof/functions/${slug}.mjs`),
  ...walk("docs/operational-value/proof/native-cleanup-outcomes"),
  "scripts/acquire-native-cleanup.mjs", "scripts/native-cleanup-outcomes.mjs",
  "scripts/replay-native-cleanup.mjs", "scripts/package-native-cleanup.mjs",
  "tests/unit/native-cleanup-outcomes.test.mjs",
].toSorted();
const files = owned.map(file => {
  const bytes = readFileSync(path.join(root, file));
  assert.ok(bytes.length <= 256 * 1024, `Owned file too large: ${file}`);
  return { path: file, size: bytes.length, sha256: hash(bytes) };
});
const dependencyDirectory = ".github/skills/add-operational-value";
const dependencies = new Set([`${dependencyDirectory}/scripts/pulse.css`, `${dependencyDirectory}/package.json`]);
function dependency(file) {
  if (dependencies.has(file)) return;
  assert.ok(file.startsWith(`${dependencyDirectory}/scripts/`) && file.endsWith(".mjs"));
  dependencies.add(file);
  const text = readFileSync(path.join(root, file), "utf8");
  for (const match of text.matchAll(/(?:from\s+|import\s*)["'](\.\/[\w.-]+\.mjs)["']/g)) {
    dependency(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
  }
}
for (const entry of ["evaluate", "verify-value-function", "value-function-path",
  "build-timeline", "render-definitions", "validate-report-artifacts", "render-pulse"]) {
  dependency(`${dependencyDirectory}/scripts/${entry}.mjs`);
}
const dependencyFiles = [...dependencies].toSorted().map(file => {
  const bytes = readFileSync(path.join(root, file));
  return { path: file, size: bytes.length, sha256: hash(bytes) };
});
writeFileSync(path.join(output, "members.json"), `${JSON.stringify(files, null, 2)}\n`);
writeFileSync(path.join(output, "dependencies.json"), `${JSON.stringify({
  baseline: "e9837276b0b540a915b2cb3994b4215efa9e11dd",
  declaredRuntime: "add-operational-value skill 0.18.5 integration baseline; identify exact bytes by these digests.",
  files: dependencyFiles,
  note: "Unchanged dependencies are deliberately excluded from the owned archive.",
}, null, 2)}\n`);
writeFileSync(path.join(output, "members.txt"), `${owned.join("\n")}\n`);
const archive = path.join(output, "native-cleanup-owned.tar.gz");
const tar = spawnSync("tar", ["-czf", archive, "-T", path.join(output, "members.txt")], {
  cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" }, encoding: "utf8",
});
if (tar.error) throw tar.error;
assert.equal(tar.status, 0, tar.stderr);
const clean = path.join(output, "clean-replay");
mkdirSync(clean);
const verify = spawnSync("python3", ["-c", `
import hashlib,json,pathlib,sys,tarfile
archive,manifest,destination=sys.argv[1:]
expected={x["path"]:x for x in json.load(open(manifest))}
with tarfile.open(archive,"r:gz") as t:
 members=t.getmembers()
 names=[m.name for m in members]
 assert len(names)==len(set(names)) and set(names)==set(expected),"Not exact owned member set"
 for m in members:
  p=pathlib.PurePosixPath(m.name)
  assert m.isfile() and not p.is_absolute() and ".." not in p.parts
  assert all(not x.startswith("._") and x!=".DS_Store" for x in p.parts),"AppleDouble/metadata member"
  b=t.extractfile(m).read()
  assert len(b)==expected[m.name]["size"]<=262144
  assert hashlib.sha256(b).hexdigest()==expected[m.name]["sha256"]
  target=pathlib.Path(destination)/m.name
  target.parent.mkdir(parents=True,exist_ok=True)
  target.write_bytes(b)
print(json.dumps({"exactMemberSet":True,"members":len(names),"appleDoubleMembers":0,"allDigestsVerified":True}))
`, archive, path.join(output, "members.json"), clean], { encoding: "utf8", timeout: 120000 });
if (verify.error) throw verify.error;
assert.equal(verify.status, 0, verify.stderr);
for (const file of dependencyFiles) {
  const target = path.join(clean, file.path);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(root, file.path), target);
  assert.equal(hash(readFileSync(target)), file.sha256);
}
assert.ok(!existsSync(path.join(clean, ".git")) && !existsSync(path.join(clean, "node_modules")));
const bin = path.join(output, "offline-bin");
mkdirSync(bin);
symlinkSync(process.execPath, path.join(bin, "node"));
const python = spawnSync("python3", ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" });
assert.equal(python.status, 0);
symlinkSync(python.stdout.trim(), path.join(bin, "python3"));
const shasum = spawnSync("/usr/bin/which", ["shasum"], { encoding: "utf8" });
assert.equal(shasum.status, 0);
symlinkSync(shasum.stdout.trim(), path.join(bin, "shasum"));
const guard = path.join(output, "offline-guard.mjs");
writeFileSync(guard, `
import childProcess from "node:child_process";
import net from "node:net";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import dgram from "node:dgram";
import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const denied = () => { throw new Error("Offline replay prohibits network access"); };
globalThis.fetch = denied;
net.connect = net.createConnection = net.createServer = denied;
tls.connect = tls.createServer = denied;
http.request = http.get = https.request = https.get = denied;
dgram.createSocket = dns.lookup = dns.resolve = denied;
const original = childProcess.spawnSync;
childProcess.spawnSync = (command, args, options) => {
  if (![process.execPath, "python3", "shasum"].includes(command) || options?.shell) {
    throw new Error("Offline replay prohibits non-replay subprocesses");
  }
  return original(command, args, options);
};
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (command, args, options) => {
  if (command !== "shasum" || args?.[0] !== "-a" || args?.[1] !== "256" || args.length !== 3 || options?.shell) {
    throw new Error("Offline replay permits only the skill's shasum invocation through execFileSync");
  }
  return originalExecFileSync(command, args, options);
};
childProcess.exec = childProcess.execSync = () => { throw new Error("Offline replay prohibits shell execution"); };
syncBuiltinESMExports();
`);
const replay = spawnSync(process.execPath, ["scripts/replay-native-cleanup.mjs"], {
  cwd: clean,
  env: { ...process.env, PATH: bin, NODE_PATH: "", NODE_OPTIONS: `--import ${pathToFileURL(guard).href}`,
    GIT_NO_LAZY_FETCH: "1", HOME: path.join(output, "offline-home") },
  encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 600000,
});
if (replay.error) throw replay.error;
writeFileSync(path.join(output, "offline-replay.log"), `${replay.stdout}\n${replay.stderr}`);
assert.equal(replay.status, 0, replay.stderr);
const comparisons = [];
for (const slug of ["stale-pr-cleanup", "draft-pr-cleanup", "sub-issue-closer"]) {
  const relative = `docs/operational-value/proof/native-cleanup-outcomes/reports/github-gh-aw/${slug}-timeline.json`;
  const original = JSON.parse(readFileSync(path.join(root, relative)));
  const extracted = JSON.parse(readFileSync(path.join(clean, relative)));
  assert.deepEqual(extracted.snapshots, original.snapshots);
  assert.deepEqual(extracted.valueFunction, original.valueFunction);
  comparisons.push({ slug, snapshotsIdentical: true, contractIdentical: true });
}
const bytes = readFileSync(archive);
const parts = [];
for (let offset = 0; offset < bytes.length; offset += 256 * 1024) {
  const chunk = bytes.subarray(offset, offset + 256 * 1024);
  const name = `native-cleanup-owned.tar.gz.part-${String(parts.length + 1).padStart(3, "0")}`;
  writeFileSync(path.join(output, name), chunk);
  parts.push({ file: name, size: chunk.length, sha256: hash(chunk) });
}
const reconstructed = spawnSync("python3", ["-c", `
import hashlib,io,json,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1]);parts=json.loads(sys.argv[2]);expected=json.load(open(root/"members.json"))
chunks=[]
for p in parts:
 b=(root/p["file"]).read_bytes()
 assert len(b)==p["size"]<=262144 and hashlib.sha256(b).hexdigest()==p["sha256"]
 chunks.append(b)
data=b"".join(chunks)
assert hashlib.sha256(data).hexdigest()==sys.argv[3]
with tarfile.open(fileobj=io.BytesIO(data),mode="r:gz") as t:
 assert {m.name for m in t.getmembers()}=={x["path"] for x in expected}
 assert all(m.isfile() and all(not p.startswith("._") for p in pathlib.PurePosixPath(m.name).parts) for m in t.getmembers())
print(json.dumps({"chunksReassembled":True,"exactMemberSet":True,"appleDoubleMembers":0}))
`, output, JSON.stringify(parts), hash(bytes)], { encoding: "utf8", maxBuffer: 1024 * 1024 });
assert.equal(reconstructed.status, 0, reconstructed.stderr);
rmSync(archive);
const manifest = {
  schemaVersion: 1, ownedFiles: files,
  archive: { reconstructedName: "native-cleanup-owned.tar.gz", size: bytes.length, sha256: hash(bytes), parts },
  dependencies: { manifest: "dependencies.json", sha256: hash(readFileSync(path.join(output, "dependencies.json"))),
    includedInOwnedArchive: false },
  verification: {
    pythonTarfile: JSON.parse(verify.stdout), pythonChunkReassembly: JSON.parse(reconstructed.stdout),
    cleanReplay: { exitCode: replay.status, noGitDirectory: true, noNodeModules: true,
      noSharedAcquisition: true, networkApisDenied: true, nonReplaySubprocessesDenied: true,
      allowedSubprocesses: ["node", "python3 (ZIP parser)", "shasum -a 256 FILE (unchanged skill dependency)"],
      comparisons, log: "offline-replay.log" },
  },
  qualification: { requestedInstruments: 3, qualifiedNativeInstruments: 1,
    nativeParentClosures: 2, stalePrCleanup: null, draftPrCleanup: null },
};
writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  delivery: output, manifest: path.join(output, "manifest.json"),
  ownedFiles: files.length, archiveBytes: bytes.length, parts: parts.length,
  dependencies: dependencyFiles.length, verification: manifest.verification, qualification: manifest.qualification,
}, null, 2));
