import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { updateJsonHash, updateScope } from "./collect-cross-repo-update-value.mjs";

const root = "docs/operational-value/proof/cross-repo-update";
const source = readJsonArchive(`${root}/sources.json`);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const priorFunctionSha256 = "ffd3f2f28b6e11505690c5dbbf8f63f4d958df37fd9db64dd66f4055aeaa2bf6";
const priorArchive = `${root}/versions/${priorFunctionSha256}/sealed-predecessor.json`;
const predecessor = readJsonArchive(priorArchive);
if (hash(Buffer.from(predecessor.archive.content, "base64")) !== predecessor.archive.sha256
  || predecessor.archive.sha256 !== "efca9e5d33db360e3eab435937bc4060af3a4d08135bba59b652e2175830bea1") {
  throw new Error("Sealed predecessor archive changed");
}
const supersede = process.argv.slice(2);
if (supersede.length && (supersede.length !== 2 || supersede[0] !== "--supersede"
  || supersede[1] !== priorFunctionSha256)) throw new Error("Invalid explicit predecessor fingerprint");
const profiles = source.profiles.toReversed().map(profile => {
  const text = Buffer.from(profile.content, "base64").toString("utf8");
  const frontmatter = parse(text.split("---")[1]);
  const compiled = parse(Buffer.from(profile.compiled.content, "base64").toString("utf8"));
  const push = frontmatter["safe-outputs"]["push-to-pull-request-branch"];
  const configs = Object.values(compiled.jobs).flatMap(job => (job.steps ?? [])
    .map(step => step.env?.GH_AW_SAFE_OUTPUTS_HANDLER_CONFIG).filter(Boolean));
  return { commit: profile.commit, gitBlob: profile.gitBlob, at: profile.at,
    compiledGitBlob: profile.compiled.gitBlob,
    targetRepository: push["target-repo"], pullNumber: Number(push.target),
    checkoutRepositories: frontmatter.checkout.map(row => row.repository),
    titlePrefix: push["title-prefix"] ?? null, labels: push.labels ?? null,
    fetch: frontmatter.checkout[0].fetch ?? null, fetchDepth: frontmatter.checkout[0]["fetch-depth"] ?? null,
    ifNoChanges: push["if-no-changes"] ?? null,
    compiledPushConfigs: configs.map(config => JSON.parse(config).push_to_pull_request_branch).filter(Boolean),
    sequenceOracle: null, compatibleNativeEvidence: false,
    reason: "No source-pinned edition/line mapping or authorized independent target pre/post receipts." };
});
const contract = {
  schemaVersion: 1, ...updateScope, adoption: source.adoption,
  sourcesSha256: updateJsonHash(source),
  interpreterSha256: hash(readFileSync("scripts/native-cross-repo-update-value.mjs")),
  predecessor: { functionSha256: priorFunctionSha256, sealedArchivePath: priorArchive,
    sealedArchiveSha256: predecessor.archive.sha256,
    reason: "Reliability correction: bind native receipts to independent run/attempt/source/runtime/host/artifact identities and chronology; preserve all prior unknown assessments." },
  receiptBinding: {
    expectedProfile: "Independently reviewed protected source/run/host/artifact metadata, never copied from the receipt under evaluation.",
    identities: ["workflow repository name and numeric ID", "workflow path", "run ID", "attempt",
      "source head", "workflow source blob", "compiled workflow blob", "runtime tree",
      "target repository name and numeric ID", "stable PR ID and PR number 1", "independently expected target branch",
      "protected host job ID/name, step number and checker blob", "native artifact ID/digest, producer job, repository, run, attempt and source head"],
    payload: "Hash original native artifact bytes against the independently expected SHA256; parsed JSON must exactly equal the projected receipt payload.",
    chronology: "run start <= protected host step start <= pre-state observation < push <= post-state observation <= host step completion <= artifact creation <= run completion < evidence cutoff; protected step/artifact timestamps must equal independent metadata.",
    acceptedActualReceipts: 0,
  },
  sourceReview: { profiles, acceptedSequenceOracles: [],
    antecedent: { result: "pre-existing-but-not-reconstructable",
      explanation: "The target branch condition could exist independently of this workflow. Public-only authority cannot reconstruct private target history; source also lacks a deterministic edition/sequence mapping. No absent trace is treated as zero." },
    host: { pushGitBlob: source.sources.find(row => row.path === "actions/setup/js/push_to_pull_request_branch.cjs").gitBlob,
      findings: ["Host returns pre/post head SHAs and branch identity; these are join keys, not proof of correct README content.",
        "Protected-file policy can request review rather than push README changes; report publication does not prove the branch changed.",
        "Historical target namespace/title/label/fetch/runtime changes must remain profile-bound.",
        "Public run artifacts/logs may expose private target content and are not acquired under this assignment."] } },
  limitations: ["Public-only target authority blocks native byte acquisition.",
    "No source-grounded Odyssey edition/corpus/next-line mapping is frozen; semantic next-line acceptance remains unresolved.",
    "No native values, adoption improvement, workflow contribution, sole attribution, costs or comparable trend are established.",
    "Complete retained public run inventory is discovery metadata, not the complete historical update-opportunity population.",
    "A future evidence-authority or sequence-oracle change requires explicit contract review; do not reinterpret this all-unavailable archive."],
};
mkdirSync("docs/operational-value/proof/functions", { recursive: true });
const files = [[`${root}/contract.json`, `${JSON.stringify(contract, null, 2)}\n`],
  [`docs/operational-value/proof/functions/${updateScope.slug}.mjs`,
  `import { crossRepoUpdateModule } from "../../../../scripts/native-cross-repo-update-value.mjs";\n`
  + `const contract = ${JSON.stringify(contract, null, 2)};\n`
  + "export const { definition, collectBatch, scoreMetric } = crossRepoUpdateModule(contract);\n"]];
for (const [file, content] of files) {
  if (existsSync(file) && readFileSync(file, "utf8") !== content) {
    const expected = predecessor.files.find(row => row.path === file)?.sha256;
    if (!supersede.length || hash(readFileSync(file)) !== expected) {
      throw new Error(`Refusing to replace frozen workflow contract without exact sealed predecessor: ${file}`);
    }
  }
}
for (const [file, content] of files) writeFileSync(file, content);
console.log(JSON.stringify({ frozen: true, sourceProfiles: profiles.length,
  contractSha256: updateJsonHash(contract), nativeSequenceOracle: null }));
