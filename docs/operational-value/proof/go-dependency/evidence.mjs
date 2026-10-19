import { normalizeOutputIdentity } from "../../../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { gitId, repository, repositoryId, sha256 } from "./custody.mjs";

export function response(originals, endpoint) {
  const records = originals.responses.filter(row => row.endpoint === endpoint);
  if (records.length !== 1) throw new Error(`Missing or repeated bounded acquisition receipt: ${endpoint}`);
  const record = records[0];
  const stored = record.file ? originals.files?.find(row => row.path === record.file) : record;
  if (!stored || stored.bytes !== record.bytes || stored.sha256 !== record.sha256) {
    throw new Error("Missing or mismatched original response file");
  }
  const bytes = typeof stored.contentUtf8 === "string" ? Buffer.from(stored.contentUtf8)
    : Buffer.from(stored.contentBase64, "base64");
  if (!Number.isInteger(record.status) || record.status < 100 || record.status > 599
    || (stored.contentUtf8 === undefined && bytes.toString("base64") !== stored.contentBase64)
    || bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error("Public original response digest mismatch");
  if (record.status !== 200) return { available: false, status: record.status, endpoint,
    reason: `Original endpoint returned HTTP ${record.status}; missing facts, not absent or exhausted history.` };
  return { available: true, body: JSON.parse(bytes), endpoint, sha256: record.sha256 };
}

export function publicScope(originals) {
  if (originals?.schemaVersion !== 1 || originals.repository !== repository || originals.repositoryId !== repositoryId
    || !Array.isArray(originals.responses)) throw new Error("Wrong public native-originals scope");
  const direct = originals.responses.find(row => row.endpoint === `repos/${repository}`);
  const embedded = originals.responses.find(row => new RegExp(`^repos/${repository}/pulls/[1-9][0-9]*$`).test(row.endpoint));
  if (!direct && !embedded) throw new Error("No original repository metadata");
  const record = response(originals, (direct ?? embedded).endpoint);
  const metadata = direct ? record.body : record.body?.base?.repo;
  if (!record.available || metadata?.id !== repositoryId || metadata.full_name !== repository
    || metadata.private !== false || metadata.visibility !== "public") {
    throw new Error("Public repository authority not established by original metadata");
  }
}

export function supplementalSource(custody, originals, commit, file) {
  const retained = custody.archive.paths.find(row => row.commit === commit && row.path === file);
  if (!retained) throw new Error(`Missing commit/tree/path proof for ${commit}:${file}`);
  const blob = custody.resolve(commit, file);
  if (blob === null) return { available: false, reason: "Native path absent on this side of the transition." };
  if (!retained.proofOnly) return { available: true, text: custody.source(commit, file), blob };
  const result = response(originals, `repos/${repository}/git/blobs/${blob}`);
  if (!result.available) return result;
  const source = result.body;
  if (source.sha !== blob || source.encoding !== "base64" || typeof source.content !== "string") {
    throw new Error("Wrong original supplemental Git blob");
  }
  const bytes = Buffer.from(source.content.replace(/\s+/g, ""), "base64");
  if (bytes.length !== source.size || gitId("blob", bytes) !== blob) throw new Error("Supplemental Git blob identity mismatch");
  return { available: true, text: bytes.toString("utf8"), blob };
}

export function implementation(originals, custody, profile) {
  const result = response(originals, `repos/${repository}/pulls/${profile.pull}`);
  if (!result.available) return result;
  const pull = result.body, info = custody.commit(profile.commit);
  if (pull.number !== profile.pull || pull.base?.repo?.id !== repositoryId || pull.merged !== true
    || pull.merge_commit_sha !== profile.commit || info.parents[0] !== profile.parent
    || !Number.isFinite(Date.parse(pull.merged_at)) || typeof pull.body !== "string"
    || pull.merged_at < info.at) {
    throw new Error("Implementation original and actual merge/parent identity disagree");
  }
  return { available: true, pull, at: pull.merged_at, commitAt: info.at, parent: info.parents[0] };
}

export function recommendation(originals, profile, slug, implementationPull, until) {
  const result = response(originals, `repos/${repository}/issues/${profile.issue}`);
  if (!result.available) return { corroborated: false, reason: result.reason, authority: "missing-original" };
  const issue = result.body;
  if (issue.number !== profile.issue || typeof issue.body !== "string") throw new Error("Wrong original recommendation identity");
  const issueIdentity = normalizeOutputIdentity(issue, repository, ["githubnext/gh-aw"], until, originals.observedAt);
  const implementationIdentity = normalizeOutputIdentity({
    ...implementationPull, pull_request: { merged_at: implementationPull.merged_at },
  }, repository, ["githubnext/gh-aw"], until, originals.observedAt);
  const marked = issueIdentity?.workflowReference?.workflowId === slug
    || issueIdentity?.workflowReference?.additionalRunReferences?.some(row => row.workflowId === slug);
  const quoted = typeof profile.intentQuote === "string" && profile.intentQuote.length > 20
    && issue.body.includes(profile.intentQuote);
  const referenced = implementationIdentity?.relatedCandidates.includes(profile.issue);
  const preceded = issue.created_at < implementationPull.merged_at;
  return { corroborated: Boolean(marked && quoted && referenced && preceded),
    authority: "corroborated-editable-originals-not-authoritative-creation-receipt",
    producerMarker: Boolean(marked), exactIntentQuote: quoted, implementationReference: Boolean(referenced),
    issueCreatedBeforeImplementation: preceded, intentTextObservedAt: originals.observedAt,
    intentTextAtMerge: issue.updated_at <= implementationPull.merged_at ? "unchanged-since-observed-update-time" : null,
    reason: marked && quoted && referenced && preceded ? null : "Missing producer marker, exact native recommendation, temporal ordering or implementation reference.",
    issueId: issue.node_id, bodySha256: issueIdentity?.bodySha256 ?? null };
}
