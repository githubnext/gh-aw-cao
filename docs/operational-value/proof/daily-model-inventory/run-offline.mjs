import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectBatch, definition, scoreMetric } from "../functions/daily-model-inventory.mjs";
import { writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(directory, "../../../..");
const modulePath = path.join(directory, "../functions/daily-model-inventory.mjs");
const skill = path.join(root, ".github/skills/add-operational-value/scripts");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const functionSha256 = sha256(readFileSync(modulePath));
writeJsonArchive(path.join(directory, "frozen-definition.json"), {
  functionSha256, definition,
  freezeBasis: "Complete frozen current workflow, imports, runtime checker, alias payload and relevant specification. No live provider outcomes were available or used to select predicates.",
});
execFileSync(process.execPath, ["--test", path.join(root, "tests/unit/operational-value-daily-model-inventory.test.mjs")],
  { cwd: root, stdio: "inherit" });
execFileSync(process.execPath, [path.join(skill, "verify-value-function.mjs"), "--collector", modulePath],
  { cwd: root, stdio: "inherit" });
const [collection] = await collectBatch([{
  windowStart: definition.adoption.adoptedAt, windowEnd: definition.sourceProfile.cutoff,
  observedAt: definition.sourceProfile.cutoff,
}]);
writeJsonArchive(path.join(directory, "native-observation.json"), {
  functionSha256, ...collection,
  metrics: Object.fromEntries(definition.metrics.map(metric => [metric.id, scoreMetric(metric.id, collection.evidence)])),
  interpretation: "Repository alias population is retained; live support and absence are unknown without independent provider inventories. This is not a successful native value measurement.",
});
execFileSync(process.execPath, [path.join(skill, "evaluate.mjs"), "--root", root,
  "--end", definition.sourceProfile.cutoff, "--output-dir", path.relative(root, path.join(directory, "reports")),
  "--function", path.relative(root, modulePath), "--no-runs", definition.repository, definition.slug],
{ cwd: root, stdio: "inherit" });
if (sha256(readFileSync(modulePath)) !== functionSha256) throw new Error("Frozen function changed during evaluation");
writeJsonArchive(path.join(directory, "runbook.json"), {
  workflow: definition.slug, sourceRevision: definition.sourceProfile.revision,
  evaluate: "node docs/operational-value/proof/daily-model-inventory/run-offline.mjs",
  tests: "node --test tests/unit/operational-value-daily-model-inventory.test.mjs",
  collectorVerification: "node .github/skills/add-operational-value/scripts/verify-value-function.mjs --collector docs/operational-value/proof/functions/daily-model-inventory.mjs",
  functionSha256,
  status: {
    instrument: "implemented-and-verified", currentSource: "retained",
    currentEligibleAliases: collection.evidence.eligibleCount,
    providerInventories: "missing", nativeValue: "unavailable",
    baseline: "unavailable-not-exhausted", fullAcceptance: "not-measured",
    workflowContribution: "not-measured", costs: "not-measured", decision: "not-rated",
  },
  inputContract: {
    collector: "collectBatch(requests, {inventories}) consumes protected, digest-bound complete raw provider captures; default offline evaluation has no such captures and remains missing.",
    receiptAuthority: "Digest checks prove integrity and scope binding, not independent producer identity by themselves. Acquisition must supply independently protected capture receipts; editable agent claims are not those receipts.",
    rawPages: "Each page binds cursor, HTTP status, whole decoded JSON body and SHA256(JSON.stringify(body)). Receipt capture binds repository ID, provider, access scope, endpoint, UTC cutoff, completion and SHA256(JSON.stringify(pages)).",
    pagination: "Anthropic has_more/last_id and Gemini nextPageToken chains must be contiguous and terminal. The frozen OpenAI endpoint has no pagination; unexpected pagination fails closed. Reflect requires configured Copilot models and models_fetch_complete=true.",
    empty: "Empty model lists and provider errors are unknown by the workflow's explicit skip rule.",
    temporal: "Capture time must equal requested state cutoff. Only the retained frozen source cutoff is currently accepted; newer/older source eras remain missing. Snapshot starts are comparison cutoffs, not delivery intervals.",
    scope: "Built-in aliases only. Per-engine provider catalogs canonicalize synonyms; full recursive pattern lists and exact bare-ID fallback are assessed. A stale proof is intentionally conservative when a bare fallback could use any provider.",
    unknowns: "Primary null unless every alias is assessed. Diagnostic native support and established-stale subtotal can survive partial coverage, with unknown denominator and full acceptance visible.",
    fixtureBoundary: "Synthetic fixtures exist only in validationExamples and native tests. They are never retained as historical observations.",
  },
  limitations: [
    "No independently retained live-provider inventory was available. Missing evidence is not zero stale aliases or demonstrated good work.",
    "Current activation is the frozen source revision, not actual workflow installation. Source addition was verified separately against the real parent.",
    "Adoption workflow and native Go alias checker are retained. One transitive adoption telemetry import remains unavailable; no historical scoring is attempted.",
    "Pricing mirrors and historical entries are preserved as whole sources. Source mirror equality is not complete pricing correctness or live support.",
    "166 selected workflow-linked issue/PR discovery records are retained; none is accepted as an alias repair or contribution.",
    "Snapshot stale burden is not interval delivery. No overlapping credit, summed snapshots, arbitrary keep bars, weights, savings or causal claims.",
    "No network performed here; source-only coordinator receipts are retained. Any further acquisition needs a new bounded coordinator slot.",
    "ESLint and TypeScript executables/dependencies are unavailable locally; no installation was performed under the no-network/no-installs constraint.",
    "Generated report Markdown is not a workflow source change; compilation was not attempted under offline-only execution.",
  ],
});
console.log(JSON.stringify({ functionSha256, nativeValue: "unavailable", eligibleAliases: collection.evidence.eligibleCount }));
