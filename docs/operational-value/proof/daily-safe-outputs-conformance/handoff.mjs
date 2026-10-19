import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "./native-checker.mjs";

const home = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(home, "../../../..");
const output = process.argv[2];
if (!output || !path.isAbsolute(output)) throw new Error("Usage: node handoff.mjs ABSOLUTE-SESSION-ARTIFACT-DIRECTORY");
mkdirSync(output, { recursive: true });
const temporary = mkdtempSync(path.join(root, ".safe-output-handoff-"));
try {
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const name = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unsupported symlink: ${name}`);
    return entry.isDirectory() ? walk(name) : [name];
  });
  const files = [path.join(root, "docs/operational-value/proof/functions/daily-safe-outputs-conformance.mjs"), ...walk(home)]
    .map(file => {
      const relative = path.relative(root, file);
      if (relative.startsWith("../") || /[\r\n]/.test(relative) || !lstatSync(file).isFile()) throw new Error("Unsafe owned member");
      const bytes = readFileSync(file);
      assert.ok(bytes.length <= 256 * 1024, relative);
      return { path: relative, bytes: bytes.length, sha256: hash(bytes), mode: lstatSync(file).mode & 0o777 };
    }).sort((a, b) => a.path.localeCompare(b.path));
  assert.equal(new Set(files.map(file => file.path)).size, files.length);
  const list = path.join(temporary, "members.txt");
  writeFileSync(list, `${files.map(file => file.path).join("\n")}\n`);
  const archive = path.join(output, "daily-safe-outputs-conformance.tar.gz");
  const options = { cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" }, maxBuffer: 4 * 1024 * 1024, timeout: 30000 };
  execFileSync("tar", ["-czf", archive, "--no-recursion", "-T", list], options);
  const actualMembers = execFileSync("tar", ["-tzf", archive], options).toString("utf8").trimEnd().split("\n");
  assert.deepEqual(actualMembers, files.map(file => file.path));
  const extracted = path.join(temporary, "verified");
  mkdirSync(extracted);
  execFileSync("tar", ["-xzf", archive, "-C", extracted], options);
  for (const member of files) {
    const name = path.join(extracted, member.path), bytes = readFileSync(name);
    assert.ok(lstatSync(name).isFile() && !lstatSync(name).isSymbolicLink(), member.path);
    assert.equal(bytes.length, member.bytes, member.path);
    assert.equal(hash(bytes), member.sha256, member.path);
    assert.equal(lstatSync(name).mode & 0o777, member.mode, member.path);
  }
  const manifest = {
    schemaVersion: 1, workflowSlug: "daily-safe-outputs-conformance",
    archive: { name: path.basename(archive), bytes: readFileSync(archive).length, sha256: hash(readFileSync(archive)) },
    registrationPath: path.relative(root, path.join(home, "registration.json")),
    seedExcluded: true, independentMemberVerification: "Every archived member extracted and checked for exact path, regular-file type, size, SHA256 and mode.",
    members: files,
  };
  const manifestPath = path.join(output, "daily-safe-outputs-conformance.manifest.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const reopened = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.deepEqual(reopened, manifest);
  console.log(JSON.stringify({
    archive, archiveSha256: manifest.archive.sha256,
    manifest: manifestPath, manifestSha256: hash(readFileSync(manifestPath)), verifiedMembers: files.length,
  }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
