import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { cutoff, revision, repository, normativePath, documentationPath, sourceText,
  extractDocumentationRules, hash } from "../docs/operational-value/proof/cli-consistency-checker/native.mjs";

const directory = "docs/operational-value/proof/cli-consistency-checker";
const source = readJsonArchive(path.join(directory, "source.json.gz"),
  { maxDecodedBytes: 64 * 1024 * 1024, maxParts: 512 });
const rules = extractDocumentationRules(sourceText(source, normativePath));
const workflow = sourceText(source, ".github/workflows/cli-consistency-checker.md");
if (source.files.find(file => file.path === ".github/workflows/cli-consistency-checker.md")?.blob
  !== "1c1b852850fd69016d2b550a9adb38219eb11f30") throw new Error("Wrong workflow source");
const contract = {
  schemaVersion: 3, repository, repositoryId: 1036865607, revision, cutoff,
  intent: {
    goal: "Make CLI commands consistent, well documented and free of user-facing defects.",
    sourceQuote: workflow.slice(workflow.indexOf("Perform a comprehensive inspection"), workflow.indexOf("**Repository**")).trim(),
    fullAcceptance: "For each command, source-defined documentation and convention obligations plus independently verified real help, example validity and behavior must agree. No known required facet may be missing.",
    partialAcceptance: "A source-defined literal documentation obligation is attained exactly when its Contains/NotContains predicate, with the original source scope, holds on the immutable CLI documentation bytes.",
  },
  activation: { kind: "contract-activation", at: cutoff, commit: revision,
    limitation: "Current-source contract activated at the frozen cutoff, not workflow adoption. No application to earlier intent or conventions." },
  units: { primary: "percent of frozen literal documentation obligations attained",
    full: "percent of independently accepted commands; unavailable without complete command/help/behavior evidence" },
  eligibility: { sourceTests: [...new Set(rules.map(rule => rule.test))],
    included: "Every literal string Contains/NotContains assertion over text, compileSection or updateSection in these source-native tests.",
    excluded: "Engine-registry-dependent assertion remains inventoried and unavailable; not silently classified as clean.",
    scope: "compileSection and updateSection intentionally retain the original tests' suffix-of-document semantics, not a narrowed heading section." },
  rules, rulesDigest: hash(JSON.stringify(rules)), documentationPath, normativePath,
  window: { measurementKind: "snapshot", durationDays: 1, cadenceDays: 1, maturationDays: 0,
    reason: "Repository state, sampled at most once per daily workflow cadence; no overlapping flow totals." },
  antecedentExistence: { result: "pre-existing-but-not-reconstructable",
    reason: "Commands, documentation and source-native convention checks can exist without the workflow. Historical source closure, actual adoption parent and contemporaneous native outputs have not been established in this bounded instrument.",
    classification: "attainment-only at contract activation; no workflow-adoption comparison" },
  nativeMeasures: [
    { name: "real command help", disposition: "required full-acceptance gate", status: "raw bytes and source/toolchain-bound capture receipts unavailable" },
    { name: "literal native documentation assertions", disposition: "implemented independent partial outcome, primary facet" },
    { name: "source-defined help prefix and usage/example order", disposition: "implemented raw-output interpreter; missing actual captured help" },
    { name: "example flag/path validity and behavioral agreement", disposition: "required full-acceptance gate; command registry and execution receipts not acquired" },
    { name: "commands inspected, findings/severity counts, issued tracking item", disposition: "rejected primary proxies" },
    { name: "trajectory graders and workflow evals", disposition: "mechanism diagnostics, not repository outcomes" },
  ],
  invariants: [
    "No labels, finding counts, green runs, merged links or caller acceptance flags establish accepted commands.",
    "Actor independent; partial conformance may improve without claiming whole CLI usability or causal contribution.",
    "No monetary weights, subjective thresholds or keep/change bars.",
    "Missing source or native evidence is null, never an all-clear.",
    "Discovery lineage is retained losslessly, never scored as acceptance or contribution.",
  ],
  evidenceAvailability: { exactFrozenCutoff: "immutable source snapshot only",
    earlier: "incompatible/unacquired historical profile", later: "latest-commit closure and runtime receipts missing" },
};
mkdirSync(directory, { recursive: true });
const target = path.join(directory, "contract.json");
if (existsSync(target) && JSON.stringify(readJsonArchive(target)) !== JSON.stringify(contract)) {
  throw new Error("Refusing to replace the frozen contract; review a new contract version separately");
}
if (!existsSync(target)) writeJsonArchive(target, contract);
console.log(JSON.stringify({ frozenBeforeOutputHistory: true, rules: rules.length,
  literalRules: rules.filter(rule => rule.expected !== null).length, rulesDigest: contract.rulesDigest }));
