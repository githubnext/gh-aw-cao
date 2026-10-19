import { appendFileSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * A fake external GitHub CLI; queueing, execution, HTTP, and queries remain Go.
 * @param {string} directory
 * @param {object} options
 * @param {boolean} [options.hold]
 * @param {boolean} [options.holdSearch]
 * @param {boolean} [options.crowded]
 * @param {string} [options.description]
 * @param {Array<{stream: string, data: string}>} [options.initialOutput]
 * @param {Array<{stream: string, data: string}>} [options.completionOutput]
 * @param {(command: string) => void} [options.onCommand]
 * @param {(request: {id: string, text: string}) => void} [options.onSearch]
 * @param {() => void} [options.onCanceled]
 */
export async function nativeCommandFixture(directory, {
  hold = true, holdSearch = false, crowded = false, description = "",
  initialOutput = [], completionOutput = [],
  onCommand = () => {}, onSearch = () => {}, onCanceled = () => {},
} = {}) {
  await mkdir(directory, { recursive: true });
  const events = join(directory, "events.jsonl");
  const control = join(directory, "control.jsonl");
  const released = join(directory, "released");
  const searchReleased = join(directory, "search-released");
  const ghExecutable = join(directory, "gh-fixture.cjs");
  await writeFile(events, "");
  await writeFile(control, "");
  await writeFile(ghExecutable, `#!/usr/bin/env node
const fs = require("node:fs");
const config = ${JSON.stringify({ events, control, released, searchReleased, hold, holdSearch, crowded, description, initialOutput, completionOutput })};
const args = process.argv.slice(2);
const record = (event) => fs.appendFileSync(config.events, JSON.stringify(event) + "\\n");
record({type:"invoke",args});
const output = (event) => process[event.stream].write(event.data);
const json = (value) => {process.stdout.write(JSON.stringify(value)); process.exit(0)};
const wait = () => new Promise(resolve => setTimeout(resolve, 20));
async function main() {
  if (args[0] === "auth") {
    if (args[1] === "token") process.stdout.write("fixture-token");
    return;
  }
  if (args[0] === "api") {
    const api = args.slice(1);
    if (api[0] === "--hostname") api.splice(0, 2);
    let offset = 0;
    while (api[offset]?.startsWith("-")) offset += 2;
    const path = (api[offset] || "").replace(/^\\//, "");
    if (path === "user") {
      if (api.includes("--jq")) process.stdout.write(api.at(-1) === ".id" ? "1" : "fixture");
      else json({login:"fixture",id:1});
      return;
    }
    if (path === "rate_limit") {
      const reset = Math.floor(Date.now()/1000)+3600;
      json({resources:Object.fromEntries(["core","graphql","search"].map(name=>[name,{limit:5000,remaining:5000,reset}]))});
    }
    if (path.endsWith("/releases/latest")) json({tag_name:"v0.92.0"});
    if (path.endsWith("/pages")) {
      if (api.includes("--jq")) {process.stdout.write("https://ops.example.com/central/");return;}
      json({html_url:"https://ops.example.com/central/"});
    }
    if (path.startsWith("repos/")) json({id:1,full_name:"acme/control",default_branch:"main"});
    throw new Error("Unexpected fixture API");
  }
  if (args[0] === "search" && args[1] === "repos") {
    record({type:"search",id:"add-repository",text:args.at(-1)});
    while (config.holdSearch && !fs.existsSync(config.searchReleased)) await wait();
    const selected = {fullName:"octo/example",description:config.description};
    json(config.crowded ? Array.from({length:20}, (_,i)=>i===19 ? selected : {
      fullName:"octo/repository-"+i,
      description:"Repository description that wraps across multiple lines on a narrow display."
    }) : [selected]);
  }
  if (args[0] === "aw" && (args.includes("--help") || args.includes("version") || args.includes("--version"))) {
    process.stdout.write("gh aw v0.92.0"); return;
  }
  if (!(args[0] === "aw" || args[0] === "workflow" && args[1] === "run")) throw new Error("Unexpected fixture command");
  let cursor = fs.readFileSync(config.control,"utf8").length;
  record({type:"command",args});
  process.on("SIGTERM",()=>{record({type:"canceled"});process.exit(0)});
  for (const event of config.initialOutput) output(event);
  while (config.hold && !fs.existsSync(config.released)) {
    const content = fs.readFileSync(config.control,"utf8");
    for (const line of content.slice(cursor).trim().split("\\n").filter(Boolean)) output(JSON.parse(line));
    cursor = content.length;
    await wait();
  }
  const remaining = fs.readFileSync(config.control,"utf8").slice(cursor);
  for (const line of remaining.trim().split("\\n").filter(Boolean)) output(JSON.parse(line));
  for (const event of config.completionOutput) output(event);
}
main().catch(error=>{process.stderr.write(error.message);process.exitCode=1});
`, { mode: 0o755 });
  const records = () => readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const quote = (/** @type {string} */ value) => /^[a-zA-Z0-9_/:=.,@%+-]+$/.test(value) ? value : JSON.stringify(value);
  let observed = 0;
  const observe = () => {
    const entries = records();
    for (const entry of entries.slice(observed)) {
      if (entry.type === "command") onCommand(["gh", ...entry.args].map(quote).join(" "));
      else if (entry.type === "search") onSearch({ id: entry.id, text: entry.text });
      else if (entry.type === "canceled") onCanceled();
    }
    observed = entries.length;
  };
  watchFile(events, { interval: 20, persistent: false }, observe);
  return {
    ghExecutable,
    get runs() { return records().filter((entry) => entry.type === "command").length; },
    get cancellations() { return records().filter((entry) => entry.type === "canceled").length; },
    get searches() { return records().filter((entry) => entry.type === "search").map(({ id, text }) => ({ id, text })); },
    get commands() { return records().filter((entry) => entry.type === "command").map(({ args }) => ["gh", ...args].map(quote).join(" ")); },
    get invocations() { return records().filter((entry) => entry.type === "invoke").map(({ args }) => args); },
    emitOutput: (/** @type {{stream: string, data: string}} */ event) => appendFileSync(control, `${JSON.stringify(event)}\n`),
    finish: () => writeFileSync(released, ""),
    finishSearch: () => writeFileSync(searchReleased, ""),
    close: () => unwatchFile(events, observe),
  };
}
