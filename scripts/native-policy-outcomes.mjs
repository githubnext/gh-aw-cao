import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { gunzipSync } from "node:zlib";

export const proofRoot = fileURLToPath(new URL("../docs/operational-value/proof/native-policy-outcomes/", import.meta.url));
export const cutoff = "2026-10-18T15:00:12Z";
export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const repository = "github/gh-aw";
export const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const iso = value => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)
  && Number.isFinite(Date.parse(value));
export const readProof = name => JSON.parse(gunzipSync(fs.readFileSync(path.join(proofRoot, name))));

export function original(file) {
  const prefix = "docs/operational-value/proof/native-policy-outcomes/";
  if (typeof file !== "string" || !file.startsWith(prefix) || file.includes("..")) throw new Error("Unsafe original path");
  const packet = readProof(file.slice(prefix.length));
  if (typeof packet.body !== "string" || hash(packet.body) !== packet.sha256
    || !/^repos\/github\/gh-aw(?:[/?]|$)/.test(packet.endpoint)
    || !Number.isFinite(Date.parse(packet.observedAt))) throw new Error("Original response custody mismatch");
  return { ...packet, value: JSON.parse(packet.body) };
}

export function sourceText(source) {
  if (!source || !/^[a-f0-9]{40}$/.test(source.blob) || !/^[a-f0-9]{40}$/.test(source.revision)
    || typeof source.content !== "string" || typeof source.path !== "string") throw new Error("Malformed immutable source");
  const bytes = Buffer.from(source.content, "base64");
  if (bytes.toString("base64") !== source.content || hash(bytes) !== source.sha256
    || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== source.blob) {
    throw new Error("Source bytes or Git blob changed");
  }
  if (source.receipt) {
    const packet = original(source.receipt);
    if (packet.endpoint !== `repos/github/gh-aw/contents/${source.path}?ref=${source.revision}`
      || packet.value.sha !== source.blob || packet.value.path !== source.path
      || Buffer.from(packet.value.content.replace(/\s/g, ""), "base64").toString("base64") !== source.content) {
      throw new Error("Original API/source relation changed");
    }
  }
  return bytes.toString("utf8");
}

export function transition(number) {
  const record = readProof(`transition-${number}.json.gz`);
  const commit = original(record.commitReceipt);
  const prIndex = readProof(`pr-${number}.json.gz`);
  const pr = original(prIndex.prReceipt);
  const ancestry = readProof(`ancestry-${number}.json.gz`);
  const compare = original(ancestry.receipt);
  if (record.scope.repository !== repository || record.scope.repositoryId !== 1036865607 || record.scope.revision !== revision
    || record.scope.cutoff !== cutoff || commit.value.sha !== record.commit
    || commit.value.parents[0]?.sha !== record.parent
    || commit.value.commit.committer.date !== record.committedAt
    || pr.value.merge_commit_sha !== record.commit || !pr.value.merged_at
    || pr.value.base?.repo?.id !== 1036865607 || pr.value.base.repo.private !== false
    || !iso(record.committedAt) || record.committedAt >= cutoff
    || compare.value.status !== "ahead" || compare.value.merge_base_commit?.sha !== record.commit
    || compare.endpoint !== `repos/github/gh-aw/compare/${record.commit}...${record.scope.revision}?per_page=1&page=2`) {
    throw new Error("Unverified landed transition");
  }
  for (const entry of record.sources) {
    if (entry.before.revision !== record.parent || entry.after.revision !== record.commit
      || entry.before.path !== entry.name || entry.after.path !== entry.name) throw new Error("Non-parent source comparison");
    sourceText(entry.before);
    sourceText(entry.after);
  }
  return record;
}

function hostCovered(pattern, host) {
  const root = pattern.replace(/^\*\./, "");
  return host === root || host.endsWith(`.${root}`);
}

