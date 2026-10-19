import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

test("copied internal Node CLIs work without executable bits and preserve literal arguments", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "value-cli-portability-"));
  try {
    for (const file of ["common.mjs", "json-archive.mjs"]) {
      copyFileSync(new URL(`../../.github/skills/add-operational-value/scripts/${file}`, import.meta.url),
        path.join(directory, file));
    }
    const script = path.join(directory, "fixture.mjs");
    writeFileSync(script, `if (process.argv[2] === "--fail") {
  console.error("original failure");
  process.exit(7);
}
console.log(JSON.stringify(process.argv.slice(2)));
`, { mode: 0o644 });
    const { run, runJson } = await import(pathToFileURL(path.join(directory, "common.mjs")).href);
    const args = ["space preserved", "$(not-a-shell-command)", "--literal"];
    assert.deepEqual(runJson(script, args), args);
    assert.throws(() => run(script, ["--fail"]), /original failure/);
    assert.equal(run(process.execPath, ["-p", "JSON.stringify(3)"]).trim(), "3");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
