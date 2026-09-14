import assert from "node:assert/strict";
import test from "node:test";

import { stepBlock, workflow } from "./workflow-contract.helpers.mjs";

test("release context paginates before filtering complete API responses", () => {
  const fetchReleaseContext = stepBlock(workflow("release.md"), "Fetch release context");

  assert.doesNotMatch(fetchReleaseContext, /gh api[^\n]*--slurp/);
  assert.equal(
    fetchReleaseContext.match(/jq --slurp/g)?.length,
    2,
    "each paginated API response should be slurped by local jq",
  );
});