export function networkSeparation(before, after, beforeGo, afterGo) {
  for (const [json, go] of [[before, beforeGo], [after, afterGo]]) {
    if (!json || !json.ecosystems || !Array.isArray(json["engine-defaults"]?.claude)
      || !Object.values(json.ecosystems).every(list => Array.isArray(list)
        && list.every(domain => typeof domain === "string" && /^[a-z0-9*.:-]+$/.test(domain)))
      || !json["engine-defaults"].claude.every(domain => typeof domain === "string" && /^[a-z0-9*.-]+$/.test(domain))) {
      throw new Error("Invalid native domain-set schema");
    }
    const required = [
      "//go:embed data/ecosystem_domains.json", 'json.Unmarshal(domainSetsJSON, &sets)',
      'EngineDefaults       map[string][]string `json:"engine-defaults"`',
      "var engineDefaultDomainSets = getLoadedDomainSets().EngineDefaults",
      'var ClaudeDefaultDomains = copyEngineDefaultDomainSet(engineDefaultDomainSets["claude"])',
      "domains, exists = engineDefaultDomainSets[category]",
      "return append([]string(nil), domains...)",
    ];
    if (!required.every(text => go.includes(text))) throw new Error("Unsupported native domain loader/resolution");
  }
  if (JSON.stringify(before.ecosystems) !== JSON.stringify(after.ecosystems)) {
    return { accepted: [], rejected: "Ecosystem policy changed; no fixed-reference separation claim." };
  }
  const accepted = [];
  for (const domain of [...new Set(before["engine-defaults"].claude)].sort()) {
    if (domain.includes("*") || after["engine-defaults"].claude.some(pattern => hostCovered(pattern, domain))) continue;
    const ecosystems = ["containers", "linux-distros", "playwright"].filter(category =>
      before.ecosystems[category]?.some(pattern => hostCovered(pattern, domain)));
    if (ecosystems.length) accepted.push({ id: `claude:${domain}`, engine: "claude", domain, ecosystems });
  }
  return { accepted, rejected: null };
}

export function replayNetwork(record = transition(67811)) {
  const go = record.sources.find(entry => entry.name === "pkg/workflow/domains.go");
  const json = record.sources.find(entry => entry.name === "pkg/workflow/data/ecosystem_domains.json");
  return networkSeparation(JSON.parse(sourceText(json.before)), JSON.parse(sourceText(json.after)),
    sourceText(go.before), sourceText(go.after));
}

const temporary = action => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cao-native-policy-"));
  try { return action(root); } finally {
    fs.chmodSync(root, 0o700);
    fs.rmSync(root, { recursive: true });
  }
};

export function replayOrigin(source) {
  const text = sourceText(source);
  const assignment = text.split("\n").filter(line => /^(?:SAFE_)?ORIGIN_URL=/.test(line));
  if (assignment.length !== 1) throw new Error("Ambiguous native origin assignment");
  const variable = assignment[0].startsWith("SAFE_") ? "SAFE_ORIGIN_URL" : "ORIGIN_URL";
  const remote = text.split("\n").map(line => line.trim()).filter(line =>
    line === `git remote add origin "$${variable}"`);
  if (remote.length < 1 || remote.length > 2) throw new Error("Original remote persistence command unavailable");
  if (assignment[0] !== 'ORIGIN_URL="https://x-access-token:${GH_TOKEN}@${SERVER_HOST}/${TARGET_REPO}.git"'
    && assignment[0] !== 'SAFE_ORIGIN_URL="https://${SERVER_HOST}/${TARGET_REPO}.git"') throw new Error("Unsupported origin construction");
  const command = ['set -eu', 'git init --quiet --template=', assignment[0], remote[0], 'git config --get remote.origin.url'].join("\n");
  return temporary(root => {
    const marker = "non-secret-native-policy-marker";
    const result = execFileSync("bash", ["--noprofile", "--norc", "-c", command], {
      cwd: root, encoding: "utf8", timeout: 10000,
      env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
        GH_TOKEN: marker, SERVER_HOST: "github.com", TARGET_REPO: "github/gh-aw" },
    }).trim();
    const config = fs.readFileSync(path.join(root, ".git/config"), "utf8");
    return {
      command, commandSha256: hash(command), exitCode: 0, persistedMarker: config.includes(marker),
      origin: result.replaceAll(marker, "<dummy-marker>"), configSha256: hash(config),
      targetPreserved: result.endsWith("@github.com/github/gh-aw.git") || result === "https://github.com/github/gh-aw.git",
      isolation: "Local empty Git repository only; no clone, credential or network request.",
    };
  });
}

