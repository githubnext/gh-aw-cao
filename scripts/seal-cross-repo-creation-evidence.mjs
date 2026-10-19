import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";

const directory = "docs/operational-value/proof/cross-repo-creation";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const execute = args => execFileSync("gh", ["api", ...args], {
  timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
});

function targetVisibility(repository) {
  try {
    const original = JSON.parse(execute([`repos/${repository}`]));
    return { repository, status: original.private === true ? "private" : "public",
      contentAcquired: false, observation: "Metadata only; private content is outside authority." };
  } catch (error) {
    if (!/HTTP 404/.test(String(error.stderr))) throw error;
    return { repository, status: "http-404", contentAcquired: false,
      observation: "Not publicly available to this request; no inference of nonexistence or historical delivery failure." };
  }
}

export function sealCrossRepoCreation(cache) {
  mkdirSync(cache, { recursive: true });
  const sources = readCensusJson(`${directory}/sources.json.gz`);
  const discovery = readCensusJson(`${directory}/discovery.json.gz`);
  const contract = readCensusJson(`${directory}/contract.json`);
  const run = discovery.retained.filter(row => row.event === "schedule").at(-1);
  const prefix = `repos/github/gh-aw/actions/runs/${run.id}`;
  const artifacts = JSON.parse(execute([`${prefix}/artifacts?per_page=100`]));
  const jobs = JSON.parse(execute([`${prefix}/attempts/1/jobs?per_page=100`]));
  if (artifacts.total_count !== artifacts.artifacts?.length || jobs.total_count !== jobs.jobs?.length) {
    throw new Error("Incomplete bounded protected-receipt probe");
  }
  const artifact = artifacts.artifacts.find(row => row.name === "safe-outputs-items");
  if (!artifact || artifact.expired || artifact.workflow_run?.id !== run.id
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) throw new Error("Unavailable identity-bound output probe");
  const archive = execute([`repos/github/gh-aw/actions/artifacts/${artifact.id}/zip`]);
  if (`sha256:${hash(archive)}` !== artifact.digest || archive.length > 1024 * 1024) {
    throw new Error("Protected-output artifact digest/size mismatch");
  }
  const archiveFile = path.join(cache, "protected-output-probe.zip");
  let itemCount;
  try {
    writeFileSync(archiveFile, archive);
    const args = { timeout: 30000, maxBuffer: 1024 * 1024, encoding: "utf8" };
    const names = execFileSync("unzip", ["-Z1", archiveFile], args).trim().split("\n");
    if (names.length !== 2 || !names.includes("safe-output-items.jsonl")
      || !names.includes("temporary-id-map.json")) throw new Error("Unreviewed protected-output archive layout");
    const text = execFileSync("unzip", ["-p", archiveFile, "safe-output-items.jsonl"], args);
    const rows = text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    itemCount = rows.length;
    if (itemCount) throw new Error("Nonempty probe requires independent receipt review; never infer delivery from item presence");
  } finally {
    rmSync(archiveFile, { force: true });
  }
  const probe = {
    observedAt: new Date().toISOString(), historicalState: false,
    targets: ["github/gh-aw-side-repo", "githubnext/gh-aw-side-repo"].map(targetVisibility),
    publicProtectedReceiptProbe: {
      scope: "One latest retained scheduled run; availability probe only, not exhaustive artifact/target coverage.",
      run, artifacts: artifacts.artifacts.map(row => ({ id: row.id, name: row.name, digest: row.digest,
        expired: row.expired, size: row.size_in_bytes, createdAt: row.created_at, workflowRun: row.workflow_run })),
      jobs: jobs.jobs.map(row => ({ id: row.id, name: row.name, steps: row.steps })),
      selectedArtifactId: artifact.id, archiveSha256: hash(archive), safeOutputItems: itemCount,
      acceptedTargetReceipts: null,
      interpretation: "Empty protected items artifact supplies no immutable target fixture receipt; checkout failure or empty output is not independent evidence of historical zero.",
    },
    missingReceipt: "Authorized independent numeric target identity, original execution-source binding, PR/base/head branch identities, complete base/head Git tree path proofs and exact fixture blob content at delivery.",
    stoppedBecause: "Both source-declared target names lack authorized public target content. No private content access, alias substitution or writes are authorized.",
  };
  if (probe.targets.some(row => row.status === "public")) throw new Error("Public target became available; perform full target acquisition instead of sealing a blocker");
  writeCensusJson(`${directory}/probes.json`, probe);
  const index = { schemaVersion: 1, status: "open-blocked", measured: false, ...{
    repository: contract.repository, workflowId: contract.workflowId, sourceRevision: contract.sourceRevision,
    until: contract.until, contractSha256: censusDigest(contract), sourcesSha256: censusDigest(sources),
    discoverySha256: censusDigest(discovery), probesSha256: censusDigest(probe),
  }, retainedRuns: discovery.retained.length, sourceChanges: sources.history.length,
  compiledChanges: sources.compiledHistory.length, reviewedSourceProfiles: sources.profiles.length,
  discoveryCandidates: discovery.candidates.length, acceptedReceipts: null, nativeValue: null,
  missingReason: probe.missingReceipt,
  readinessGuard: "status must not be measured/ready while acceptedReceipts or nativeValue is null; an all-unknown timeline does not contribute measured coverage.",
  };
  writeCensusJson(`${directory}/index.json`, index);
  const interpreterSha256 = hash(readFileSync("scripts/native-cross-repo-creation-value.mjs"));
  const file = "docs/operational-value/proof/functions/smoke-create-cross-repo-pr.mjs";
  writeFileSync(file, `import { createHash } from "node:crypto";\nimport { readFileSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\nimport { censusDigest, readCensusJson } from "../../../../scripts/operational-value-census-io.mjs";\nimport { crossRepoCreationModule } from "../../../../scripts/native-cross-repo-creation-value.mjs";\n\nconst contract = readCensusJson(fileURLToPath(new URL("../cross-repo-creation/contract.json", import.meta.url)));\nif (censusDigest(contract) !== "${censusDigest(contract)}"\n  || createHash("sha256").update(readFileSync(new URL("../../../../scripts/native-cross-repo-creation-value.mjs", import.meta.url))).digest("hex") !== "${interpreterSha256}") {\n  throw new Error("Frozen cross-repository contract/interpreter changed");\n}\nexport const { definition, collectBatch, scoreMetric } = crossRepoCreationModule(contract, "${censusDigest(index)}");\n`);
  console.log(JSON.stringify({ status: index.status, nativeValue: null, retainedRuns: index.retainedRuns,
    contractSha256: index.contractSha256, interpreterSha256 }));
  return index;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("usage: seal-cross-repo-creation-evidence.mjs PRIVATE-WORKSPACE-CACHE");
  sealCrossRepoCreation(process.argv[2]);
}
