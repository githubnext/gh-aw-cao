import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readOutputHistory } from "../../../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const [gitDirectory, historyDirectory] = process.argv.slice(2);
if (!gitDirectory || !historyDirectory || process.argv.length !== 4) {
  throw new Error("usage: node retain-sources.mjs READ_ONLY_GIT_DIRECTORY VERIFIED_HISTORY_DIRECTORY");
}
const directory = path.dirname(fileURLToPath(import.meta.url));
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const addition = "a38bf5047d5f3823d4008d161a56d0bb735d98cc";
const parent = "7c1cc96022a05da6c253224b9d0f0bddae68d19b";
const workflow = ".github/workflows/daily-model-inventory.md";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const git = args => execFileSync("git", [`--git-dir=${gitDirectory}`, ...args], {
  env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0" },
  maxBuffer: 32 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});
const files = [
  workflow, ".github/workflows/daily-model-inventory.lock.yml",
  ".github/workflows/shared/otlp.md", ".github/aw/llms.md",
  ".github/drivers/copilot_sdk_driver_sample_node.cjs",
  "pkg/workflow/data/model_aliases.json", "actions/setup/js/model_aliases.json",
  "actions/setup/js/resolve_model_alias.cjs", "actions/setup/js/resolve_model_alias.test.cjs",
  "pkg/workflow/model_aliases.go", "pkg/workflow/model_alias_validation.go",
  "docs/src/content/docs/specs/model-alias-specification.md",
  "pkg/cli/data/models.json", "actions/setup/js/models.json",
];
mkdirSync(directory, { recursive: true });
const records = [], unavailable = [];
for (const [ref, names] of [[revision, files], [addition, [workflow, ".github/workflows/shared/otlp.md"]]]) {
  for (const name of names) {
    const tree = git(["ls-tree", ref, "--", name]).toString().trim();
    if (!tree) {
      unavailable.push({ revision: ref, path: name, reason: "Path absent from retained immutable tree" });
      continue;
    }
    const blob = tree.split(/\s+/)[2];
    let bytes;
    try {
      bytes = git(["cat-file", "blob", blob]);
    } catch (error) {
      if (!String(error.stderr).includes("could not get object info")
        && !String(error.stderr).includes("bad file")
        && !String(error.stderr).includes("unable to read")) throw error;
      unavailable.push({ revision: ref, path: name, gitBlob: blob,
        reason: "Blob unavailable in offline cache; lazy fetching prohibited" });
      continue;
    }
    const computed = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (computed !== blob) throw new Error(`Git identity mismatch: ${name}`);
    if (name === workflow && ref === revision && blob !== "809b23ebbfc03d891701382286cf0c3417c6b153") {
      throw new Error("Frozen workflow identity mismatch");
    }
    records.push({ repository: "github/gh-aw", repositoryId: 1036865607,
      revision: ref, path: name, gitBlob: blob, sha256: sha256(bytes), bytes: bytes.length,
      body: bytes.toString("utf8") });
  }
}
const additionMetadata = git(["show", "-s", "--format=%H%n%P%n%cI", addition]).toString().trim().split("\n");
if (additionMetadata[1].split(" ")[0] !== parent) throw new Error("Addition parent mismatch");
const parentEntry = git(["ls-tree", parent, "--", workflow]).toString().trim();
if (parentEntry) throw new Error("Claimed addition already existed in parent");
const { index, entities } = readOutputHistory(historyDirectory);
if (index.sourceRevision !== revision || index.repositoryId !== 1036865607
  || index.until !== "2026-10-18T15:00:12Z") throw new Error("History scope mismatch");
const selected = entities.filter(entity => entity.workflowReference?.workflowId === "daily-model-inventory"
  || entity.workflowReference?.trackerId === "daily-model-inventory"
  || entity.unverifiedWorkflowId === "daily-model-inventory");
const history = { index, selected, selectedCount: selected.length,
  use: "Discovery only. Editable markers, closure and merge states do not prove model support or contribution." };
writeJsonArchive(path.join(directory, "sources.json.gz"), { records, unavailable });
writeJsonArchive(path.join(directory, "discovery.json.gz"), history);
const inventory = {
  schemaVersion: 1, repository: index.repository, repositoryId: index.repositoryId,
  revision, cutoff: index.until,
  sourceAddition: { commit: addition, parent, committedAt: new Date(additionMetadata[2]).toISOString().replace(".000Z", "Z"),
    actualParentTreeChecked: true, parentWorkflowAbsent: true,
    adoptionSourceAvailable: records.some(record => record.revision === addition && record.path === workflow),
    interpretation: "Verified source addition, not proof of organization installation or retained provider inventories." },
  sourceRecords: records.map(({ body, ...identity }) => identity), unavailable,
  discovery: { partitionsVerified: index.partitions.length, entitiesVerified: index.totalEntities,
    selectedCount: selected.length, complete: index.complete,
    indexSha256: sha256(JSON.stringify(index)), selectedSha256: sha256(JSON.stringify(selected)) },
  observations: [],
  readiness: {
    source: "retained-current-source", nativeInstrument: "implemented-separately",
    providerInventory: "missing", baseline: "unavailable-not-exhausted",
    fullAcceptance: "not-measured", contribution: "not-measured", costs: "not-measured",
  },
  openScopes: [
    { kind: "immutable-baseline", endpoint: `repos/github/gh-aw/git/trees/${parent}`,
      needed: "Baseline alias map and contemporaneous complete provider inventory; current predicates are not backdated." },
    { kind: "provider-inventory", endpoint: "https://api.openai.com/v1/models",
      needed: "Independently retained complete account-scoped responses with protected receipt and capture cutoff." },
    { kind: "provider-inventory", endpoint: "https://api.anthropic.com/v1/models",
      needed: "All pages and terminal has_more=false, protected capture receipt, applicable access scope." },
    { kind: "provider-inventory", endpoint: "https://generativelanguage.googleapis.com/v1beta/models",
      needed: "All pages through absent nextPageToken, protected capture receipt, applicable access scope." },
    { kind: "provider-inventory", endpoint: "http://api-proxy:10000/reflect",
      needed: "Protected configured Copilot endpoint models, models_fetch_complete=true, same workflow access scope; never call from this evaluator." },
    { kind: "secondary-catalog", endpoint: "https://models.dev/api.json",
      needed: "Dated secondary catalog; not independently sufficient evidence of live provider availability." },
    { kind: "full-acceptance", endpoint: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
      needed: "Protected SDK, reflect and pricing captures plus mirror preservation, capability and routing checks." },
    { kind: "contribution", endpoint: "repos/github/gh-aw/actions/runs/{selectedRunId}/artifacts",
      needed: "Bounded selected-run receipts and independently verified graph/native before-after facts; issue bodies are discovery only." },
  ],
  acquisition: "Offline only. Request a bounded coordinator slot before any acquisition; do not automatically resume.",
};
writeJsonArchive(path.join(directory, "retained.json"), inventory);
console.log(JSON.stringify({ sources: records.length, unavailable, selected: selected.length,
  addition: inventory.sourceAddition }));
