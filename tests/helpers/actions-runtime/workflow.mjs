import { parse } from "yaml";

export function sampleWorkflow(lock, { allowStaged = false } = {}) {
  const metadata = JSON.parse(/^# gh-aw-metadata: (.+)$/m.exec(lock)?.[1] || "{}");
  const manifest = JSON.parse(/^# gh-aw-manifest: (.+)$/m.exec(lock)?.[1] || "{}");
  const workflow = parse(lock);
  if ((!metadata.dry_run && !allowStaged) || manifest.threat_detection?.mode !== "disabled") {
    throw new Error("Only dry-run locks or explicitly allowed staged samples with detection disabled are supported");
  }
  const handlers = workflow.jobs?.safe_outputs?.steps?.filter(step => step.id === "process_safe_outputs") || [];
  if (handlers.length !== 1 || handlers[0].env?.GH_AW_SAFE_OUTPUTS_STAGED !== "true") {
    throw new Error("Compiled safe outputs must be unconditionally staged");
  }
  const executions = Object.values(workflow.jobs).flatMap(job => job.steps?.filter(step => step.id === "agentic_execution") || []);
  if (!executions.length || executions.some(step => !step.env?.GH_AW_SAMPLES || !step.run?.includes('/gh-aw/actions/apply_samples.cjs"'))) {
    throw new Error("Compiled sample replay is required");
  }
  return workflow;
}
