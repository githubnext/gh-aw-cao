import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishRepositoryMemory } from "../../activity/repository-memory.mjs";

function git(repository, ...arguments_) {
  return execFileSync("git", ["-C", repository, ...arguments_], { encoding: "utf8" }).trim();
}

test("publishes installed campaign memory from remote refs without checking them out", async () => {
  const root = mkdtempSync(join(tmpdir(), "cao-repository-memory-"));
  const repository = join(root, "repository");
  const output = join(root, "output");
  try {
    execFileSync("git", ["init", repository]);
    git(repository, "config", "user.name", "CAO Test");
    git(repository, "config", "user.email", "cao@example.test");
    writeFileSync(join(repository, "runtime.txt"), "runtime checkout\n");
    git(repository, "add", "runtime.txt");
    git(repository, "commit", "-m", "runtime");
    const runtimeHead = git(repository, "rev-parse", "HEAD");

    git(repository, "checkout", "--orphan", "memory/ambient-context");
    git(repository, "rm", "-rf", ".");
    writeFileSync(join(repository, "notes.json"), '{"answer":42}\n');
    writeFileSync(join(repository, ".state.json"), '{"cursor":1}\n');
    symlinkSync("../runtime.txt", join(repository, "outside"));
    git(repository, "add", "notes.json", ".state.json", "outside");
    git(repository, "commit", "-m", "memory");
    const memoryHead = git(repository, "rev-parse", "HEAD");
    git(repository, "update-ref", "refs/remotes/origin/memory/ambient-context", memoryHead);

    git(repository, "checkout", "--orphan", "memory/not-installed");
    git(repository, "rm", "-rf", ".");
    writeFileSync(join(repository, "private.json"), "{}\n");
    git(repository, "add", "private.json");
    git(repository, "commit", "-m", "other memory");
    git(repository, "update-ref", "refs/remotes/origin/memory/not-installed", git(repository, "rev-parse", "HEAD"));
    git(repository, "checkout", "--detach", runtimeHead);

    const manifest = await publishRepositoryMemory({
      repository,
      inventory: { campaigns: { rows: [{ campaign: "ambient-context" }] } },
      output,
      generatedAt: "2026-09-25T22:24:29.769Z",
    });

    assert.equal(readFileSync(join(repository, "runtime.txt"), "utf8"), "runtime checkout\n");
    assert.equal(readFileSync(join(output, "ambient-context", "notes.json"), "utf8"), '{"answer":42}\n');
    assert.equal(readFileSync(join(output, "ambient-context", ".state.json"), "utf8"), '{"cursor":1}\n');
    assert.deepEqual(manifest, {
      version: 1,
      generatedAt: "2026-09-25T22:24:29.769Z",
      campaigns: [{
        campaign: "ambient-context",
        branch: "memory/ambient-context",
        commit: memoryHead,
        files: [
          {
            path: ".state.json",
            oid: git(repository, "rev-parse", `${memoryHead}:.state.json`),
            size: 13,
          },
          {
            path: "notes.json",
            oid: git(repository, "rev-parse", `${memoryHead}:notes.json`),
            size: 14,
          },
        ],
      }],
    });
    assert.deepEqual(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")), manifest);
    assert.throws(() => readFileSync(join(output, "ambient-context", "outside")));
    assert.throws(() => readFileSync(join(output, "not-installed", "private.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects inventory without campaign rows", async () => {
  await assert.rejects(
    publishRepositoryMemory({ repository: ".", inventory: {}, output: join(tmpdir(), "unused-memory-output") }),
    /Campaign inventory is missing/,
  );
});
