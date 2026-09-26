import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishRepositoryMemory, REPOSITORY_MEMORY_LIMITS } from "../../activity/repository-memory.mjs";

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
    writeFileSync(join(repository, "unsupported.js"), "throw new Error();\n");
    writeFileSync(join(repository, "oversized.txt"), "x".repeat(REPOSITORY_MEMORY_LIMITS.maxFileSize + 1));
    const deepDirectory = join(repository, ...Array.from({ length: REPOSITORY_MEMORY_LIMITS.maxNesting + 1 }, (_, index) => `d${index}`));
    mkdirSync(deepDirectory, { recursive: true });
    writeFileSync(join(deepDirectory, "too-deep.md"), "# Too deep\n");
    symlinkSync("../runtime.txt", join(repository, "outside"));
    git(repository, "add", ".");
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
      limits: REPOSITORY_MEMORY_LIMITS,
      campaigns: [{
        campaign: "ambient-context",
        branch: "memory/ambient-context",
        commit: memoryHead,
        files: [
          {
            path: ".state.json",
            oid: git(repository, "rev-parse", `${memoryHead}:.state.json`),
            sha256: createHash("sha256").update('{"cursor":1}\n').digest("hex"),
            size: 13,
          },
          {
            path: "notes.json",
            oid: git(repository, "rev-parse", `${memoryHead}:notes.json`),
            sha256: createHash("sha256").update('{"answer":42}\n').digest("hex"),
            size: 14,
          },
        ],
      }],
    });
    assert.deepEqual(JSON.parse(readFileSync(join(output, "manifest.json"), "utf8")), manifest);
    assert.throws(() => readFileSync(join(output, "ambient-context", "outside")));
    assert.throws(() => readFileSync(join(output, "ambient-context", "unsupported.js")));
    assert.throws(() => readFileSync(join(output, "ambient-context", "oversized.txt")));
    assert.throws(() => readFileSync(join(output, "ambient-context", ...Array.from(
      { length: REPOSITORY_MEMORY_LIMITS.maxNesting + 1 },
      (_, index) => `d${index}`,
    ), "too-deep.md")));
    assert.throws(() => readFileSync(join(output, "not-installed", "private.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("caps the number of files published for each campaign", async () => {
  const root = mkdtempSync(join(tmpdir(), "cao-repository-memory-count-"));
  const repository = join(root, "repository");
  try {
    execFileSync("git", ["init", repository]);
    git(repository, "config", "user.name", "CAO Test");
    git(repository, "config", "user.email", "cao@example.test");
    for (let index = 0; index <= REPOSITORY_MEMORY_LIMITS.maxFileCount; index += 1) {
      writeFileSync(join(repository, `${String(index).padStart(3, "0")}.txt`), `${index}\n`);
    }
    git(repository, "add", ".");
    git(repository, "commit", "-m", "bounded memory");
    git(repository, "update-ref", "refs/remotes/origin/memory/bounded", git(repository, "rev-parse", "HEAD"));

    const manifest = await publishRepositoryMemory({
      repository,
      inventory: { campaigns: { rows: [{ campaign: "bounded" }] } },
      output: join(root, "output"),
    });

    assert.equal(manifest.campaigns[0].files.length, REPOSITORY_MEMORY_LIMITS.maxFileCount);
    assert.equal(manifest.campaigns[0].files.at(-1).path, "399.txt");
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
