import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { workflowsDirectory } from "./workflow-contract.helpers.mjs";

const HARDCODED_ACTIONS_URL = /https:\/\/github\.com\/(?:\$\{\{\s*github\.repository\s*\}\}|[^/\s)]+)\/actions\//;

function workflowSources(directory = workflowsDirectory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(prefix, entry.name);
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return workflowSources(path, relativePath);
    if (!entry.isFile() || !entry.name.endsWith(".md")) return [];
    return [[relativePath, readFileSync(path, "utf8")]];
  });
}

test("workflow sources use the GitHub Actions server URL instead of github.com for Actions links", () => {
  const sources = workflowSources();
  assert.ok(sources.length > 0, "expected workflow Markdown sources");

  for (const [path, source] of sources) {
    assert.doesNotMatch(
      source,
      HARDCODED_ACTIONS_URL,
      `${path} hard-codes github.com for a GitHub Actions URL; use github.server_url or GITHUB_SERVER_URL`,
    );
  }
});
