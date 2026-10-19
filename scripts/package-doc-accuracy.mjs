import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "../docs/operational-value/proof/doc-accuracy/objects.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkpoint = "590529ea3a0a6e4dab9e57f933b4b01f69f0fb77";
const proof = "docs/operational-value/proof/doc-accuracy";
const slugs = ["designer-drift-audit", "daily-doc-healer", "daily-doc-updater"];
const scripts = ["scripts/collect-doc-accuracy.mjs", "scripts/native-doc-accuracy.mjs", "scripts/package-doc-accuracy.mjs"];
const ownModules = slugs.map(slug => `docs/operational-value/proof/functions/${slug}.mjs`);
const test = "tests/unit/operational-value-doc-accuracy.test.mjs";
const walk = dir => readdirSync(dir).flatMap(name => {
  const file = path.join(dir, name), info = lstatSync(file);
  if (info.isSymbolicLink()) throw new Error("Symlink in owned handoff");
  return info.isDirectory() ? walk(file) : [file];
});
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options,
});
const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const record = (directory, file) => {
  const bytes = readFileSync(path.join(directory, file));
  if (bytes.length > 256 * 1024) throw new Error(`Owned file exceeds 256KiB: ${file}`);
  return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
};
const same = (a, b, message) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(message); };

const [output, seedArchive, seedManifest] = process.argv.slice(2).map(value => path.resolve(value));
if (!output || !seedArchive || !seedManifest) throw new Error("usage: package-doc-accuracy.mjs OUTPUT_DIR SEED.tar.gz SEED.manifest.json");
mkdirSync(output, { recursive: true });
const seedPin = "f70992410c521b739bd323485108381cf6c9fbf41b6fb12c6f56b664c84f86fb";
const seedManifestPin = "24a1ddee03dcf2cf2047fa40d6e57c86f2ec7cc63ebac7e8911c6ff8ee17fef6";
if (sha256(readFileSync(seedArchive)) !== seedPin || sha256(readFileSync(seedManifest)) !== seedManifestPin) {
  throw new Error("Historical seed envelope mismatch");
}
const seed = JSON.parse(readFileSync(seedManifest));
const members = run("tar", ["-tzf", seedArchive]).trim().split("\n");
same([...members].sort(), seed.files.map(file => file.path).sort(), "Seed member set mismatch");
if (members.length !== 35 || new Set(members).size !== 35
  || members.some(file => file.startsWith("/") || file.startsWith("-") || file.split("/").includes(".."))
  || run("tar", ["-tvzf", seedArchive]).trim().split("\n").some(line => !line.startsWith("-"))) {
  throw new Error("Unsafe seed archive");
}
for (const entry of seed.files) {
  const bytes = execFileSync("tar", ["-xOzf", seedArchive, entry.path], { maxBuffer: 8 * 1024 * 1024 });
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error("Seed member digest mismatch");
}

const dependencyPaths = run("git", ["ls-tree", "-r", "--name-only", checkpoint, "--", ".github/skills/add-operational-value"])
  .trim().split("\n");
