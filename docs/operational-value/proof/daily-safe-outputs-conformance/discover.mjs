import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readOutputHistory } from "../../../../.github/skills/add-operational-value/scripts/collect-output-history.mjs";
import { writeJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

export const slug = "daily-safe-outputs-conformance";
export const frozen = {
  repository: "github/gh-aw",
  repositoryId: 1036865607,
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8",
  cutoff: "2026-10-18T15:00:12Z",
  sourceBlob: "c6e53bc51866009d78d03b17b7ba371bf9b38ad3",
};

export function discover(directory) {
  const { index, entities } = readOutputHistory(directory);
  if (index.repository !== frozen.repository || index.repositoryId !== frozen.repositoryId
    || index.sourceRevision !== frozen.revision || index.until !== frozen.cutoff
    || index.workflows.find(row => row.id === slug)?.gitBlob !== frozen.sourceBlob) {
    throw new Error("Discovery inventory does not match frozen source authority");
  }
  const candidates = entities.filter(row => row.workflowReference?.workflowId === slug
    || row.unverifiedWorkflowId === slug);
  const numbers = new Set(candidates.flatMap(row => row.relatedCandidates ?? []));
  const related = entities.filter(row => numbers.has(row.number)
    && !candidates.some(candidate => candidate.id === row.id));
  const runIds = [...new Set(candidates.map(row => row.workflowReference?.runId)
    .filter(Boolean))].sort();
  return {
    schemaVersion: 1,
    frozen,
    history: {
      index,
      fileSha256: createHash("sha256").update(readFileSync(path.join(directory, "history.json.gz"))).digest("hex"),
    },
    candidates,
    related,
    runIds,
    scope: {
      discoveryStatus: index.complete ? "complete-surviving-inventory" : "partial",
      nativeMeasurementStatus: "not-yet-acquired",
      candidateCount: candidates.length,
      relatedCount: related.length,
      runCount: runIds.length,
      limitations: index.limitations,
      interpretation: "Discovery identities and editable markers are not checker violations, accepted remediation, or creation receipts.",
    },
    acquisitionPlan: {
      status: "awaiting-coordinated-slot",
      requestsMade: 0,
      sourceEndpoints: [
        `repos/${frozen.repository}/git/commits/${frozen.revision}`,
        `repos/${frozen.repository}/git/blobs/${frozen.sourceBlob}`,
        `repos/${frozen.repository}/git/blobs/88a760de9deff7a78e1bd36310dd028316026fda`,
      ],
      candidateEndpoints: [...candidates, ...related].flatMap(row => [
        `repos/${frozen.repository}/issues/${row.number}/timeline?per_page=100`,
        ...(row.kind === "PullRequest" ? [`repos/${frozen.repository}/pulls/${row.number}`] : []),
      ]),
      runEndpoints: runIds.flatMap(id => [
        `repos/${frozen.repository}/actions/runs/${id}`,
        `repos/${frozen.repository}/actions/runs/${id}/jobs?per_page=100`,
        `repos/${frozen.repository}/actions/runs/${id}/artifacts?per_page=100`,
      ]),
      pagination: "Follow every Link/cursor to exhaustion under a coordinated bounded/resumable acquisition budget; no requests are executed by this producer.",
      furtherScope: "Source review must identify checker/specification imports and the independently protected report evidence before this plan can be considered sufficient.",
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Usage: node discover.mjs SHARED-HISTORY-DIRECTORY");
  const result = discover(process.argv[2]);
  const output = path.dirname(fileURLToPath(import.meta.url));
  mkdirSync(output, { recursive: true });
  writeJsonArchive(path.join(output, "discovery.json.gz"), result);
  console.log(JSON.stringify(result.scope));
}
