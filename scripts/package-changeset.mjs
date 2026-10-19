import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const proof = "docs/operational-value/proof/changeset";
const owned = ["docs/operational-value/proof/functions/changeset.mjs", proof,
  "scripts/collect-changeset.mjs", "scripts/native-changeset.mjs", "scripts/package-changeset.mjs",
  "tests/unit/operational-value-changeset.test.mjs"];
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const [destination, seed, seedManifest] = process.argv.slice(2);
if (!destination || !seed || !seedManifest) throw new Error("usage: package-changeset.mjs DESTINATION SEED_TAR_GZ SEED_MANIFEST");
if (digest(readFileSync(seed)) !== "b30a55ef9a389bbce4500270bfdac715c87bbd9cef68e3463e9661de873ef835"
  || digest(readFileSync(seedManifest)) !== "e15c42d73b26ceb2cc560378f25a28155bc5454ef929e861ffd9bacc57bf09fd") {
  throw new Error("Seed integrity mismatch");
}
const expand = file => {
  const full = path.join(root, file);
  const stat = lstatSync(full);
  if (stat.isSymbolicLink()) throw new Error("Unexpected owned symlink");
  return stat.isDirectory() ? readdirSync(full).sort().flatMap(name => expand(`${file}/${name}`)) : [file];
};
const files = owned.flatMap(expand).sort();
for (const file of files) {
  if (lstatSync(path.join(root, file)).size > 256 * 1024) throw new Error(`Oversized handoff member: ${file}`);
}
const run = (command, args, cwd = root) => execFileSync(command, args, {
  cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 120000,
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0",
    GH_TOKEN: "", GITHUB_TOKEN: "", CAO_OPERATIONAL_VALUE_MODULE: "changeset" },
});
const summary = directory => {
  const timeline = readJsonArchive(path.join(directory, proof, "evaluation/github-gh-aw/changeset-timeline.json"),
    { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
  return timeline.snapshots.map(row => ({ at: row.observedAt, window: row.window, metrics: row.metrics,
    evidence: digest(JSON.stringify(row.evidence)), provenance: row.provenance }));
};
const expected = summary(root);
const temporary = mkdtempSync(path.join(root, ".changeset-replay."));
mkdirSync(destination, { recursive: true });
try {
  const baseline = path.join(temporary, "baseline.tar");
  execFileSync("git", ["archive", "--format=tar", `--output=${baseline}`, "HEAD"], { cwd: root });
  const checkout = path.join(temporary, "checkout");
  mkdirSync(checkout);
  run("tar", ["-xf", baseline, "-C", checkout]);
  run("tar", ["-xzf", path.resolve(seed), "-C", checkout]);
  const manifest = JSON.parse(readFileSync(seedManifest));
  for (const member of manifest.files) {
    const bytes = readFileSync(path.join(checkout, member.path));
    if (bytes.length !== member.bytes || digest(bytes) !== member.sha256) throw new Error("Extracted seed integrity mismatch");
  }
  const archive = path.resolve(destination, "changeset-owned.tar.gz");
  if (existsSync(archive)) throw new Error("Handoff already exists; choose a new destination");
  run("tar", ["-czf", archive, ...files]);
  run("tar", ["-xzf", archive, "-C", checkout]);
  const focused = run(process.execPath, ["--test", "tests/unit/operational-value-changeset.test.mjs"], checkout);
  const verification = run(process.execPath, [".github/skills/add-operational-value/scripts/verify-value-function.mjs",
    "--collector", "docs/operational-value/proof/functions/changeset.mjs"], checkout);
  const evaluation = run(process.execPath, [".github/skills/add-operational-value/scripts/evaluate.mjs",
    "--root", checkout, "--end", "2026-10-18T15:00:12Z", "--refresh", "--no-runs",
    "--function", "docs/operational-value/proof/functions/changeset.mjs",
    "--output-dir", `${proof}/evaluation`, "github/gh-aw", "changeset"], checkout);
  const actual = summary(checkout);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("Fresh extraction changed deterministic native results");
  const result = { schemaVersion: 1, archive: archive, archiveSha256: digest(readFileSync(archive)),
    seedSha256: digest(readFileSync(seed)), seedManifestSha256: digest(readFileSync(seedManifest)),
    files: files.map(file => ({ path: file, bytes: lstatSync(path.join(root, file)).size,
      sha256: digest(readFileSync(path.join(root, file))) })),
    replay: { baseline: run("git", ["rev-parse", "HEAD"]).trim(),
      seedMembersVerified: manifest.files.length, ownedOnly: true,
      sharedGitOrHistoryAccess: false, deterministicSummarySha256: digest(JSON.stringify(actual)),
      focused, verification, evaluation } };
  const external = path.resolve(destination, "changeset-owned.manifest.json");
  writeFileSync(external, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ archive, archiveSha256: result.archiveSha256,
    manifest: external, manifestSha256: digest(readFileSync(external)), members: files.length,
    replay: "baseline + all32 verified seed members + owned archive; deterministic results identical" }, null, 2));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
