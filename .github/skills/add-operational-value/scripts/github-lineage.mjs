const workflowPattern = /^[a-zA-Z0-9_-]+$/;
const positive = value => Number.isSafeInteger(value) && value > 0;

export class OutOfScopeProducer extends Error {}

function runReference(url) {
  const match = typeof url === "string" && url.match(
    /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/([1-9]\d*)(?:\/attempts\/([1-9]\d*))?$/,
  );
  return match ? { repository: match[1], runId: match[2], attempt: match[3] ? Number(match[3]) : null } : null;
}

export function parseWorkflowReference(body, repository) {
  if (typeof body !== "string") throw new Error("Missing output body");
  const comments = [...body.matchAll(/<!--([\s\S]*?)-->/g)].map(match => match[1].trim());
  const references = [];
  const declaredWorkflowIds = new Set();
  const trackerIds = new Set();
  for (const comment of comments) {
    const workflow = comment.match(/^gh-aw-workflow-id:\s*([a-zA-Z0-9_-]+)$/)?.[1];
    const tracker = comment.match(/^gh-aw-tracker-id:\s*([a-zA-Z0-9_-]+)$/)?.[1];
    if (workflow) declaredWorkflowIds.add(workflow);
    if (tracker) trackerIds.add(tracker);
    if (comment.startsWith("gh-aw-execution:")) {
      let value;
      try {
        value = JSON.parse(comment.slice("gh-aw-execution:".length).trim());
      } catch {
        throw new Error("Invalid execution marker JSON");
      }
      if (!value || typeof value !== "object") throw new Error("Invalid execution marker identity");
      const ref = runReference(value.run_url);
      if (value.version !== 1 || !ref || typeof value.repository !== "string"
        || value.repository.toLowerCase() !== ref.repository.toLowerCase()
        || String(value.run_id) !== ref.runId || typeof value.aw_workflow_id !== "string"
        || !workflowPattern.test(value.aw_workflow_id)
        || !positive(Number(value.run_attempt))
        || (ref.attempt !== null && ref.attempt !== Number(value.run_attempt))) {
        throw new Error("Invalid execution marker identity");
      }
      references.push({ ...ref, workflowId: value.aw_workflow_id, attempt: Number(value.run_attempt),
        marker: "gh-aw-execution-v1" });
    } else if (comment.startsWith("gh-aw-agentic-workflow:")) {
      const workflowId = comment.match(/(?:^|,\s*)workflow_id:\s*([a-zA-Z0-9_-]+)(?:,|$)/)?.[1];
      const runUrl = comment.match(/(?:^|,\s*)run:\s*(https:\/\/[^\s,]+)(?:,|$)/)?.[1];
      const runId = comment.match(/(?:^|,\s*)id:\s*([1-9]\d*)(?:,|$)/)?.[1];
      const ref = runReference(runUrl);
      if (!ref || (runId && runId !== ref.runId)) throw new Error("Invalid legacy run marker");
      references.push({ ...ref, workflowId: workflowId ?? null, marker: "gh-aw-agentic-workflow" });
    }
  }
  if (declaredWorkflowIds.size > 1 || trackerIds.size > 1) throw new Error("Conflicting workflow provenance markers");
  if (!references.length) return null;
  const primary = [...declaredWorkflowIds][0];
  const selected = primary ? references.filter(ref => ref.workflowId === primary || ref.workflowId === null)
    .map(ref => ({ ...ref, workflowId: primary })) : references;
  if (!selected.length || new Set(selected.map(ref => ref.workflowId)).size > 1
    || new Set(selected.map(ref => `${ref.repository.toLowerCase()}:${ref.runId}`)).size > 1
    || new Set(selected.filter(ref => ref.attempt !== null).map(ref => ref.attempt)).size > 1) {
    throw new Error("Conflicting workflow provenance markers");
  }
  const reference = selected.find(ref => ref.marker === "gh-aw-execution-v1") ?? selected[0];
  if (reference.repository.toLowerCase() !== repository.toLowerCase()) {
    throw new OutOfScopeProducer("Producer repository is outside the explicit acquisition scope");
  }
  return { ...reference, trackerId: [...trackerIds][0] ?? null,
    additionalRunReferences: references.filter(ref => ref.repository.toLowerCase() === repository.toLowerCase()
      && (ref.runId !== reference.runId || ref.workflowId !== reference.workflowId)) };
}

export function validateRunReference(reference, run, sourcePath, repository) {
  const expected = sourcePath.replace(/\.md$/, ".lock.yml");
  const actual = String(run.path ?? "").split("@")[0];
  if (String(run.id) !== reference.runId || run.repository?.full_name?.toLowerCase() !== repository.toLowerCase()
    || actual !== expected || !/^[a-f0-9]{40}$/.test(run.head_sha ?? "")
    || (reference.attempt !== null && run.run_attempt !== reference.attempt)) {
    throw new Error("Run identity, attempt, repository or source path mismatch");
  }
  return { status: "verified-run-reference", sourcePath, executionPath: actual, headSha: run.head_sha,
    attempt: run.run_attempt, createdAt: run.created_at, url: run.html_url,
    limitation: "An editable footer links to a verified run; it is not a safe-output creation receipt." };
}
