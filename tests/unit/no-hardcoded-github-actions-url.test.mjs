import assert from "node:assert/strict";
import test from "node:test";
import { Linter } from "eslint";

import rule from "../../eslint-rules/no-hardcoded-github-actions-url.mjs";

function lint(source) {
  const linter = new Linter({ configType: "eslintrc" });
  linter.defineRule("no-hardcoded-github-actions-url", rule);
  return linter.verify(source, {
    parserOptions: { ecmaVersion: "latest", sourceType: "module" },
    rules: { "no-hardcoded-github-actions-url": "error" },
  });
}

test("reports literal, template, and concatenated GitHub Actions URLs", () => {
  for (const source of [
    'const url = "https://github.com/octo/repository/actions/runs/1";',
    "const url = `https://github.com/${repository}/actions/runs/${runId}`;",
    'const url = "https://github.com/" + repository + "/actions/runs/" + runId;',
    'const url = `https://github.com/${repository}/actions/runs/${runId}` + "?attempt=1";',
  ]) {
    const messages = lint(source);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].messageId, "useActionsServerUrl");
  }
});

test("allows server-derived and non-Actions GitHub URLs", () => {
  for (const source of [
    'const url = `${process.env.GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`;',
    'const url = `${github.server_url}/${github.repository}/actions/runs/${github.run_id}`;',
    'const url = "https://github.com/octo/repository/blob/main/README.md";',
  ]) {
    assert.deepEqual(lint(source), []);
  }
});
