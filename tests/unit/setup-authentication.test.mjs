import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setupCaoControlPlane } from "../../activity/setup.mjs";

for (const [name, repositories, target, visibility, expectedProfile] of [
  ["control repository only", "", "acme/control", "PUBLIC", "workflow-token"],
  ["same-owner public target", "acme/service", "ACME/service", "PUBLIC", "workflow-token"],
  ["same-owner public wildcard", "acme/*", "acme/service", "PUBLIC", "workflow-token"],
  ["cross-owner public target", "octo/service", "octo/service", "PUBLIC", "enterprise-app"],
  ["private control repository", "", "acme/control", "PRIVATE", "github-app"],
  ["internal control repository", "", "acme/control", "INTERNAL", "github-app"],
]) {
  test(`setup detects authentication requirements for ${name}`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cao-setup-auth-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const policyPath = path.join(root, "cao.json");
    await writeFile(policyPath, JSON.stringify({
      version: 1,
      "control-plane": {
        campaigns: {},
        activity: { repositories: ["acme/control", "acme/old"], retention: { days: 30 } },
      },
    }));
    const calls = [];
    const selections = [];
    const notes = [];
    const result = await setupCaoControlPlane({
      policyPath,
      prompt: {
        text: async (message) => message.startsWith("Repositories") ? repositories : "client-id",
        select: async (message, choices) => {
          selections.push({ message, choices });
          return expectedProfile;
        },
        confirm: async () => true,
        note: (message) => notes.push(message),
      },
      execute(command, args) {
        assert.equal(command, "gh");
        calls.push(args);
        if (args.join(" ") === "auth status") return { status: 0 };
        if (args.includes("--jq")) return { status: 0, stdout: "acme/control" };
        if (args[0] === "repo") {
          const details = { nameWithOwner: target, visibility };
          if (args[1] === "list") return { status: 0, stdout: JSON.stringify([details]) };
          return { status: 0, stdout: JSON.stringify(args[2] === "acme/control"
            ? { nameWithOwner: "acme/control", visibility: target === "acme/control" ? visibility : "PUBLIC" }
            : details) };
        }
        if (args[0] === "api") {
          return { status: 0, stdout: '{"build_type":"workflow","public":true}' };
        }
        assert.deepEqual(args, [
          "variable", "set", "GH_AW_GITHUB_AUTH_MODE", "--repo", "acme/control", "--body", "workflow-token",
        ]);
        return { status: 0 };
      },
      setupAuthentication(profile) {
        assert.notEqual(profile, "workflow-token");
        calls.push(["connect", profile]);
        return { profile };
      },
    });
    const saved = JSON.parse(await readFile(policyPath, "utf8"))["control-plane"];
    assert.equal(result.profile, expectedProfile);
    assert.deepEqual(saved.scope["allowed-repositories"],
      target === "acme/control" ? ["acme/control"] : ["acme/control", target]);
    const automatic = expectedProfile === "workflow-token";
    assert.equal(selections.length, automatic ? 0 : 1);
    assert.equal(calls.some(([command]) => command === "connect"), !automatic);
    assert.equal(calls.some(([command]) => command === "variable"), automatic);
    if (automatic) {
      assert.deepEqual(result.authentication, { mode: "workflow-token", repository: "acme/control" });
      assert.deepEqual(saved.activity, { repositories: ["acme/control"], retention: { days: 30 } });
      assert.ok(notes.some((note) => note.includes("Activity will collect only the control repository")));
    }
  });
}