const dependencies = dependencyPaths.map(file => {
  const original = execFileSync("git", ["show", `${checkpoint}:${file}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  if (!original.equals(readFileSync(path.join(root, file)))) throw new Error(`Unexpected dependency change: ${file}`);
  return { path: file, bytes: original.length, sha256: sha256(original) };
});
const dependencyManifest = { checkpoint, skillVersion: "0.18.2", files: dependencies,
  historicalSeed: { archiveSha256: seedPin, manifestSha256: seedManifestPin, members: 35, skillVersion: "0.18.1" } };
json(path.join(output, "doc-accuracy.dependencies.json"), dependencyManifest);

const owned = [...walk(path.join(root, proof)).map(file => path.relative(root, file)), ...ownModules, ...scripts, test].sort();
const manifest = { schemaVersion: 1, checkpoint, files: owned.map(file => record(root, file)) };
const archiveFile = path.join(output, "doc-accuracy.owned.tar.gz");
const manifestFile = path.join(output, "doc-accuracy.manifest.json");
run("tar", ["-czf", archiveFile, ...owned]);
json(manifestFile, manifest);

const replay = mkdtempSync(path.join(output, "doc-accuracy-replay-"));
const commands = [];
const execute = args => {
  const env = { ...process.env, PATH: `${path.join(replay, ".no-network-bin")}:${process.env.PATH}`,
    NODE_OPTIONS: `--import=${path.join(replay, proof, "render-clock.mjs")}`, GIT_NO_LAZY_FETCH: "1" };
  commands.push({ command: ["node", ...args], output: run(process.execPath, args, { cwd: replay, env }) });
};
try {
  run("tar", ["-xzf", seedArchive, "-C", replay]);
  for (const entry of dependencies) {
    const file = path.join(replay, entry.path);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, execFileSync("git", ["show", `${checkpoint}:${entry.path}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 }));
  }
  run("tar", ["-xzf", archiveFile, "-C", replay]);
  for (const entry of manifest.files) same(record(replay, entry.path), entry, "Owned archive replay mismatch");
  const blockers = path.join(replay, ".no-network-bin");
  mkdirSync(blockers);
  for (const command of ["git", "gh", "curl", "wget", "npm", "npx"]) {
    const file = path.join(blockers, command);
    writeFileSync(file, "#!/bin/sh\nprintf '%s\\n' 'Network/acquisition/install command forbidden during replay' >&2\nexit 99\n");
    chmodSync(file, 0o755);
  }
  if (existsSync(path.join(replay, "node_modules")) || existsSync(path.join(replay, ".git"))) {
    throw new Error("Replay baseline must not have dependencies or Git history");
  }
  execute(["--test", test]);
  execute(["scripts/collect-doc-accuracy.mjs"]);
  const products = {};
  for (const slug of slugs) {
    const module = `docs/operational-value/proof/functions/${slug}.mjs`;
    execute([".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", module]);
    execute([".github/skills/add-operational-value/scripts/evaluate.mjs", "--end", "2026-10-18T15:00:12Z",
      "--output-dir", `${proof}/reports`, "--function", module, "--refresh", "github/gh-aw", slug]);
    const files = [module, ...["timeline.json", "pulse.html", "pulse.json"].map(suffix => `${proof}/reports/github-gh-aw/${slug}-${suffix}`)];
    products[slug] = files.map(file => {
      const expected = record(root, file), actual = record(replay, file);
      same(actual, expected, `Canonical replay differs: ${file}`);
      return actual;
    });
  }
  for (const file of owned.filter(file => file.startsWith(`${proof}/reports/`))) {
    same(record(replay, file), record(root, file), `Preserved report replay differs: ${file}`);
  }
  same(record(replay, `${proof}/native-observations.json.gz`), record(root, `${proof}/native-observations.json.gz`),
    "Native collector replay differs");
  const receipt = { schemaVersion: 1, status: "passed", archiveSha256: sha256(readFileSync(archiveFile)),
    manifestSha256: sha256(readFileSync(manifestFile)), dependenciesSha256: sha256(readFileSync(path.join(output, "doc-accuracy.dependencies.json"))),
    baseline: checkpoint, seed: dependencyManifest.historicalSeed,
    replay: "Fresh verified seed plus exact 0.18.2 checkpoint skill closure and owned-only archive; no shared cache, history, node_modules or acquisition/network/install commands.",
    renderClock: "Observed report-generation timestamp 2026-10-19T13:51:00Z; not historical observation or adoption.",
    validation: { nodeTests: 17, lint: "ESLint unavailable; dependency installation prohibited.", targetCodeExecuted: false },
    nativeQuantities: { "designer-drift-audit": 12, "daily-doc-healer": 2, "daily-doc-updater": 1 },
    readiness: Object.fromEntries(slugs.map(slug => [slug, {
      instrument: "ready: schema3 collector, scorer and canonical refresh independently replayed",
      nativeQualification: "qualified source-applicable repository partial; bounded cohort, not exhaustive delivery",
      authoring: "Outcome-informed retrospective v2; original v1 and rejected v2 predicates preserved.",
      strictGoalAcceptance: null, workflowContribution: null, decision: "not rated", cost: "not measured",
    }])),
    strictSemanticAcceptance: null, workflowContribution: null, products, commands };
  json(path.join(output, "doc-accuracy.replay.json"), receipt);
  console.log(JSON.stringify({ archive: archiveFile, archiveSha256: receipt.archiveSha256,
    manifest: manifestFile, manifestSha256: receipt.manifestSha256,
    receipt: path.join(output, "doc-accuracy.replay.json"),
    receiptSha256: sha256(readFileSync(path.join(output, "doc-accuracy.replay.json"))), products }, null, 2));
} finally {
  rmSync(replay, { recursive: true });
}
