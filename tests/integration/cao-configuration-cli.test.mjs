import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

test("installed CAO workflows preserve control-repository checkout semantics", async () => {
  for (const workflow of ["activity", "dashboard"]) {
    const content = await readFile(path.resolve(".github", "workflows", `cao-${workflow}.yml`), "utf8");
    assert.match(content, /ref: \$\{\{ github\.workflow_sha \}\}/);
    assert.doesNotMatch(content, /repository: githubnext\/gh-aw-cao/);
    assert.match(content, /uses: \.\/\.github\/actions\/setup-cao-runtime/);
    assert.match(content, new RegExp(`bundle: ${workflow}`));
  }
});
