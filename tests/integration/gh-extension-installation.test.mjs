import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const platforms = [
  "darwin-amd64", "darwin-arm64", "linux-amd64", "linux-arm64",
  "windows-amd64.exe", "windows-arm64.exe",
];

async function run(args, env) {
  const child = spawn("gh", args, { env, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
  const [status] = await once(child, "close");
  return { status, stdout, stderr };
}

test("real GitHub CLI discovers, installs, and dispatches native release assets", { timeout: 120_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cao-gh-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const binary = readFileSync(resolve(process.env.CAO_EXTENSION_BINARY || "gh-cao"));
  const version = process.env.CAO_EXTENSION_VERSION || "dev";
  const socket = join(directory, "api.sock");
  const config = join(directory, "config");
  mkdirSync(config);
  // GitHub CLI's socket transport keeps the real github.com install command offline.
  writeFileSync(join(config, "config.yml"), `http_unix_socket: ${JSON.stringify(socket)}\n`);
  const origin = "https://api.github.com";
  let runtimeOnly = true;
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    const assets = platforms.map((platform, index) => ({
      name: `gh-cao-${platform}`, url: `${origin}/assets/${index}`, size: binary.length,
    }));
    const latest = { tag_name: "v1.2.3", draft: false, prerelease: false, assets: runtimeOnly
      ? [{ name: "cao-runtime-0123456789abcdef.tgz", url: `${origin}/runtime` }]
      : [...assets, { name: "checksums.txt", url: `${origin}/checksums` }] };
    let body;
    if (request.url === "/repos/githubnext/gh-cao/releases/latest") {
      body = latest;
    } else if (request.url === "/repos/githubnext/gh-cao/releases/tags/v1.2.4") {
      body = { tag_name: "v1.2.4", draft: false, prerelease: true, assets };
    } else if (/^\/assets\/[0-5]$/.test(request.url)) {
      const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "x64" ? "amd64" : process.arch}${process.platform === "win32" ? ".exe" : ""}`;
      if (request.url !== `/assets/${platforms.indexOf(platform)}`) {
        response.writeHead(400).end("Wrong platform asset selected");
        return;
      }
      response.writeHead(200, { "Content-Type": "application/octet-stream" }).end(binary);
      return;
    } else {
      response.writeHead(404, { "Content-Type": "application/json" }).end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  server.listen(socket);
  await once(server, "listening");
  const baseEnv = { ...process.env };
  for (const name of [
    "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
    "GH_DEBUG", "GH_CONFIG_DIR", "GH_HOST", "GH_PATH", "GH_EXTENSION",
  ]) delete baseEnv[name];
  Object.assign(baseEnv, {
    GH_CONFIG_DIR: config, GH_HOST: "github.com",
    GH_TOKEN: "local-fixture-token", GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1", GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
  });
  const repository = "githubnext/gh-cao";
  for (const scenario of [
    { name: "runtime-only latest", runtimeOnly: true, pinned: false },
    { name: "prerelease pin cannot bypass runtime-only latest", runtimeOnly: true, pinned: true },
    { name: "complete latest", runtimeOnly: false, pinned: false },
    { name: "prerelease pin after binary discovery", runtimeOnly: false, pinned: true },
  ]) {
    await t.test(scenario.name, async () => {
      runtimeOnly = scenario.runtimeOnly;
      requests.length = 0;
      const data = join(directory, scenario.name);
      const env = {
        ...baseEnv, XDG_DATA_HOME: data, XDG_STATE_HOME: join(data, "state"),
        XDG_CACHE_HOME: join(data, "cache"), LOCALAPPDATA: data,
      };
      const args = ["extension", "install", repository];
      if (scenario.pinned) args.push("--pin", "v1.2.4");
      const result = await run(args, env);
      assert.ok(requests.includes("/repos/githubnext/gh-cao/releases/latest"), result.stderr);
      if (scenario.runtimeOnly) {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /extension is not installable: no usable release artifact or script found/);
        assert.ok(requests.includes("/repos/githubnext/gh-cao/contents/gh-cao"));
        assert.ok(!requests.some((path) => path.includes("/releases/tags/") || path.startsWith("/assets/")));
        return;
      }
      assert.equal(result.status, 0, result.stderr);
      assert.equal(requests.filter((path) => path.startsWith("/assets/")).length, 1);
      assert.equal(requests.includes("/repos/githubnext/gh-cao/releases/tags/v1.2.4"), scenario.pinned);
      const installed = await run(["cao", "--version"], env);
      assert.equal(installed.status, 0, installed.stderr);
      assert.equal(installed.stdout.trim(), `gh cao version ${version}`);
      const help = await run(["cao", "--help"], env);
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /Usage:/);
      const manifest = join(data, "gh", "extensions", "gh-cao", "manifest.yml");
      assert.match(readFileSync(manifest, "utf8"), new RegExp(`tag: ${scenario.pinned ? "v1.2.4" : "v1.2.3"}`));
    });
  }
});
