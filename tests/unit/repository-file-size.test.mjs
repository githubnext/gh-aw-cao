import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("tracked files stay within repository byte and source-line limits", () => {
  const result = spawnSync(process.execPath, ["scripts/check-file-sizes.mjs"], {
    cwd: root,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
});

test("repository checks handle filename inventories larger than the default process buffer", () => {
  const temporary = mkdtempSync(join(os.tmpdir(), "cao-file-inventory-"));
  try {
    const bin = join(temporary, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"),
      '#!/usr/bin/env node\nprocess.stdout.write(("missing-" + "x".repeat(160) + "\\0").repeat(8192));\n',
      { mode: 0o755 });
    for (const script of ["scripts/check-file-sizes.mjs", "scripts/check-gh-aw-versions.mjs"]) {
      const result = spawnSync(process.execPath, [script], {
        cwd: root, encoding: "utf8",
        env: { ...process.env, PATH: [bin, dirname(process.execPath), process.env.PATH].join(delimiter) },
      });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
