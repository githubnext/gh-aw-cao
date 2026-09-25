import path from "node:path";
import { writeFile } from "node:fs/promises";

export async function runActivityStats({
  options,
  activityWorkflowStats,
  option,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["repo", "workflow", "artifact", "limit", "keep", "output"]);
  const stats = await activityWorkflowStats({
    repo: option(options, "repo", false),
    workflow: option(options, "workflow", false),
    artifact: option(options, "artifact", false),
    limit: option(options, "limit", false),
    keep: Boolean(options.keep),
  });
  const outputPath = option(options, "output", false);
  if (outputPath) await writeFile(path.resolve(outputPath), `${JSON.stringify(stats, null, 2)}\n`);
  return stats;
}
