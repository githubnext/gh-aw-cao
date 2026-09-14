import assert from "node:assert/strict";
import test from "node:test";

import { stepBlock, workflow } from "./workflow-contract.helpers.mjs";

test("release context paginates before filtering complete API responses", () => {
  const fetchReleaseContext = stepBlock(workflow("release.md"), "Fetch release context");

  assert.doesNotMatch(fetchReleaseContext, /gh api[^\n]*--slurp/);
  assert.equal(
    fetchReleaseContext.match(/gh api --paginate[\s\S]*?\|\n\s+jq --slurp/g)?.length,
    2,
    "each API request should paginate before local jq slurps its responses",
  );
});
