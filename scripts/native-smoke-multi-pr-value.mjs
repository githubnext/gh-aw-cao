import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const date = value => typeof value === "string" && Number.isFinite(Date.parse(value));
export function multiPrFilename(runId, kind) {
  if (!positive(runId) || !["doc", "config", "crlf"].includes(kind)) throw new Error("Invalid native multi-PR case");
  return `tmp-smoke-multi-pr-${kind}-${runId}-${kind === "doc" ? 1 : 2}.txt`;
}

export function multiPrContent(runId, kind, bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 4096 || bytes.toString("utf8").includes("\ufffd")) return false;
  const text = bytes.toString("utf8"), ending = kind === "crlf" ? "\r\n" : "\n";
  const lines = text.split(ending);
  if (lines.pop() !== "" || lines.some(line => /[\r\n\0]/.test(line))) return false;
  const label = kind === "doc" ? "Documentation" : kind === "config" ? "Configuration" : "CRLF";
  if (lines[0] !== `${label} smoke test for multi-PR workflow` || lines[1] !== `Run ID: ${runId}`
    || lines[3] !== `PR: ${kind === "doc" ? 1 : 2} of 2` || !/^Created at: [\x20-\x7e]+$/.test(lines[2] ?? "")
    || !date(lines[2].slice("Created at: ".length))) return false;
  return kind === "crlf"
    ? lines.length === 5 && lines[4] === "Line ending: CRLF (Windows-style \\r\\n)"
      || lines.length === 6 && lines[4] === "Line ending: CRLF (Windows-style " && lines[5] === ")"
    : lines.length === 4;
}

export function multiPrPatchPayload(bytes, filename) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024 || !/^tmp-smoke-multi-pr-[a-z]+-\d+-[12]\.txt$/.test(filename)) return null;
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0 || text.split("\ndiff --git ").length !== 2) return null;
  const header = `diff --git a/${filename} b/${filename}\nnew file mode 100644\n`;
  const start = text.indexOf(header);
  if (start < 0) return null;
  const rest = text.slice(start + header.length);
  const match = rest.match(/^index 000000[0-9a-f]*\.\.[0-9a-f]+\n--- \/dev\/null\n\+\+\+ b\/[^\n]+\n@@ -0,0 \+1(?:,(\d+))? @@\n/);
  if (!match || !match[0].includes(`+++ b/${filename}\n`)) return null;
  const count = Number(match[1] ?? 1), tail = rest.slice(match[0].length).split("\n");
  if (!Number.isSafeInteger(count) || count < 1 || count > 20 || tail.slice(0, count).some(line => !line.startsWith("+"))
    || tail[count]?.startsWith("\\ No newline") || tail.slice(count).some(line => line.startsWith("diff --git "))) return null;
  return Buffer.from(`${tail.slice(0, count).map(line => line.slice(1)).join("\n")}\n`);
}

export function verifyMultiPrGitObject(object, type) {
  if (!object || !sha(object.id) || typeof object.content !== "string") throw new Error("Missing native Git object");
  const bytes = Buffer.from(object.content, "base64");
  if (bytes.length > 2 * 1024 * 1024 || bytes.toString("base64") !== object.content
    || createHash("sha1").update(`${type} ${bytes.length}\0`).update(bytes).digest("hex") !== object.id) {
    throw new Error("Native Git object digest mismatch");
  }
  return bytes;
}

export function multiPrTreeEntries(object) {
  const bytes = verifyMultiPrGitObject(object, "tree"), entries = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset), nul = bytes.indexOf(0, space + 1);
    if (space < offset || nul < space || nul + 21 > bytes.length) throw new Error("Malformed Git tree");
    const mode = bytes.subarray(offset, space).toString(), name = bytes.subarray(space + 1, nul).toString("utf8");
    if (!/^(?:40000|100644|100755|120000|160000)$/.test(mode) || entries.has(name) || !name || name.includes("/")) {
      throw new Error("Malformed Git tree entry");
    }
    entries.set(name, { mode, id: bytes.subarray(nul + 1, nul + 21).toString("hex") });
    offset = nul + 21;
  }
  return entries;
}

