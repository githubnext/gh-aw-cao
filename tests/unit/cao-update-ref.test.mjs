import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runCli, updateCaoCampaigns } from "../../activity/cao.mjs";
import { USAGE } from "../../activity/cli-usage.mjs";
import { parseUpdateArguments } from "../../activity/commands/update.mjs";

const oldCommit = "a".repeat(40);
const commit = "b".repeat(40);
const catalog = "githubnext/gh-cao";
const ok = { status: 0, stdout: "", stderr: "" };

async function withInstallation(run, { defaultBranch = "main" } = {}) {
  const root = await mkdtemp(path.resolve("cao-update-ref-"));
  const previousDirectory = process.cwd();
  const records = path.join(root, ".github", "aw", "packages");
  const policyPath = path.join(root, ".github", "workflows", "cao.json");
  const policy = {
    version: 1,
    "gh-aw-version": "v0.89.22",
    "control-plane": {
      scope: { "allowed-repositories": ["acme/control"] },
      campaigns: {
        dependabot: {
          mode: "live",
          enabled: false,
          workers: { planner: { workflow: "old-planner", enabled: false, "max-mode": "review" } },
        },
      },
    },
  };
  const recordPaths = new Map();
  try {
    await mkdir(records, { recursive: true });
    await mkdir(path.dirname(policyPath), { recursive: true });
    await writeFile(policyPath, JSON.stringify(policy));
    for (const [name, packageName] of [
      ["root", catalog], ["dependabot", `${catalog}/dependabot`], ["unrelated", "acme/other"],
    ]) {
      const recordPath = path.join(records, `${name}.json`);
      recordPaths.set(packageName, recordPath);
      await writeFile(recordPath, JSON.stringify({
        schemaVersion: 1, package: packageName, source: `${packageName}@${oldCommit}`,
        resolvedCommit: oldCommit, files: [],
      }));
    }
    process.chdir(root);
    const calls = [];
    const execute = (command, args) => {
      calls.push([command, args]);
      if (command === "gh" && args.join(" ") === "aw version") {
        return { ...ok, stderr: "gh aw version v0.89.22\n" };
      }
      if (command === "gh" && args[0] === "api") {
        assert.deepEqual(args.slice(0, 3), ["api", "--hostname", "github.com"]);
        if (args[3] === `/repos/${catalog}`) {
          assert.deepEqual(args.slice(4), ["--jq", ".default_branch"]);
          return { ...ok, stdout: `${defaultBranch}\n` };
        }
        if (args[3] === `/repos/${catalog}/releases?per_page=100`) {
          assert.deepEqual(args.slice(4), ["--paginate", "--jq", ".[] | select(.draft == false and .prerelease == false) | .tag_name"]);
          return { ...ok, stdout: "untagged-1234\nv0.0.2\nv0.0.1\nv1.0.0-rc.1\n" };
        }
        assert.ok([encodeURIComponent(defaultBranch), "v0.0.2"].includes(args[3].split("/").at(-1))
          || /^b{7,40}$/i.test(args[3].split("/").at(-1)));
        assert.deepEqual(args.slice(4), ["--jq", ".sha"]);
        return { ...ok, stdout: `${commit}\n` };
      }
      if (command === "gh" && args[0] === "aw" && args[1] === "add") {
        const packageName = args[2].split("@")[0];
        assert.ok(recordPaths.has(packageName));
        assert.equal(args[2], `${packageName}@${commit}`);
        assert.equal(args[3], "--force");
        const recordPath = recordPaths.get(packageName);
        const record = JSON.parse(readFileSync(recordPath, "utf8"));
        // The caller must not rewrite provenance to trick gh-aw into selecting a ref.
        assert.equal(record.source, `${packageName}@${oldCommit}`);
        writeFileSync(recordPath, JSON.stringify({
          ...record, source: `${packageName}@${commit}`, resolvedCommit: commit,
        }));
        return ok;
      }
      if (command === process.execPath) {
        assert.deepEqual(args.slice(0, 2), [
          path.join(".github", "workflows", "shared", "materialize-cao.mjs"), "materialize",
        ]);
        const packageName = args[2] === "root" ? catalog : `${catalog}/${args[2]}`;
        assert.equal(JSON.parse(readFileSync(recordPaths.get(packageName), "utf8")).resolvedCommit, commit);
        if (args[2] === "dependabot") {
          writeFileSync(path.join(root, "dependabot", "cao.json"), JSON.stringify({
            campaign: "dependabot", orchestrator: "dependabot", workers: { planner: "new-planner" },
          }));
        }
        return ok;
      }
      assert.fail(`Unexpected command: ${command} ${args.join(" ")}`);
    };
    await mkdir(path.join(root, "dependabot"));
    await run({ execute, calls, policy, policyPath, recordPaths });
  } finally {
    process.chdir(previousDirectory);
    await rm(root, { recursive: true, force: true });
  }
}

