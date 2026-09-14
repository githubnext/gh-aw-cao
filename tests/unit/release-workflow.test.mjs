import assert from "node:assert/strict";
import test from "node:test";

import { frontmatter, stepBlock, workflow } from "./workflow-contract.helpers.mjs";

test("release context paginates before filtering complete API responses", () => {
  const fetchReleaseContext = stepBlock(workflow("release.md"), "Fetch release context");

  assert.doesNotMatch(fetchReleaseContext, /gh api[^\n]*--slurp/);
  assert.equal(
    fetchReleaseContext.match(/gh api --paginate[\s\S]*?\|\n\s+jq --slurp/g)?.length,
    2,
    "each API request should paginate before local jq slurps its responses",
  );
});

test("release safe output updates use the workflow token that created the draft release", () => {
  const config = frontmatter(workflow("release.md"), "release workflow");
  assert.deepEqual(Object.keys(config.on), ["workflow_dispatch"]);

  const safeOutputs = config["safe-outputs"];
  assert.ok(safeOutputs, "release workflow must configure safe outputs");
  assert.equal(safeOutputs["github-token"], "${{ secrets.GITHUB_TOKEN }}");
  assert.ok(
    Object.hasOwn(safeOutputs, "update-release"),
    "release workflow must enable update-release safe outputs",
  );

  const generatedRelease = workflow("release.lock.yml");
  const githubTokenLines = [...generatedRelease.matchAll(/^\s+github-token: .*$/gm)]
    .map((match) => match[0]);
  assert.ok(githubTokenLines.length > 0, "release lock file must contain generated GitHub token uses");
  assert.ok(
    githubTokenLines.every((line) => !line.includes("GH_AW_GITHUB_TOKEN")),
    "release generated GitHub-token steps must not prefer the broader safe-output token",
  );

  const processSafeOutputs = stepBlock(generatedRelease, "Process Safe Outputs");
  assert.match(processSafeOutputs, /github-token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.doesNotMatch(processSafeOutputs, /github-token: .*GH_AW_GITHUB_TOKEN/);
});