function between(text, start, end) {
  const left = text.indexOf(start), right = text.indexOf(end, left + start.length);
  if (left < 0 || right < 0 || text.indexOf(start, left + 1) >= 0) throw new Error("Ambiguous native source extraction");
  return text.slice(left, right);
}

export function replayWrapper(source, preexisting) {
  const text = sourceText(source);
  const escape = between(text, "function shellEscapeDoubleQuoted(str) {", "\n/**");
  const generator = between(text, "function generateCLIWrapperScript(", "\n/**");
  const write = between(text, "    const scriptPath = path.join(CLI_BIN_DIR, name);", "\n  }\n\n  if (mountedServers.length");
  if (/\b(?:require|process|http|fetch|exec|spawn)\s*[.(]/.test(write)) throw new Error("Wrapper-write extraction exceeds local scope");
  const previousUmask = process.umask(0o022);
  try { return temporary(root => {
    const file = path.join(root, "native-proof");
    const marker = "non-secret-native-policy-marker";
    if (preexisting) {
      fs.writeFileSync(file, "pre-existing", { mode: 0o755 });
      fs.chmodSync(file, 0o755);
    }
    const warnings = [];
    const mountedServers = [];
    const context = createContext({
      fs, path, CLI_BIN_DIR: root, name: "native-proof", containerUrl: "http://example.invalid",
      toolsFile: "/nonexistent/native-tools.json", apiKey: marker, bridgeScript: "/nonexistent/native-bridge.cjs",
      tools: [], mountedServers, mountedServerTools: [],
      core: { info() {}, warning(message) { warnings.push(message); } },
      getErrorMessage: error => String(error),
    }, { codeGeneration: { strings: false, wasm: false } });
    const program = `${escape}\n${generator}\n${write}`;
    runInContext(program, context, { timeout: 1000 });
    if (warnings.length || mountedServers.length !== 1) throw new Error(`Native wrapper write failed: ${warnings.join("; ")}`);
    const bytes = fs.readFileSync(file);
    const mode = fs.statSync(file).mode & 0o777;
    return {
      sourceProgramSha256: hash(program), sourceBlob: source.blob, preexisting, exitCode: 0, umask: "0022",
      mode, containsMarker: bytes.includes(marker), ownerExecutable: (mode & 0o100) !== 0,
      groupWorldReadable: (mode & 0o044) !== 0, bytesSha256: hash(bytes),
      isolation: "Original generator and wrapper-write statements only; generated wrapper is never invoked.",
    };
  }); } finally { process.umask(previousUmask); }
}

export function replaySetup() {
  const clone = transition(54701), wrapper = transition(55587);
  const cloneSource = clone.sources[0], wrapperSource = wrapper.sources[0];
  const originBefore = replayOrigin(cloneSource.before), originAfter = replayOrigin(cloneSource.after);
  const cases = [false, true].map(preexisting => ({
    before: replayWrapper(wrapperSource.before, preexisting), after: replayWrapper(wrapperSource.after, preexisting),
  }));
  const accepted = [];
  if (originBefore.persistedMarker && !originAfter.persistedMarker
    && originBefore.targetPreserved && originAfter.targetPreserved) accepted.push({
    id: "repo-memory-origin-token-persistence", commit: clone.commit, parent: clone.parent,
    committedAt: clone.committedAt, pr: clone.pr, before: originBefore, after: originAfter,
  });
  if (cases.every(row => row.before.containsMarker && row.after.containsMarker
    && row.before.ownerExecutable && row.after.ownerExecutable
    && row.before.groupWorldReadable && !row.after.groupWorldReadable)) accepted.push({
    id: "mcp-wrapper-group-world-readability", commit: wrapper.commit, parent: wrapper.parent,
    committedAt: wrapper.committedAt, pr: wrapper.pr, cases,
  });
  return { accepted, nativeCases: { originBefore, originAfter, wrapper: cases } };
}

export function modelGap() {
  const record = readProof("daily-workflow-security-model-attempt.json.gz");
  const failures = record.entries.map(entry => {
    const run = original(entry.run), jobs = original(entry.jobs);
    if (run.value.repository?.id !== 1036865607 || jobs.value.total_count !== jobs.value.jobs.length) throw new Error("Incomplete original model job graph");
    const agent = jobs.value.jobs.find(job => job.name === "agent");
    if (!agent || agent.run_id !== run.value.id || agent.conclusion !== "failure"
      || !agent.steps.some(step => step.name === "Prepare pinned TLA+ runtime" && step.conclusion === "failure")) {
      throw new Error("Native preparation failure not established");
    }
    return { runId: run.value.id, headSha: run.value.head_sha, createdAt: run.value.created_at,
      jobId: agent.id, failedStep: "Prepare pinned TLA+ runtime", runReceipt: entry.run, jobsReceipt: entry.jobs };
  });
  return {
    accepted: [], failures,
    missingReason: "No independently replayed complete TLC exploration and intended mutation/witness result. Surviving workflow-linked objects are failure/incomplete reports; original job graphs establish preparation failures only.",
  };
}

export function periodEvidence(requests, slug, outcomes, cadenceDays, version = "2.0.0") {
  if (!Array.isArray(requests) || requests.length > 1000) throw new Error("Invalid bounded native period batch");
  const source = readProof("source-closure.json.gz").closure[slug];
  const adoption = source.adoption.committedAt;
  return requests.map(request => {
    if (!request || ![request.windowStart, request.windowEnd, request.observedAt].every(iso)
      || request.windowStart >= request.windowEnd || request.observedAt < request.windowEnd
      || request.repository && request.repository !== repository) throw new Error("Invalid native observation window");
    const inScope = request.windowStart >= adoption && request.windowEnd <= cutoff;
    const events = outcomes.accepted.filter(event => event.committedAt >= request.windowStart && event.committedAt < request.windowEnd);
    return {
      evidence: {
        valid: inScope && events.length > 0, scope: slug, version, measurementKind: "interval",
        events, acceptedNativeCount: events.length ? events.reduce((sum, row) => sum + (row.domains?.length ?? 1), 0) : null,
        fullAcceptance: null, contribution: null, costs: null, cadenceDays,
        coverageStatus: inScope && events.length ? "bounded-native-subtotal" : "missing",
        missingReason: !inScope ? "Outside acquired post-adoption/cutoff scope."
          : events.length ? "Native subtotal only; candidate acquisition does not establish an exhaustive absence of other outcomes."
            : outcomes.missingReason ?? "No independently verified native delivery retained for this period; absence is not zero.",
        knownPreparationFailures: (outcomes.failures ?? []).filter(row =>
          row.createdAt >= request.windowStart && row.createdAt < request.windowEnd),
      },
      provenance: [{ repository, kind: "immutable-goal-source",
        ref: `https://github.com/${repository}/blob/${source.profiles[0].revision}/.github/workflows/${slug}.md` },
      { repository, kind: "native-local-replay", ref: `native-policy-outcomes/${slug}/${version}` }],
      commit: events.at(-1)?.commit ?? source.profiles[0].revision,
    };
  });
}

export function nativeScore(id, evidence, slug, expected) {
  if (id !== "native-deliveries" || !evidence || evidence.valid !== true || evidence.scope !== slug
    || !Array.isArray(evidence.events) || evidence.events.length === 0 && evidence.coverageStatus !== "complete") return null;
  const ids = new Set();
  let total = 0;
  for (const event of evidence.events) {
    if (!event || ids.has(event.id)) return null;
    ids.add(event.id);
    const accepted = expected.find(row => row.id === event.id);
    if (!accepted || JSON.stringify(event) !== JSON.stringify(accepted)) return null;
    total += accepted.domains?.length ?? 1;
  }
  return Number.isSafeInteger(total) && total >= 0 ? total : null;
}

export function policyDefinition(slug, { goal, acceptance, unit, cadenceDays, examples }) {
  const source = readProof("source-closure.json.gz").closure[slug];
  const adopted = source.adoption;
  const metadata = original(readProof("source-history.json.gz").repositoryReceipt).value;
  if (metadata.id !== 1036865607 || metadata.full_name !== repository || metadata.private !== false
    || metadata.visibility !== "public" || source.profiles[0].revision !== revision) {
    throw new Error("Native source does not have the authorized public repository identity");
  }
  const addition = original(source.additionReceipt).value;
  if (addition.sha !== adopted.sha || addition.parents[0]?.sha !== adopted.parents[0]
    || !addition.files.some(file => file.filename === `.github/workflows/${slug}.md` && file.status === "added")
    || source.profiles.at(-1).revision !== adopted.sha) throw new Error("Unverified actual workflow adoption");
  return {
    schemaVersion: 3, slug, repository, workflowName: `${slug}: independently established native outcomes`,
    sourcePath: `.github/workflows/${slug}.md`,
    intent: { goal, acceptance, temporalAnchor: "workflow-adoption" },
    adoption: { commit: adopted.sha, adoptedAt: adopted.committedAt, baselineCommit: null, baselineAt: null },
    evaluation: {
      mode: "attainment-only",
      reason: "Disjoint post-adoption native delivery subtotals; no exhaustive matched historical baseline.",
    },
    contractVersion: "2.0.0",
    authoring: "Outcome-informed retrospective bounded facet; preserved v1 source-history-informed contract remains separate.",
    predecessors: ["native-policy-outcomes/frozen-contracts.json"],
    oracleDependencies: ["scripts/native-policy-outcomes.mjs",
      "docs/operational-value/proof/native-policy-outcomes/frozen-contracts.json",
      "docs/operational-value/proof/native-policy-outcomes/frozen-facets-v2.json"].map(name => ({
      path: name, sha256: hash(fs.readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)))),
    })),
    frozenSource: {
      repositoryId: 1036865607, revision: source.profiles[0].revision, cutoff,
      sourceBlob: source.profiles[0].blob, sourceSha256: source.profiles[0].sha256,
      adoptionAdditionReceipt: source.additionReceipt,
    },
    evidence: {
      key: `${slug}/native-policy-outcomes/2.0.0`, repositories: [repository],
      opportunity: "Source-goal-native condition transitions at immutable landed commits after verified workflow adoption.",
      filters: ["Actual first parent, exact public repository identity and frozen cutoff.",
        "Independent source/behavior oracle, never producer prose, closure or merge alone.",
        "Lifetime-deduplicated native conditions; partial evidence is a subtotal, not an exhaustive zero.",
        "Editable tracking markers establish candidate lineage, not receipt-verified creation."],
      collection: "Offline digest-checked original API/source custody and bounded local native replay; no API calls during collection or scoring.",
      measurementKind: "interval",
      window: { durationDays: cadenceDays, cadenceDays, maturationDays: 0 },
    },
    model: {
      architecture: "One source-goal-native instrument with separately preserved strict acceptance, partial value, safeguards and attribution.",
      recommendation: "Not rated: no agreed native keep bar or measured costs.",
      presentation: { label: "Verified native delivery", betterLabel: "More independently established native outcomes" },
    },
    summary: { nativeLabel: unit },
    metrics: [{
      id: "native-deliveries", name: unit, role: "primary",
      formula: "Sum distinct independently established native condition repairs delivered within the disjoint period; null when defining evidence is unavailable.",
      direction: "increase", unit,
      presentation: { name: unit, legendLabel: "Native deliveries", transform: "identity" },
    }],
    limitations: ["Partial native evidence is not full-goal acceptance.",
      "Full safeguards, exclusive causation, creation-receipt attribution and costs are unmeasured.",
      "No-op claims, failed investigations and absent surviving outcomes do not establish zero native delivery.",
      "Current public issue bodies are acquired originals, not historical body revisions."],
    validationExamples: examples,
  };
}