for (const ref of ["main", "master", "latest", commit, commit.slice(0, 7).toUpperCase()]) {
  test(`cao update ${ref} reapplies only installed CAO packages at one immutable revision`, async () => {
    await withInstallation(async ({ execute, calls, policy, policyPath, recordPaths }) => {
      const options = [ref, "--engine", "copilot", "--dir=.github/workflows"];
      const result = await updateCaoCampaigns(options, { execute });
      assert.equal(result.ref, ref);
      assert.equal(result.resolvedCommit, commit);
      assert.deepEqual(result.campaigns, [catalog, `${catalog}/dependabot`]);
      assert.deepEqual(result.declarations, ["dependabot"]);
      const namedRef = ["main", "master", "latest"].includes(ref);
      assert.equal(calls.filter(([, args]) => args[0] === "api").length, namedRef ? 2 : 1);
      assert.deepEqual(calls.map(([command, args]) => command === "gh" ? args[1] : args[2]),
        ["version", ...(namedRef ? ["--hostname"] : []), "--hostname", "add", "root", "add", "dependabot"]);
      for (const [, args] of calls.filter(([, args]) => args[1] === "add")) {
        assert.deepEqual(args.slice(4), args[2] === `${catalog}@${commit}`
          ? ["--no-security-scanner", ...options.slice(1)]
          : options.slice(1));
      }
      policy["control-plane"].campaigns.dependabot.workers.planner.workflow = "new-planner";
      assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
      assert.equal(JSON.parse(await readFile(recordPaths.get("acme/other"), "utf8")).resolvedCommit, oldCommit);
      assert.equal(options[0], ref);
    });
  });
}

for (const args of [
  ["develop"], ["abc123"], ["b".repeat(41)], ["../main"],
  ["main", "--pre-releases"], ["main", "--major"], ["main", "--cool-down", "0"],
  ["main", "acme/other"], ["main", "--dir"], ["main", "--engine", "--force"],
  ["--force", "main", commit], ["--cool-down", "0", "main"],
  ["--pre-releases", "latest"], ["--unknown", "main"],
  ["--campaign"], ["--campaign", ""], ["--campaign="],
  ["--campaign", "../dependabot"], ["--campaign", "--force"],
  ["--campaign", "dependabot;echo"], ["--campaign", "Dependabot"],
  ["--campaign", "dependabot", "--campaign", "root"],
  ["--campaign=dependabot", "--campaign=dependabot"],
  ["--pr-message"], ["--pr-message", "--force"],
  ["main", "--pr-message", "CAO update"],
]) {
  test(`cao update rejects ${args.join(" ")} before any side effects`, async () => {
    await assert.rejects(updateCaoCampaigns(args, {
      execute() { assert.fail("must reject before executing commands"); },
    }), /cao update requires|Unsupported option|requires a value|only one ref|safe campaign slug|only one --campaign/);
  });
}

