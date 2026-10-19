import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const cache = process.argv[2];
if (!cache) throw new Error("Supply the read-only bare Git cache");
const root = "docs/operational-value/proof/daily-model-resolution";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const adoption = "548c141635dc069a4d17f49f4342859dcc91baf3";
const env = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
const git = (...args) => execFileSync("git", [`--git-dir=${cache}`, ...args], { env });
const packet = process.argv[3];
const supplied = new Map();
if (packet) {
  const original = readFileSync(path.join(packet, "manifest.json"));
  const manifest = JSON.parse(original);
  const owned = manifest.receipts.filter(item => item.workflow === "daily-model-resolution");
  const expected = ["02317ee742842849af4716368c5ac55afdd9cfc6",
    "01f4d457a15cfa538c22fd505167ede1126809f0", "fe49cac313067559ff1fd25e10e24d3af8a9587e"];
  if (manifest.repository !== "github/gh-aw" || manifest.repositoryId !== 1036865607
    || owned.length !== 3 || !expected.every(sha => owned.some(item => item.sha === sha))) {
    throw new Error("Packet is not the authorized exact source set");
  }
  mkdirSync(path.join(root, "acquisition"), { recursive: true });
  for (const receipt of owned) {
    if (receipt.status !== 200 || receipt.method !== "GET"
      || receipt.response !== `${receipt.sha}.response.json` || receipt.blob !== `${receipt.sha}.blob`) {
      throw new Error("Invalid source receipt");
    }
    const response = readFileSync(path.join(packet, receipt.response));
    const bytes = readFileSync(path.join(packet, receipt.blob));
    const decoded = JSON.parse(response);
    if (response.length !== receipt.bodyBytes || bytes.length !== receipt.blobBytes
      || createHash("sha256").update(response).digest("hex") !== receipt.bodySha256
      || createHash("sha256").update(bytes).digest("hex") !== receipt.blobSha256
      || decoded.sha !== receipt.sha || decoded.encoding !== "base64"
      || !Buffer.from(decoded.content, "base64").equals(bytes)
      || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== receipt.sha) {
      throw new Error("Source packet identity/integrity failure");
    }
    for (const file of [receipt.response, receipt.blob]) {
      copyFileSync(path.join(packet, file), path.join(root, "acquisition", file));
    }
    supplied.set(receipt.sha, bytes);
  }
  writeFileSync(path.join(root, "acquisition", "receipts.json"), `${JSON.stringify({
    repository: manifest.repository, repositoryId: manifest.repositoryId,
    originalManifestSha256: createHash("sha256").update(original).digest("hex"), receipts: owned,
  }, null, 2)}\n`);
}
const selected = [
  ".github/workflows/daily-model-resolution.md",
  ".github/workflows/daily-model-resolution.lock.yml",
  ".github/workflows/shared/meta-analysis-base.md",
  ".github/workflows/shared/otlp.md",
  ".github/workflows/shared/reporting.md",
  ".github/workflows/shared/noop-reminder.md",
  "pkg/cli/audit_subagent_model.go",
  "pkg/cli/audit_subagent_model_test.go",
  "pkg/cli/token_usage_subagent_identity.go",
  "pkg/cli/token_usage_subagent_identity_test.go",
  "pkg/cli/token_usage_subagent_session.go",
  "pkg/cli/token_usage_subagent.go",
  "pkg/cli/token_usage_declared_subagents.go",
  "pkg/cli/model_routing_subagent_identity_test.go",
  "pkg/workflow/engine_model_resolution_test.go",
  "docs/adr/66746-prefer-unified-sessions-for-subagent-attribution.md",
];
const records = [];
const missing = [];
mkdirSync(path.join(root, "sources"), { recursive: true });
for (const ref of [adoption, revision]) {
  const files = ref === revision
    ? [...selected, "docs/src/content/docs/specs/unified-agent-session-specification.md"] : selected;
  for (const file of files) {
    const tree = git("ls-tree", ref, "--", file).toString().trim();
    if (!tree) {
      missing.push({ revision: ref, path: file, reason: "not-in-tree" });
      continue;
    }
    const blob = tree.split(/\s+/)[2];
    const result = spawnSync("git", [`--git-dir=${cache}`, "cat-file", "blob", blob], { env });
    if (result.status !== 0 && !supplied.has(blob)) {
      missing.push({ revision: ref, path: file, blob, reason: "exact-blob-not-retained" });
      continue;
    }
    const bytes = result.status === 0 ? result.stdout : supplied.get(blob);
    const computed = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (computed !== blob) throw new Error(`Git blob integrity failure: ${file}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const destination = `sources/${blob}.json.gz`;
    writeJsonArchive(path.join(root, destination), {
      blob, sha256, bytes: bytes.length, encoding: "base64", content: bytes.toString("base64"),
    });
    records.push({ revision: ref, path: file, blob, sha256, bytes: bytes.length, file: destination });
  }
}
const metadata = [adoption, `${adoption}^`, revision].map(ref => ({
  ref, metadata: git("show", "-s", "--format=%H%n%P%n%cI%n%B", ref).toString(),
}));
const parentTree = git("ls-tree", `${adoption}^`, "--",
  ".github/workflows/daily-model-resolution.md",
  ".github/workflows/daily-model-resolution.lock.yml").toString();
if (parentTree.trim()) throw new Error("Candidate adoption is not a workflow addition");
const optionalAbsent = [adoption, revision].map(ref => {
  const file = ".github/shared-instructions.md";
  if (git("ls-tree", ref, "--", file).toString().trim()) {
    throw new Error("Optional runtime import must be inventoried");
  }
  return { revision: ref, path: file, status: "absent-optional-import" };
});
writeFileSync(path.join(root, "source-inventory.json"), `${JSON.stringify({
  schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
  revision, adoption,
  readiness: missing.some(item => item.reason === "exact-blob-not-retained") ? "incomplete" : "source-bytes-complete",
  records, missing, metadata,
  adoptionEvidence: {
    parent: "1b8bc51787713467a966e0c842672fb996763806",
    parentTree, status: supplied.size
      ? "addition-verified-original-content-retained" : "addition-verified-content-incomplete",
  },
  optionalAbsent,
}, null, 2)}\n`);
console.log(JSON.stringify({ retained: records.length, missing }, null, 2));
