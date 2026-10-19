import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "yaml";
import { censusDigest, readCensusJson, writeCensusJson } from "./operational-value-census-io.mjs";
import { multiPrAcquisition, multiPrScope } from "./collect-smoke-multi-pr-value.mjs";

export function reviewMultiPrSources(cache, approved) {
  const directory = multiPrScope.directory, contract = readCensusJson(`${directory}/contract.json`);
  const deliveries = readCensusJson(`${directory}/deliveries.json.gz`), { source, metadata } = multiPrAcquisition(cache);
  const hostSources = readCensusJson(`${directory}/host-sources.json.gz`);
  const sources = new Map(), hostReviews = [];
  for (const profile of contract.profiles) {
    const workflow = source(profile.revision, ".github/workflows/smoke-multi-pr.md");
    const text = Buffer.from(workflow.content, "base64").toString("utf8");
    for (const match of text.matchAll(/\{\{#(?:runtime-)?import (shared\/[a-z0-9-]+\.md)\}\}/g)) {
      const item = source(profile.revision, `.github/workflows/${match[1]}`);
      sources.set(item.gitBlob, item);
    }
  }
  const adoptionLock = source(contract.adoption.commit, ".github/workflows/smoke-multi-pr.lock.yml");
  sources.set(adoptionLock.gitBlob, adoptionLock);
  for (const id of approved) {
    const profile = deliveries.profiles.find(profile => profile.id === id);
    if (!profile) throw new Error("Cannot approve a host profile without retained originals");
    const paths = ["actions/setup/index.js", "actions/setup/setup.sh", "actions/setup/js/setup_globals.cjs",
      "actions/setup/js/safe_output_handler_manager.cjs", "actions/setup/js/transport_integrity.cjs",
      "actions/setup/js/resolve_transport_paths.cjs", "actions/setup/sh/configure_git_credentials.sh"];
    const absentLaterModules = [];
    const closure = paths.flatMap(file => {
      if (metadata(["ls-tree", profile.checkout, file])) return [source(profile.checkout, file)];
      if (file !== "actions/setup/js/transport_integrity.cjs") throw new Error(`Missing required historical runtime source: ${file}`);
      absentLaterModules.push({ path: file, checkout: profile.checkout, nativeLsTreeResult: "" });
      return [];
    });
    for (const item of closure) sources.set(item.gitBlob, item);
    const compiled = hostSources.find(item => item.gitBlob === profile.compiledGitBlob);
    if (!compiled) throw new Error("No immutable compiled artifact-producer source");
    const agent = parse(Buffer.from(compiled.content, "base64").toString("utf8")).jobs?.agent;
    const uploads = agent?.steps?.filter(item => item.with?.name === "agent"
      && /^actions\/upload-artifact@[a-f0-9]{40}$/.test(item.uses ?? ""));
    if (uploads?.length !== 1 || !uploads[0].with.path?.split("\n").includes("/tmp/gh-aw/aw-*.patch")) {
      throw new Error("No reviewed exact original-artifact upload contract");
    }
    hostReviews.push({ profile: id, checkout: profile.checkout, jobSha256: profile.jobSha256,
      artifactProducer: { jobSha256: censusDigest(agent), uploadStepSha256: censusDigest(uploads[0]),
        jobName: agent.name ?? "agent", stepName: uploads[0].name },
      originalSourceObjects: profile.runtime, closure: closure.map(item => ({ path: item.path, gitBlob: item.gitBlob })),
      absentLaterModules,
      approval: "Reviewed exact protected dispatcher/setup, immutable runner script location, main base/branch creation and GraphQL returned-commit log producer; native target-tree bytes remain the independent outcome check." });
  }
  const review = { schemaVersion: 1, scope: multiPrScope, frozenContractSha256: censusDigest(contract),
    sourceVersions: contract.profiles.length, taskVersions: new Set(contract.profiles.map(profile => profile.taskSha256)).size,
    hostReviews, sources: [...sources.values()],
    baseline: { commit: contract.adoption.baselineCommit, at: contract.adoption.baselineAt,
      opportunityPopulation: "The exact source-bound two-payload smoke case was absent from this mainline source parent. Generic PR activity is not a comparable baseline.",
      preMergeDiscovery: { runId: 22248592522, at: "2026-02-21T02:25:43Z",
        relation: "After the baseline timestamp but before the mainline addition; discovery only, not an invented pre-baseline value." } },
    semanticReview: {
      eras: "Original configuration payload and subsequent CRLF payload are different predicates; no cross-era trend.",
      bodyChanges: "Seven historical task text hashes differ by the config/CRLF transition, noop/import syntax and trailing whitespace; reporting/OTLP imports do not redefine payload bytes.",
      printf: "Exact source Bash printf expands the annotation into an additional CRLF line. Literal and native-expanded annotations are frozen as distinct representations before payload inspection.",
      lifecycle: "Two-hour PR expiry/closure is expected cleanup, not rejected improvement; merge is not required for a delivered smoke branch.",
      unreviewed: "Other runtime profiles are not silently accepted; each requires separate coherent original-source review.",
      runtimeDeltas: "Reviewed every acquired immutable runtime/setup/dispatcher delta: mention/body/footer changes, shallow-fetch and bundle recovery, signing/rebase changes, claim guards, transport snapshot introduction, and local bundle import. Main-base/new-branch/GraphQL returned-OID/native PR-response log producers keep the same meaning; independent raw target bytes remain required.",
      protectedEntrypoints: "Both compiled entrypoints load setup_globals and process_safe_outputs only from RUNNER_TEMP/gh-aw/actions; the only entrypoint delta passes credential-source provenance. The pinned github-script action is unchanged.",
      originalProducer: "Both literal agent job names (agent and Agent) are source-bound. The exact initial successful Upload agent artifacts step must contain the artifact creation time and precede protected processing.",
      nativeTool: "Only Git is executed on retained patches, with a closed single expected-file addition and core.autocrlf=false; no fetched code, hooks or executable configuration runs.",
    },
    runtimeDeltaReview: { sha256: createHash("sha256").update(readFileSync(`${cache}/runtime-review-diffs.txt`)).digest("hex"),
      content: readFileSync(`${cache}/runtime-review-diffs.txt`, "utf8") },
    toolchain: { node: process.version, git: multiPrAcquisition(cache).metadata(["--version"]),
      producerSha256: createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex") } };
  writeCensusJson(`${directory}/source-review.json.gz`, review);
  return { sourceObjects: sources.size, reviewedHostProfiles: hostReviews.length, sha256: censusDigest(review) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [cache, ...approved] = process.argv.slice(2);
  if (!cache || !approved.length || approved.some(id => !/^[a-f0-9]{64}$/.test(id))) {
    throw new Error("usage: review-smoke-multi-pr-sources.mjs CACHE APPROVED-PROFILE-SHA256...");
  }
  console.log(JSON.stringify(reviewMultiPrSources(cache, approved)));
}