for (const [slug, options] of [
  ["dependabot", ["--campaign", "dependabot", "main", "--engine", "copilot"]],
  ["root", ["latest", "--campaign=root", "--force"]],
]) {
  test(`cao update selects only ${slug} and retains materialization and policy refresh`, async () => {
    await withInstallation(async ({ execute, calls, policy, policyPath, recordPaths }) => {
      const packageName = slug === "root" ? catalog : `${catalog}/${slug}`;
      const before = new Map(await Promise.all([...recordPaths].map(async ([name, file]) => [name, await readFile(file, "utf8")])));
      const result = await updateCaoCampaigns(options, { execute });
      assert.deepEqual(result.campaigns, [packageName]);
      assert.deepEqual(result.declarations, slug === "root" ? [] : ["dependabot"]);
      assert.deepEqual(calls.filter(([command]) => command === process.execPath).map(([, args]) => args[2]), [slug]);
      const additions = calls.filter(([, args]) => args[1] === "add");
      assert.equal(additions.length, 1);
      assert.equal(additions[0][1][2], `${packageName}@${commit}`);
      assert.ok(additions[0][1].every((option) => !option.startsWith("--campaign")));
      for (const [name, file] of recordPaths) {
        if (name !== packageName) assert.equal(await readFile(file, "utf8"), before.get(name));
      }
      if (slug === "dependabot") policy["control-plane"].campaigns.dependabot.workers.planner.workflow = "new-planner";
      assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
    });
  });
}

test("selected release update retains release preparation and refreshes only the selected campaign", async () => {
  await withInstallation(async ({ execute, calls, recordPaths, policy, policyPath }) => {
    await updateCaoCampaigns(["latest"], { execute });
    const beforeRoot = await readFile(recordPaths.get(catalog), "utf8");
    const start = calls.length;
    let releaseUpdates = 0;
    const prMessage = "Requested through [CAO](https://github.com/githubnext/gh-cao) to update the dependabot campaign.";
    const result = await updateCaoCampaigns(["--campaign", "dependabot", "--major", "--cool-down", "0", "--pr-message", prMessage], {
      execute(command, args) {
        if (args.includes(`/repos/${catalog}/tags`)) return { ...ok, stdout: "v0.0.2\n" };
        if (args.includes(`/repos/${catalog}/releases/tags/v0.0.2`)) return { ...ok, stdout: "v0.0.2\n" };
        if (args[1] === "update") {
          assert.deepEqual(args, ["aw", "update", `https://github.com/${catalog}/dependabot`, "--major", "--cool-down", "0", "--pr-message", prMessage]);
          const record = JSON.parse(readFileSync(recordPaths.get(`${catalog}/dependabot`), "utf8"));
          assert.equal(record.source, `${catalog}/dependabot@v0.0.2`);
          releaseUpdates += 1;
          return ok;
        }
        return execute(command, args);
      },
    });
    assert.equal(releaseUpdates, 1);
    assert.deepEqual(result.campaigns, [`${catalog}/dependabot`]);
    assert.deepEqual(result.declarations, ["dependabot"]);
    assert.deepEqual(calls.slice(start).filter(([command]) => command === process.execPath).map(([, args]) => args[2]), ["dependabot"]);
    assert.equal(await readFile(recordPaths.get(catalog), "utf8"), beforeRoot);
    policy["control-plane"].campaigns.dependabot.workers.planner.workflow = "new-planner";
    assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
  });
});

for (const slug of ["missing", "other", "gh-cao"]) {
  test(`unknown selection ${slug} fails before gh-aw version checks or mutation`, async () => {
    await withInstallation(async ({ policy, policyPath }) => {
      await assert.rejects(updateCaoCampaigns(["--campaign", slug], {
        execute() { assert.fail("must reject before executing commands"); },
      }), /Unknown installed CAO campaign/);
      assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
    });
  });
}

test("ambiguous campaign slugs fail before gh-aw version checks or mutation", async () => {
  await withInstallation(async ({ policyPath, policy }) => {
    await writeFile(path.resolve(".github/aw/packages/duplicate.json"), JSON.stringify({
      package: `${catalog}/nested/dependabot`, resolvedCommit: oldCommit, files: [],
    }));
    await assert.rejects(updateCaoCampaigns(["--campaign=dependabot"], {
      execute() { assert.fail("must reject before executing commands"); },
    }), /Ambiguous installed CAO campaign/);
    assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
  });
});

test("selected records require immutable provenance before gh-aw version checks", async () => {
  await withInstallation(async ({ recordPaths }) => {
    await writeFile(recordPaths.get(`${catalog}/dependabot`), JSON.stringify({
      package: `${catalog}/dependabot`, resolvedCommit: "main", files: [],
    }));
    await assert.rejects(updateCaoCampaigns(["--campaign=dependabot"], {
      execute() { assert.fail("must reject before executing commands"); },
    }), /full resolvedCommit SHA/);
  });
});

