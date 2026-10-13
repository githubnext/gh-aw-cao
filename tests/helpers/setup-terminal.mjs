import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runTerminal } from "./terminal.mjs";

export const setupModule = path.resolve(import.meta.dirname, "../../activity/setup.mjs");

export function setupTerminalFixture(t, module = setupModule, {
  publicPages = false, newPages = false, deletionFails = false, credentialsFail = false,
} = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "cao-setup-terminal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = { version: 1, "control-plane": { scope: {
    "allowed-owners": ["acme"], "allowed-repositories": ["acme/control"],
  }, campaigns: {} } };
  const policyPath = path.join(root, "cao.json");
  const callsPath = path.join(root, "calls.json");
  writeFileSync(policyPath, JSON.stringify(policy));
  const driver = path.join(root, "driver.mjs");
  writeFileSync(driver, `
import { setupCaoControlPlane } from ${JSON.stringify(pathToFileURL(module).href)};
import { writeFileSync } from "node:fs";
const calls = [];
const configuredSite = { build_type: "workflow", public: ${publicPages}, html_url: "https://acme.github.io/control" };
let site = ${newPages} ? undefined : configuredSite;
try {
  const result = await setupCaoControlPlane({
    policyPath: ${JSON.stringify(policyPath)},
    execute(command, args) {
      calls.push(args);
      if (args.join(" ") === "auth status") return { status: 0 };
      if (args.join(" ") === "repo view --json nameWithOwner --jq .nameWithOwner") {
        return { status: 0, stdout: "acme/control" };
      }
      if (args[0] === "repo" && args[1] === "view") {
        return { status: 0, stdout: JSON.stringify({ nameWithOwner: args[2], visibility: "PRIVATE" }) };
      }
      if (args[0] === "api" && args.at(-1) === "repos/acme/control/pages") {
        if (args.includes("POST")) site = configuredSite;
        if (args.includes("DELETE")) {
          if (${deletionFails}) return { status: 1, stderr: "deletion denied" };
          site = undefined;
          return { status: 0 };
        }
        return site ? { status: 0, stdout: JSON.stringify(site) }
          : { status: 1, stderr: "gh: Not Found (HTTP 404)" };
      }
      throw new Error("Unexpected command: " + args.join(" "));
    },
    setupAuthentication(profile) {
      calls.push(["connect", profile]);
      if (${credentialsFail}) throw new Error("Credential connection failed");
      return { command: "setup-auth", profile };
    },
  });
  console.log("RESULT " + JSON.stringify(result));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { writeFileSync(${JSON.stringify(callsPath)}, JSON.stringify(calls)); }
`);
  return {
    root, driver, policyPath, policy,
    calls: () => JSON.parse(readFileSync(callsPath, "utf8")),
    saved: () => JSON.parse(readFileSync(policyPath, "utf8")),
  };
}

export function walkSetupTerminal(f, steps, term = "xterm-256color", environment = {}) {
  let step = 0;
  return runTerminal(process.execPath, [f.driver], {
    cwd: f.root, env: { ...process.env, TERM: term, FORCE_COLOR: "0", CI: "", ...environment },
    onOutput(output, write) {
      const next = steps[step];
      if (next && output.includes(next[0])) {
        step += 1;
        write(next[1]);
      }
    },
  });
}
