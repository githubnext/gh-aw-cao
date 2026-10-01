import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { changedGoFiles, checkGoCoverage } from "../../scripts/check-go-coverage.mjs";

const profile = `mode: atomic
github.com/githubnext/gh-aw-cao/server/internal/foo/a.go:1.1,3.2 3 1
github.com/githubnext/gh-aw-cao/server/internal/foo/a.go:4.1,5.2 1 0
github.com/githubnext/gh-aw-cao/server/internal/foo/b.go:1.1,4.2 3 0
github.com/githubnext/gh-aw-cao/server/internal/foo/b.go:5.1,6.2 1 1
`;

test("gates each modified production Go file by covered statements", () => {
  assert.deepEqual(
    checkGoCoverage(["server/internal/foo/a.go", "server/internal/foo/b.go"], profile),
    [
      { file: "server/internal/foo/a.go", total: 4, covered: 3, passed: false },
      { file: "server/internal/foo/b.go", total: 4, covered: 1, passed: false },
    ],
  );
  assert.deepEqual(checkGoCoverage(["server/internal/foo/a.go"], profile.replace("3 1", "4 1")), [
    { file: "server/internal/foo/a.go", total: 5, covered: 4, passed: true },
  ]);
});

test("ignores tests and other directories but fails closed on missing coverage", () => {
  assert.deepEqual(checkGoCoverage(["server/internal/foo/a_test.go", "dashboard/a.go"], profile), []);
  assert.deepEqual(checkGoCoverage(["server/internal/foo/new.go"], profile), [
    { file: "server/internal/foo/new.go", total: 0, covered: 0, passed: false },
  ]);
  assert.throws(() => checkGoCoverage(["server/internal/foo/a.go"], "mode: atomic\nbad line"), /Invalid Go coverage/);
});

test("merges repeated coverpkg blocks from separate test packages", () => {
  const repeated = `${profile}github.com/githubnext/gh-aw-cao/server/internal/foo/a.go:1.1,3.2 3 0
github.com/githubnext/gh-aw-cao/server/internal/foo/a.go:4.1,5.2 1 1
`;
  assert.deepEqual(checkGoCoverage(["server/internal/foo/a.go"], repeated), [
    { file: "server/internal/foo/a.go", total: 4, covered: 4, passed: true },
  ]);
});

test("selects only existing production Go files changed on the local branch or working tree", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "cao-go-gate-test-"));
  const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const write = (file) => {
    mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
    writeFileSync(path.join(cwd, file), "package foo\n");
  };
  try {
    git("init", "-b", "main");
    for (const file of ["server/base.go", "server/gone.go", "server/untouched.go"]) write(file);
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base");
    git("switch", "-q", "-c", "feature");
    write("server/committed.go");
    git("add", ".");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "feature");
    write("server/staged.go");
    git("add", "server/staged.go");
    writeFileSync(path.join(cwd, "server/base.go"), "package foo\nvar Changed = true\n");
    write("server/untracked.go");
    write("server/foo_test.go");
    git("rm", "server/gone.go");
    assert.deepEqual(changedGoFiles("main", cwd).sort(), [
      "server/base.go", "server/committed.go", "server/staged.go", "server/untracked.go",
    ]);
    assert.throws(() => changedGoFiles("missing-base", cwd), /fetch the base branch/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