for (const [name, ref, result, message] of [
  ["API failure", "main", { status: 1, stderr: "not found" }, /Unable to resolve CAO ref main: not found/],
  ["invalid API SHA", "main", { ...ok, stdout: "main\n" }, /expected a matching full commit SHA/],
  ["different commit", commit, { ...ok, stdout: oldCommit }, /expected a matching full commit SHA/],
]) {
  test(`cao update stops before replacing packages on ${name}`, async () => {
    await withInstallation(async ({ execute, calls, policy, policyPath }) => {
      await assert.rejects(updateCaoCampaigns([ref], {
        execute(command, args) {
          return args[0] === "api" && args[3]?.includes("/commits/") ? result : execute(command, args);
        },
      }), message);
      assert.equal(calls.length, ref === "main" ? 2 : 1);
      assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
    });
  });
}

for (const [name, result, message] of [
  ["failed add", { status: 1, stderr: "install failed" }, /gh aw add failed.*install failed/],
  ["stale ownership record", ok, /did not record requested commit.*refusing to materialize/],
]) {
  test(`cao update refuses materialization after ${name}`, async () => {
    await withInstallation(async ({ execute, calls, policy, policyPath }) => {
      await assert.rejects(updateCaoCampaigns(["main"], {
        execute(command, args) {
          return args[1] === "add" ? result : execute(command, args);
        },
      }), message);
      assert.equal(calls.length, 3);
      assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
    });
  });
}

test("cao CLI forwards the update ref to validation and advertises it in help", async () => {
  await assert.rejects(runCli(["update", "not-a-ref"]), /cao update requires main, master, latest, or a commit SHA/);
  assert.match(USAGE, /cao update \(main\|master\|latest\|COMMIT_SHA\)/);
  assert.match(USAGE, /cao update \[--campaign SLUG\] \[--pre-releases\]/);
  assert.match(USAGE, /cao update \(main\|master\|latest\|COMMIT_SHA\) \[--campaign SLUG\]/);
  assert.match(USAGE, /use root for the CAO root\s+package/);
});

for (const args of [
  ["--force", "main"],
  ["--engine", "copilot", "main", "--force"],
  ["--engine=copilot", "--force", "main"],
  ["--force", "--", "main"],
]) {
  test(`cao update parses options before the ref: ${args.join(" ")}`, async () => {
    await withInstallation(async ({ execute, calls }) => {
      const result = await updateCaoCampaigns(args, { execute });
      assert.equal(result.ref, "main");
      assert.equal(result.resolvedCommit, commit);
      assert.equal(calls.filter(([, arguments_]) => arguments_[1] === "add").length, 2);
      assert.equal(calls.filter(([, arguments_]) => arguments_[1] === "update").length, 0);
    });
  });
}

test("release option values are not interpreted as refs", () => {
  const options = ["--major", "--cool-down", "0", "--engine", "copilot", "--dir", "main", "--pre-releases"];
  assert.deepEqual(parseUpdateArguments(options, Error), {
    ref: undefined, includePrereleases: true, updateOptions: options.slice(0, -1),
  });
});

test("PR messages are forwarded as option values, not update refs", () => {
  const message = "Requested through [CAO](https://github.com/githubnext/gh-cao) to update workflows.";
  for (const option of [["--pr-message", message], [`--pr-message=${message}`]]) {
    const options = ["--create-pull-request", ...option];
    assert.deepEqual(parseUpdateArguments(["--campaign", "activity", ...options], Error), {
      ref: undefined, campaign: "activity", includePrereleases: false, updateOptions: options,
    });
  }
});

for (const [ref, defaultBranch] of [["main", "master"], ["master", "main"], ["main", "release/default"]]) {
  test(`${ref} resolves the catalog's actual default branch ${defaultBranch}`, async () => {
    await withInstallation(async ({ execute, calls }) => {
      const result = await updateCaoCampaigns([ref], { execute });
      assert.equal(result.resolvedCommit, commit);
      const commits = calls.filter(([, args]) => args[3]?.includes("/commits/"));
      assert.equal(commits.length, 1);
      assert.equal(commits[0][1][3], `/repos/${catalog}/commits/${encodeURIComponent(defaultBranch)}`);
    }, { defaultBranch });
  });
}