export function multiPrHostProjection(text, step) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 8 * 1024 * 1024
    || !date(step?.started_at) || !date(step?.completed_at)) throw new Error("Invalid protected host log");
  const lines = text.split("\n").map(line => line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z) (.*)\r?$/))
    .filter(match => match && Date.parse(match[1]) >= Date.parse(step.started_at)
      && Date.parse(match[1]) < Date.parse(step.completed_at) + 1000);
  const allowed = /^(?:Base branch for github\/gh-aw: main|Apply transport mode: (?:bundle|patch) \(bundle file present: (?:true|false)\)|pushSignedCommits: creating remote branch [a-z0-9-]+ at parent OID [a-f0-9]{40}|pushSignedCommits: remote branch [a-z0-9-]+ created successfully|pushSignedCommits: calling createCommitOnBranch mutation \(expectedHeadOid=[a-f0-9]{40}\)|pushSignedCommits: signed commit created: [a-f0-9]{40}|Created pull request #\d+: https:\/\/github\.com\/github\/gh-aw\/pull\/\d+)$/;
  return lines.filter(match => allowed.test(match[2])).map(([, at, message]) => ({ at, message }));
}

export function multiPrOperations(lines) {
  if (!Array.isArray(lines) || lines.some(line => !date(line?.at) || typeof line?.message !== "string")) throw new Error("Malformed protected operations");
  const operations = [];
  let current = null;
  for (const line of lines) {
    if (line.message === "Base branch for github/gh-aw: main") current = { baseBranch: "main", lines: [line] };
    if (!current) continue;
    if (current.lines.at(-1) !== line) current.lines.push(line);
    let match = line.message.match(/^pushSignedCommits: creating remote branch ([a-z0-9-]+) at parent OID ([a-f0-9]{40})$/);
    if (match) { current.branch = match[1]; current.base = match[2]; }
    match = line.message.match(/^pushSignedCommits: remote branch ([a-z0-9-]+) created successfully$/);
    if (match && match[1] === current.branch) current.branchCreated = true;
    match = line.message.match(/^pushSignedCommits: calling createCommitOnBranch mutation \(expectedHeadOid=([a-f0-9]{40})\)$/);
    if (match) current.expectedParent = match[1];
    match = line.message.match(/^pushSignedCommits: signed commit created: ([a-f0-9]{40})$/);
    if (match && current.branchCreated && current.expectedParent === current.base && !current.head) current.head = match[1];
    match = line.message.match(/^Created pull request #(\d+): https:\/\/github\.com\/github\/gh-aw\/pull\/(\d+)$/);
    if (match && match[1] === match[2] && current.head) {
      operations.push({ ...current, number: Number(match[1]), at: line.at });
      current = null;
    }
  }
  return operations;
}

export function assessMultiPrCase(row, kind, context) {
  const unknown = reason => ({ status: "unknown", reason });
  if (!positive(row?.run?.id) || row.run.attempt !== 1 || !date(row.run.at)
    || Date.parse(row.run.at) >= Date.parse(context.until)) return unknown("No eligible initial execution");
  const fact = row.cases?.find(item => item.kind === kind);
  if (!fact?.source || !fact.operation || !fact.payload || !fact.target) return unknown(fact?.missingReason ?? "No complete independent payload receipt");
  const profile = context.profiles.find(profile => profile.workflowGitBlob === fact.source.workflowGitBlob);
  const { hostProfileSha256, ...hostProfile } = fact.source;
  if (!profile || profile.era !== row.era || fact.source.taskSha256 !== profile.taskSha256
    || !sha(fact.source.checkout) || !sha(fact.source.compiledGitBlob)
    || censusDigest(hostProfile) !== hostProfileSha256
    || !context.reviewedHosts.includes(hostProfileSha256)) return unknown("Unreviewed coherent source/host profile");
  const { payload, operation, target } = fact, filename = multiPrFilename(row.run.id, kind);
  if (!positive(operation.jobId) || !positive(operation.step?.number) || !date(operation.step.started_at)
    || !date(operation.step.completed_at) || !/^[a-f0-9]{64}$/.test(operation.logSha256 ?? "")
    || operation.step.name !== "Process Safe Outputs"
    || !Array.isArray(operation.lines) || operation.lines.some((line, i) => !date(line?.at)
      || Date.parse(line.at) < Date.parse(operation.step.started_at)
      || Date.parse(line.at) >= Date.parse(operation.step.completed_at) + 1000
      || i > 0 && Date.parse(line.at) < Date.parse(operation.lines[i - 1].at))) return unknown("Missing protected operation envelope");
  const proof = multiPrOperations(operation.lines).filter(item => item.number === operation.number);
  if (proof.length !== 1 || censusDigest(proof[0]) !== censusDigest(operation.proof)
    || Date.parse(proof[0].at) >= Date.parse(context.until) || Date.parse(proof[0].at) < Date.parse(operation.step.started_at)
    || Date.parse(proof[0].at) >= Date.parse(operation.step.completed_at) + 1000) return unknown("No unique cutoff-bounded protected delivery");
  const branch = `smoke-multi-pr-${kind}-${row.run.id}-${kind === "doc" ? 1 : 2}`;
  if (!(operation.proof.branch === branch || new RegExp(`^${branch}-[a-f0-9]+$`).test(operation.proof.branch))
    || payload.branch !== branch || payload.runId !== row.run.id
    || payload.providerDigest !== `sha256:${payload.archiveSha256}`
    || !/^[a-f0-9]{64}$/.test(payload.archiveSha256 ?? "") || !positive(payload.artifactId)) return unknown("Unbound original branch payload");
  const producer = payload.producer, approvedProducer = context.artifactProducers?.[hostProfileSha256];
  if (!producer || !approvedProducer || producer.jobSha256 !== approvedProducer.jobSha256
    || producer.uploadStepSha256 !== approvedProducer.uploadStepSha256 || !positive(producer.job?.id)
    || producer.job.id === operation.jobId || producer.job.name !== approvedProducer.jobName || producer.job.run_id !== row.run.id
    || producer.job.run_attempt !== 1 || producer.job.head_sha !== row.run.headSha
    || producer.step?.name !== approvedProducer.stepName || !positive(producer.step.number)
    || producer.step.status !== "completed" || producer.step.conclusion !== "success"
    || !date(producer.step.started_at) || !date(producer.step.completed_at) || !date(producer.artifactCreatedAt)
    || Date.parse(producer.artifactCreatedAt) < Date.parse(producer.step.started_at)
    || Date.parse(producer.artifactCreatedAt) >= Date.parse(producer.step.completed_at) + 1000
    || Date.parse(producer.step.completed_at) > Date.parse(operation.step.started_at)) {
    return unknown("Original artifact lacks its exact source-bound initial upload receipt");
  }
  const patch = Buffer.from(payload.patchBase64, "base64");
  if (patch.toString("base64") !== payload.patchBase64 || digest(patch) !== payload.patchSha256) throw new Error("Original patch digest mismatch");
  const supplied = multiPrPatchPayload(patch, filename);
  if (!supplied || digest(supplied) !== payload.appliedPayloadSha256 || !payload.nativeGitVersion?.startsWith("git version ")) {
    return unknown("Original patch cannot prove the exact single-file payload");
  }
  const head = verifyMultiPrGitObject(target.head, "commit").toString("utf8");
  const base = verifyMultiPrGitObject(target.base, "commit").toString("utf8");
  if (target.head.id !== operation.proof.head || target.base.id !== operation.proof.base
    || head.match(/^tree ([a-f0-9]{40})$/m)?.[1] !== target.headTree.id
    || base.match(/^tree ([a-f0-9]{40})$/m)?.[1] !== target.baseTree.id
    || head.match(/^parent ([a-f0-9]{40})$/m)?.[1] !== target.base.id
    || (head.match(/^parent /gm) ?? []).length !== 1) return unknown("Target head/base ancestry does not match protected operation");
  const before = multiPrTreeEntries(target.baseTree), after = multiPrTreeEntries(target.headTree);
  const content = verifyMultiPrGitObject(target.blob, "blob"), changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter(name => censusDigest(before.get(name) ?? null) !== censusDigest(after.get(name) ?? null));
  const createdAt = Date.parse(content.toString("utf8").split(kind === "crlf" ? "\r\n" : "\n")[2]?.slice("Created at: ".length));
  const valid = !before.has(filename) && changed.length === 1 && changed[0] === filename
    && after.get(filename)?.mode === "100644" && after.get(filename)?.id === target.blob.id
    && content.equals(supplied) && multiPrContent(row.run.id, kind, content)
    && createdAt >= Date.parse(row.run.at) && createdAt <= Date.parse(operation.proof.at);
  return { status: "assessed", correct: valid, at: operation.proof.at, kind,
    annotation: kind === "crlf" ? content.toString().split("\r\n").length === 7 ? "native-printf-expansion" : "literal-annotation" : null };
}

export function scanMultiPrEvidence(evidence, context) {
  if (evidence?.valid !== true || !Array.isArray(evidence.observations)
    || new Set(evidence.observations.map(row => row?.run?.id)).size !== evidence.observations.length
    || evidence.observations.some(row => !positive(row?.run?.id) || !["crlf", "configuration"].includes(row.era)
      || !Array.isArray(row.cases) || new Set(row.cases.map(item => item?.kind)).size !== row.cases.length
      || row.windowCases && (!Array.isArray(row.windowCases) || !row.windowCases.length
        || new Set(row.windowCases).size !== row.windowCases.length
        || row.windowCases.some(kind => !["doc", row.era === "crlf" ? "crlf" : "config"].includes(kind))))) return null;
  const cases = evidence.observations.flatMap(row => (row.windowCases ?? ["doc", row.era === "crlf" ? "crlf" : "config"])
    .map(kind => assessMultiPrCase(row, kind, context)));
  const assessed = cases.filter(item => item.status === "assessed"), proven = assessed.filter(item => item.correct);
  return { "verified-payload-deliveries": assessed.length ? proven.length : null,
    "verified-crlf-deliveries": assessed.some(item => item.kind === "crlf") ? proven.filter(item => item.kind === "crlf").length : null,
    "unassessed-payload-cases": cases.length - assessed.length, candidateCases: cases.length,
    provenCases: proven.length, assessedCases: assessed.length };
}

export function nativeMultiPrModule(contract) {
  if (digest(readFileSync(import.meta.filename)) !== contract.interpreterSha256) throw new Error("Frozen multi-PR interpreter changed");
  const presentation = name => ({ name, legendLabel: name, transform: "identity" });
  const metric = (id, role, name, direction, formula, unit = "branch payloads") => ({ id, role, name, direction, formula, unit, presentation: presentation(name) });
  return {
    definition: {
      schemaVersion: 3, slug: "smoke-multi-pr", repository: contract.repository, workflowName: "Smoke Multi PR",
      sourcePath: ".github/workflows/smoke-multi-pr.md", adoption: contract.adoption, evaluation: { mode: "attainment-only" },
      intent: { goal: "Deliver two distinct source-required branch payloads in one execution, preserving CRLF bytes.",
        acceptance: contract.nativeContract.acceptedEvidence, temporalAnchor: "workflow-adoption" },
      evidence: { key: "native-multi-pr-payload-deliveries-v1", repositories: [contract.repository],
        opportunity: contract.nativeContract.population, filters: Object.values(contract.nativeContract).filter(value => typeof value === "string"),
        collection: "Digest-checked source profiles, exhaustive retained initial-run/job/artifact inventory, original native patches, protected Git API operation receipts and immutable target-tree objects. No network during evaluation.",
        measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
        frozenContractSha256: contract.frozenContractSha256, interpreterSha256: contract.interpreterSha256 },
      model: { architecture: "Independent original-patch/native-byte comparison against protected-receipt-bound target Git trees.",
        recommendation: "Review independently demonstrated partial deliveries separately from missing cases, full two-PR/comment acceptance, trend and cost.",
        presentation: { label: "Verified branch payload deliveries", betterLabel: "More correctly delivered payloads" } },
      summary: { nativeLabel: "Verified branch payload deliveries" },
      metrics: [
        metric("verified-payload-deliveries", "primary", "Verified payloads", "increase", "Count source-bound branch payloads whose original bytes equal the exact intended immutable target-tree addition, once per initial case."),
        metric("verified-crlf-deliveries", "diagnostic", "Verified CRLF payloads", "increase", "Count verified CRLF cases with every supplied carriage return preserved in the target Git blob."),
        metric("unassessed-payload-cases", "diagnostic", "Unassessed payload cases", "decrease", "Count inventoried source-era candidate cases without independent immutable delivery evidence; exact eligibility is unknown.", "candidate cases"),
      ],
      validationExamples: contract.validationExamples,
    },
    scoreMetric(id, evidence) {
      if (!["verified-payload-deliveries", "verified-crlf-deliveries", "unassessed-payload-cases"].includes(id)) throw new Error("Unknown multi-PR metric");
      return scanMultiPrEvidence(evidence, contract)?.[id] ?? null;
    },
    collectBatch(requests) {
      const index = readCensusJson(`${contract.directory}/index.json`);
      if (index.complete !== true || index.contractSha256 !== censusDigest(contract)) throw new Error("Native multi-PR index changed");
      const review = readCensusJson(`${contract.directory}/source-review.json.gz`);
      if (censusDigest(review) !== contract.sourceReviewSha256
        || index.sourceReviewSha256 !== contract.sourceReviewSha256) throw new Error("Native source review changed");
      for (const [file, expected] of Object.entries(index.originals ?? {})) {
        if (!["sources.json.gz", "host-sources.json.gz", "inventory.json.gz", "receipts.json.gz", "deliveries.json.gz", "additional-protected-jobs.json.gz"].includes(file)
          || censusDigest(readCensusJson(`${contract.directory}/${file}`)) !== expected) throw new Error("Native original evidence changed");
      }
      if (Object.keys(index.originals ?? {}).length !== 6) throw new Error("Missing native original-evidence closure");
      const rows = index.parts.flatMap(part => {
        if (!/^observations-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe multi-PR evidence partition");
        const rows = readCensusJson(`${contract.directory}/${part.file}`);
        if (rows.length !== part.count || censusDigest(rows) !== part.sha256) throw new Error("Native multi-PR evidence changed");
        return rows;
      });
      if (rows.length !== index.observations) throw new Error("Incomplete multi-PR evidence archive");
      return requests.map(request => {
        if (request.repository && request.repository !== contract.repository) throw new Error("Wrong multi-PR evidence repository");
        if (!date(request.windowStart) || !date(request.windowEnd)
          || Date.parse(request.windowStart) >= Date.parse(request.windowEnd)) throw new Error("Invalid explicit native period");
        const observations = rows.flatMap(row => {
          const windowCases = ["doc", row.era === "crlf" ? "crlf" : "config"].filter(kind => {
            const assessment = assessMultiPrCase(row, kind, contract), at = assessment.at ?? row.run.at;
            return Date.parse(at) >= Date.parse(request.windowStart) && Date.parse(at) < Date.parse(request.windowEnd);
          });
          return windowCases.length ? [{ ...row, windowCases }] : [];
        });
        const scan = scanMultiPrEvidence({ valid: true, observations }, contract);
        const covered = Date.parse(request.windowEnd) <= Date.parse(contract.until);
        return { evidence: { valid: covered, observations,
          coverageStatus: !covered ? "missing" : scan["unassessed-payload-cases"] || index.acquisitionOpen ? "partial" : "complete",
          candidateCaseCount: scan.candidateCases, eligibleCount: null,
          maturityStatus: "matured", fullGoalAcceptance: "not-measured", costs: "not-measured",
          acquisitionOpen: index.acquisitionOpen,
          missingReason: !covered ? "The requested period extends beyond the frozen acquisition cutoff."
            : scan.assessedCases ? null : "No independent protected-operation and immutable target-byte receipt in this period.",
          comparable: false, comparisonReason: "Incomplete receipt coverage and separately identified config/CRLF intent eras; do not infer a trend." },
        provenance: [{ repository: contract.repository, kind: "native-multi-pr-target-tree-index", ref: censusDigest(index) }],
        commit: contract.sourceRevision };
      });
    },
  };
}
