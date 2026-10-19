import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { gitId, sha256, validateCustody } from "../docs/operational-value/proof/native-go-quality/custody.mjs";

const directory = new URL("../docs/operational-value/proof/native-ci/", import.meta.url);
const contractBytes = readFileSync(new URL("frozen-contract-v1.json", directory));
const contract = JSON.parse(contractBytes);
const index = readJsonArchive(fileURLToPath(new URL("index.json.gz", directory)));
assert.equal(index.contractSha256, sha256(contractBytes));
const selected = index.pulls.find(row => row.number === 18158);
assert.ok(selected?.mergedAt && selected.filesComplete);
const receipt = index.receipts["merge-18158"];
const packet = readJsonArchive(fileURLToPath(new URL(receipt.file, directory)));
assert.equal(sha256(packet.body), receipt.bodySha256);
assert.equal(packet.sha256, receipt.bodySha256);
const repair = JSON.parse(packet.body);
assert.equal(repair.sha, selected.mergeCommit);
assert.equal(repair.parents.length, 1);
assert.deepEqual(selected.paths, [".github/workflows/ci.yml"]);
const cache = process.env.NATIVE_CI_GIT_CACHE;
assert.ok(cache, "Set NATIVE_CI_GIT_CACHE to the existing read-only bare Git evidence cache");
const git = args => execFileSync("git", [`--git-dir=${cache}`, ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  maxBuffer: 64 * 1024 * 1024, timeout: 60000,
});
const archiveBlobs = new Map();
const repaired = readJsonArchive(fileURLToPath(new URL(index.receipts["fuzz-repaired-ci"].file, directory)));
assert.equal(sha256(repaired.body), index.receipts["fuzz-repaired-ci"].bodySha256);
const repairedBlob = JSON.parse(repaired.body);
assert.equal(repairedBlob.encoding, "base64");
assert.equal(repairedBlob.path, ".github/workflows/ci.yml");
const repairedBytes = Buffer.from(repairedBlob.content, "base64");
assert.equal(gitId("blob", repairedBytes), repairedBlob.sha);
archiveBlobs.set(repairedBlob.sha, repairedBytes);
if (process.env.NATIVE_CI_PARENT_TARBALL) {
  const files = JSON.parse(execFileSync("python3", ["-c", `
import base64, json, pathlib, sys, tarfile
rows = []
total = 0
with tarfile.open(sys.argv[1], "r:gz") as archive:
    for member in archive:
        parts = pathlib.PurePosixPath(member.name).parts
        if not parts or member.name.startswith("/") or ".." in parts:
            raise ValueError("Unsafe source archive member")
        relative = "/".join(parts[1:])
        selected = relative in [".github/workflows/ci.yml", "go.mod"] or (
            len(parts) == 4 and parts[1] == "pkg" and parts[2] in ["parser", "workflow"]
            and parts[3].endswith("_test.go"))
        if not selected:
            continue
        if not member.isfile() or member.size > 4 * 1024 * 1024:
            raise ValueError("Invalid native source member")
        total += member.size
        if total > 64 * 1024 * 1024:
            raise ValueError("Native source archive exceeds budget")
        content = archive.extractfile(member).read()
        rows.append({"path": relative, "base64": base64.b64encode(content).decode("ascii")})
print(json.dumps(rows))
`, process.env.NATIVE_CI_PARENT_TARBALL], { maxBuffer: 96 * 1024 * 1024, timeout: 60000 }));
  assert.equal(new Set(files.map(row => row.path)).size, files.length, "Duplicate archived source");
  for (const row of files) {
    const bytes = Buffer.from(row.base64, "base64");
    assert.equal(bytes.toString("base64"), row.base64);
    archiveBlobs.set(gitId("blob", bytes), bytes);
  }
}
const objects = new Map();
const retain = (type, id) => {
  if (objects.has(id)) return objects.get(id).content;
  assert.match(id, /^[a-f0-9]{40}$/);
  const content = type === "blob" && archiveBlobs.has(id) ? archiveBlobs.get(id) : git(["cat-file", type, id]);
  assert.equal(gitId(type, content), id);
  objects.set(id, { type, id, bytes: content.length, sha256: sha256(content),
    contentBase64: content.toString("base64"), content });
  return content;
};
const paths = [];
const inventories = [];
for (const commit of [repair.parents[0].sha, repair.sha]) {
  const raw = retain("commit", commit).toString();
  const rootTree = raw.match(/^tree ([a-f0-9]{40})$/m)?.[1];
  assert.ok(rootTree);
  retain("tree", rootTree);
  const entries = git(["ls-tree", "-r", "-t", "-z", commit]).toString().split("\0").filter(Boolean).map(line => {
    const match = line.match(/^([0-7]{6}) (blob|tree|commit) ([a-f0-9]{40})\t(.+)$/);
    assert.ok(match, "Invalid Git source inventory");
    return { mode: match[1], type: match[2], id: match[3], path: match[4] };
  });
  const inventory = entries.filter(row => /^pkg\/(?:parser|workflow)\/[^/]+_test\.go$/.test(row.path));
  inventories.push({ commit, tests: inventory.map(row => ({ path: row.path, blob: row.id })) });
  const selectedPaths = [...inventory, ...entries.filter(row => [".github/workflows/ci.yml", "go.mod"].includes(row.path))];
  for (const row of selectedPaths) {
    assert.ok(["100644", "100755"].includes(row.mode), "Nonregular native source");
    const parts = row.path.split("/");
    for (let length = 1; length < parts.length; length++) {
      const ancestor = entries.find(entry => entry.path === parts.slice(0, length).join("/"));
      assert.equal(ancestor?.type, "tree");
      retain("tree", ancestor.id);
    }
    retain("blob", row.id);
    paths.push({ commit, path: row.path, blob: row.id });
  }
}
assert.deepEqual(inventories[0].tests, inventories[1].tests, "Fuzz source inventory changed across the CI-only repair");
const data = { repository: contract.repository, repositoryId: contract.repositoryId,
  revision: contract.revision, cutoff: contract.cutoff, contractSha256: sha256(contractBytes), paths, inventories };
const originals = [...objects.values()].map(({ content: _content, ...row }) => row);
validateCustody(data, originals);
writeJsonArchive(fileURLToPath(new URL("native-sources.json.gz", directory)), { data, originals });
console.log(JSON.stringify({ testFilesPerEndpoint: inventories[0].tests.length,
  gitObjects: originals.length, actualParent: repair.parents[0].sha, commit: repair.sha,
  targetCodeExecuted: false, status: "source custody only, no native qualification" }));