for (const [ref, endpoint, result, message] of [
  ["main", `/repos/${catalog}`, { status: 1, stderr: "unavailable" }, /Unable to resolve CAO default branch: unavailable/],
  ["master", `/repos/${catalog}`, { ...ok, stdout: "" }, /expected a branch name/],
  ["master", `/repos/${catalog}`, { ...ok, stdout: "main\nmaster\n" }, /expected a branch name/],
  ["latest", `/repos/${catalog}/releases?per_page=100`, { status: 1, stderr: "no releases" }, /Unable to resolve latest stable CAO release: no releases/],
  ["latest", `/repos/${catalog}/releases?per_page=100`, { ...ok, stdout: "" }, /expected a published vMAJOR.MINOR.PATCH release tag/],
  ["latest", `/repos/${catalog}/releases?per_page=100`, { ...ok, stdout: "untagged-1234\nv1.0.0-rc.1\n" }, /expected a published vMAJOR.MINOR.PATCH release tag/],
]) {
  test(`${ref} rejects unavailable or invalid ref metadata: ${JSON.stringify(result)}`, async () => {
    await withInstallation(async ({ execute, calls, policy, policyPath }) => {
      await assert.rejects(updateCaoCampaigns([ref], {
        execute(command, args) {
          return args[3] === endpoint ? result : execute(command, args);
        },
      }), message);
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
    });
  });
}

test("latest returns an untagged installation to subsequent release-based updates", async () => {
  await withInstallation(async ({ execute, recordPaths }) => {
    const released = await updateCaoCampaigns(["--force", "latest"], { execute });
    assert.equal(released.resolvedCommit, commit);
    let releaseUpdates = 0;
    const result = await updateCaoCampaigns([], {
      execute(command, args) {
        if (args.includes(`/repos/${catalog}/tags`)) return { ...ok, stdout: "v0.0.2\n" };
        if (args.includes(`/repos/${catalog}/releases/tags/v0.0.2`)) return { ...ok, stdout: "v0.0.2\n" };
        if (args[1] === "update") {
          const packageName = args[2].replace("https://github.com/", "");
          const record = JSON.parse(readFileSync(recordPaths.get(packageName), "utf8"));
          assert.equal(record.source, `${packageName}@v0.0.2`);
          releaseUpdates += 1;
          return ok;
        }
        return execute(command, args);
      },
    });
    assert.equal(releaseUpdates, 2);
    assert.deepEqual(result.campaigns, [catalog, `${catalog}/dependabot`]);
    assert.equal(result.ref, undefined);
  });
});

test("untagged release updates explain how to return to stable releases without mutating packages", async () => {
  await withInstallation(async ({ execute, calls }) => {
    await assert.rejects(updateCaoCampaigns([], {
      execute(command, args) {
        if (args.includes(`/repos/${catalog}/tags`)) return { ...ok, stdout: "" };
        return execute(command, args);
      },
    }), /No CAO release tag found.*cao update latest/);
    assert.equal(calls.length, 1);
  });
});

test("latest compares stable release versions numerically", async () => {
  await withInstallation(async ({ execute }) => {
    const result = await updateCaoCampaigns(["latest"], {
      execute(command, args) {
        if (args[3] === `/repos/${catalog}/releases?per_page=100`) {
          return { ...ok, stdout: "v0.9.0\nv0.10.0\nv1.0.0-rc.1\n" };
        }
        if (args[3]?.includes("/commits/")) {
          assert.equal(args[3], `/repos/${catalog}/commits/v0.10.0`);
          return { ...ok, stdout: commit };
        }
        return execute(command, args);
      },
    });
    assert.equal(result.resolvedCommit, commit);
  });
});

test("latest propagates incompatible release materialization failures without changing rollout policy", async () => {
  await withInstallation(async ({ execute, policy, policyPath }) => {
    await assert.rejects(updateCaoCampaigns(["latest"], {
      execute(command, args) {
        if (command === process.execPath) return { status: 1, stderr: "CAO source revision is missing required resource: activity" };
        return execute(command, args);
      },
    }), /Unable to materialize CAO root:.*missing required resource: activity/);
    assert.deepEqual(JSON.parse(await readFile(policyPath, "utf8")), policy);
  });
});
