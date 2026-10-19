import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { definition } from "../functions/daily-model-inventory.mjs";
import { readJsonArchive, writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const [destination] = process.argv.slice(2);
if (!destination || process.argv.length !== 3 || !path.isAbsolute(destination)) {
  throw new Error("usage: node package-handoff.mjs ABSOLUTE_SESSION_ARTIFACT_DIRECTORY");
}
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../../..");
const ownedDirectory = path.relative(root, directory);
const modulePath = path.relative(root, path.join(directory, "../functions/daily-model-inventory.mjs"));
const testPath = "tests/unit/operational-value-daily-model-inventory.test.mjs";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const retained = readJsonArchive(path.join(directory, "retained.json"));
const relocation = readJsonArchive(path.join(directory, "relocation-equivalence.json"));
const reportDirectory = path.join(directory, "reports/github-gh-aw");
const reports = readdirSync(reportDirectory).sort().map(name => ({
  path: path.relative(root, path.join(reportDirectory, name)),
  sha256: hash(readFileSync(path.join(reportDirectory, name))),
}));
const sourceHashes = retained.sourceRecords.map(({ revision, path, gitBlob, sha256 }) =>
  ({ revision, path, gitBlob, sha256 }));
writeJsonArchive(path.join(directory, "handoff.json"), {
  workflow: definition.slug, repository: definition.repository, repositoryId: 1036865607,
  sourceRevision: definition.sourceProfile.revision, cutoff: definition.sourceProfile.cutoff,
  sourceWorkflowGitBlob: definition.sourceProfile.workflowGitBlob,
  function: { path: modulePath, sha256: hash(readFileSync(path.join(root, modulePath))) },
  relocation: {
    originalFunction: relocation.originalFunction, relocatedFunction: relocation.relocatedFunction,
    receipt: `${ownedDirectory}/relocation-equivalence.json`,
    receiptSha256: hash(readFileSync(path.join(directory, "relocation-equivalence.json"))),
    losslessOriginalPackage: `${ownedDirectory}/pre-relocation.json.gz`,
    originalMembers: 20, outcomeAcceptanceAndObservationsUnchanged: true,
  },
  focusedTests: testPath,
  sources: sourceHashes, reports,
  standardCollectorVerified: true, nativeBoundaryTests: 18,
  outcome: { eligibleAliases: 62, primaryValue: null, diagnosticValues: null,
    reason: "Authoritative complete live-provider inventories were not retained.",
    sourceAdditionVerified: true, currentSourceRetained: true,
    discoveryCandidates: retained.discovery.selectedCount,
    historicalBaseline: "unavailable-not-exhausted", fullAcceptance: "not-measured",
    contribution: "not-measured", costs: "not-measured", decision: "not-rated" },
  openScopes: [...retained.openScopes, ...retained.unavailable.filter(row => row.gitBlob).map(row => ({
    kind: "historical-source-dependency", endpoint: `repos/github/gh-aw/git/blobs/${row.gitBlob}`,
    revision: row.revision, path: row.path, reason: row.reason,
  }))],
  permission: "No network or further acquisition released. Continue only after a new bounded coordinator slot. No commits, PR, enrollment or deployment.",
  seed: { archiveSha256: "b51243e0777815f56b9e782825af50256d1b9ea68470857c7873a8a3275188ea",
    manifestSha256: "f38fb273e21b5114c9181836974cfa179b5b188e11d9e94258057fab39301ae3",
    membersVerified: 32, includedInPackage: false,
    executionBits: "Restored executable bits on existing standard evaluator CLI helpers; no shared helper content was changed beyond the verified seed." },
  validationLimitations: "No local ESLint/TypeScript dependencies; no installation permitted. Owned modules pass node --check, focused tests, and standard --collector/evaluator. Shared helpers and generated Markdown were not compiled offline.",
});
function filesWithin(relative) {
  const absolute = path.join(root, relative);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error("Symlinks cannot enter owned package");
  if (stat.isDirectory()) return readdirSync(absolute).sort().flatMap(name => filesWithin(path.join(relative, name)));
  if (!stat.isFile() || stat.size > 256 * 1024) throw new Error(`Invalid/oversize package member: ${relative}`);
  const bytes = readFileSync(absolute);
  if (relative.endsWith(".mjs") && bytes.toString().split("\n").length > 3000) {
    throw new Error(`Oversize source module: ${relative}`);
  }
  return [{ path: relative, sha256: hash(bytes), bytes: bytes.length }];
}
const files = [modulePath, ownedDirectory, testPath].flatMap(filesWithin).sort((a, b) => a.path.localeCompare(b.path));
const archive = path.join(destination, "daily-model-inventory-relocated-owned.tar.gz");
const manifest = path.join(destination, "daily-model-inventory-relocated-owned.manifest.json");
const list = path.join(destination, "daily-model-inventory-relocated-owned-files.txt");
writeFileSync(list, `${files.map(file => file.path).join("\n")}\n`);
try {
  execFileSync("tar", ["-czf", archive, "-T", list], {
    cwd: root, env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: "inherit",
  });
} finally {
  rmSync(list);
}
writeFileSync(manifest, `${JSON.stringify({
  schemaVersion: 1, workflow: definition.slug, repository: definition.repository,
  archiveSha256: hash(readFileSync(archive)), files,
}, null, 2)}\n`);
console.log(JSON.stringify({ archive, archiveSha256: hash(readFileSync(archive)), manifest,
  manifestSha256: hash(readFileSync(manifest)), members: files.length }));
