import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
export const nativeExecutable = process.env.CAO_EXECUTABLE || join(repositoryRoot, ".tmp", "gh-cao");

/**
 * Produce test artifacts through Actions ingestion, never query-source callbacks.
 * @param {(destination: string) => Promise<void>} publish
 */
export function publishNativeFixture(publish) {
  return async (/** @type {string} */ destination) => {
    await publish(destination);
    /** @type {{createDatabase: (path: string) => Promise<IDBFactory>, ingestNormalizedShardDirectories: (database: IDBFactory, phases: Array<[string, string]>) => Promise<void>}} */
    const { createDatabase, ingestNormalizedShardDirectories } = await import(new URL("../../activity/cli/ingestion.mjs", import.meta.url).href);
    const { ingestDashboardSources } = await import("../../dashboard/site/src/data/ingest/coordinator.js");
    const indexedDB = await createDatabase(join(destination, "gh-aw-logs.sqlite"));
    await ingestDashboardSources(indexedDB, JSON.parse(await readFile(join(destination, "inventory-sources.json"), "utf8")));
    /** @type {Array<[string, string]>} */
    const phases = [];
    for (const phase of ["runs", "records"]) {
      const directory = join(destination, `gh-aw-logs-${phase}`);
      await mkdir(directory, { recursive: true });
      phases.push([phase, directory]);
    }
    await ingestNormalizedShardDirectories(indexedDB, phases);
    /** @type {Record<string, string>} */
    const hashes = {};
    /** @param {string} directory */
    async function hashFiles(directory, prefix = "") {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const name = `${prefix}${entry.name}`;
        if (entry.isDirectory()) await hashFiles(join(directory, entry.name), `${name}/`);
        else if (entry.isFile() && !name.endsWith("-wal") && !name.endsWith("-shm") && name !== "payload-hashes.json") {
          hashes[name] = createHash("sha256").update(await readFile(join(directory, entry.name))).digest("hex");
        }
      }
    }
    await hashFiles(destination);
    await writeFile(join(destination, "payload-hashes.json"), JSON.stringify(hashes));
  };
}

/**
 * Explicit canonical records, not presenter sources or JavaScript query results.
 * @param {Record<string, Array<Record<string, unknown> & {id: string | number}>>} collections
 */
export async function nativeDashboardFixture(collections = {
  repositories: [{ id: "acme/control", owner: "acme", name: "control" }],
}) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), "cao-native-dashboard-")));
  const data = join(workspace, "data");
  await mkdir(data);
  const database = new DatabaseSync(join(data, "gh-aw-logs.sqlite"));
  try {
    database.exec("CREATE TABLE __idb_records (database_name TEXT NOT NULL, store_name TEXT NOT NULL, record_key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(database_name,store_name,record_key))");
    const insert = database.prepare("INSERT INTO __idb_records VALUES (?,?,?,?)");
    for (const [collection, records] of Object.entries(collections)) {
      for (const record of records) {
        if (record.id === undefined) throw new Error("Canonical fixture records require explicit identities.");
        insert.run("gh-aw-cao-dashboard-data", collection, JSON.stringify(record.id), JSON.stringify(record));
      }
    }
  } finally {
    database.close();
  }
  const hash = createHash("sha256").update(await readFile(join(data, "gh-aw-logs.sqlite"))).digest("hex");
  await writeFile(join(data, "inventory-sources.json"), '{"schemaVersion":1}');
  await writeFile(join(data, "payload-hashes.json"), JSON.stringify({ "gh-aw-logs.sqlite": hash }));
  return { workspace, data, close: () => rm(workspace, { recursive: true, force: true }) };
}

/**
 * @typedef {object} NativeDashboardOptions
 * @property {string} workspace
 * @property {string} data
 * @property {boolean} [canvas]
 * @property {boolean} [admin]
 * @property {string} [site]
 * @property {string} [catalog]
 * @property {string} [dashboard]
 * @property {string} [ghExecutable]
 * @property {string} [dataBackend]
 * @property {string} [caoUrl]
 * @property {(action: {command: string}) => Promise<boolean>} [approve]
 */

/**
 * Launch production Go preparation, services, queries and HTTP.
 * @param {NativeDashboardOptions} options
 */
export async function startNativeDashboard({
  workspace, data, canvas = false, admin = false, site, catalog, dashboard, ghExecutable,
  dataBackend = "sqlite", caoUrl,
  approve = async () => false,
}) {
  const child = spawn(nativeExecutable, [
    "dashboard", "serve", "--workspace", workspace, "--data", data,
    "--data-backend", dataBackend,
    "--repo", "acme/control", "--port", "0", "--control-stdio",
    ...(canvas ? ["--canvas"] : []), ...(admin ? ["--admin"] : []),
    ...(site ? ["--site", site] : []), ...(catalog ? ["--catalog", catalog] : []),
    ...(dashboard ? ["--dashboard", dashboard] : []),
    ...(ghExecutable ? ["--gh-executable", ghExecutable] : []),
    ...(caoUrl ? ["--cao-url", caoUrl] : []),
  ], { cwd: workspace, stdio: ["pipe", "pipe", "pipe"] });
  let diagnostic = "";
  const lines = createInterface({ input: child.stdout });
  child.stderr.on("data", (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-4096); });
  child.stdin.on("error", () => {});
  /** @type {Promise<{code: number | null, signal: NodeJS.Signals | null}>} */
  const exited = new Promise((resolve) => child.once("close", (code, signal) => {
    lines.close();
    resolve({ code, signal });
  }));
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeout;
  /** @type {Promise<string>} */
  const ready = new Promise((resolve, reject) => {
    lines.on("line", (line) => {
      let message;
      try { message = JSON.parse(line); }
      catch (error) { reject(error); child.kill("SIGTERM"); return; }
      if (message.event === "ready") resolve(message.url);
      else if (message.id && message.operation === "approve") {
        void Promise.resolve().then(() => approve(message.payload)).then(
          (approved) => child.stdin.write(`${JSON.stringify({ id: message.id, result: approved === true })}\n`),
          () => child.stdin.write(`${JSON.stringify({ id: message.id, result: false })}\n`),
        );
      }
    });
    child.once("error", reject);
    child.once("close", (code, signal) => reject(new Error(diagnostic || `Native dashboard exited (${signal ?? code}).`)));
    timeout = setTimeout(() => {
      reject(new Error("Native dashboard did not become ready."));
      child.kill("SIGTERM");
    }, 120_000);
  });
  /** @type {Promise<void> | undefined} */
  let closing;
  const close = () => closing ??= (async () => {
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 7500);
    const result = await exited;
    clearTimeout(timeout);
    if (result.code !== 0 && result.code !== 143 && result.signal !== "SIGTERM") throw new Error(diagnostic || `Native dashboard shutdown failed (${result.signal ?? result.code}).`);
  })();
  try {
    return { url: await ready, close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @typedef {object} DashboardServerOptions
 * @property {string} [workingDirectory]
 * @property {string} [repository]
 * @property {string | null} [siteRoot]
 * @property {string | null} [catalogRoot]
 * @property {number} [port]
 * @property {boolean} [canvas]
 * @property {boolean} [admin]
 * @property {string} [dataBackend]
 * @property {string} [caoUrl]
 * @property {string} [ghExecutable]
 * @property {(destination: string) => Promise<void>} [downloadData]
 * @property {Record<string, string>} [fixtureActions]
 * @property {Awaited<ReturnType<typeof import("./native-command-fixture.mjs").nativeCommandFixture>>} [commandFixture]
 * @property {(action: {command: string}) => Promise<boolean>} [approveCliAction]
 * @property {(...args: unknown[]) => void} [output]
 * @property {(...args: unknown[]) => void} [requestOutput]
 * @property {(...args: unknown[]) => void} [traceOutput]
 */

/**
 * Fixture acquisition is test-owned; serving and queries always use production Go.
 * @param {DashboardServerOptions} options
 */
export async function startDashboardServer(options = {}) {
  for (const key of ["executeCliAction", "generateQuery", "enhanceIntent", "enhanceQueryIntent", "lookupSelector", "cliQueueAdmission"]) {
    if (Object.hasOwn(options, key)) throw new Error(`${key} must be tested through a native service or external-command fixture.`);
  }
  const sourceWorkspace = await realpath(options.workingDirectory || repositoryRoot);
  const repositoryWorkspace = sourceWorkspace === await realpath(repositoryRoot);
  const scratch = repositoryWorkspace ? join(sourceWorkspace, ".tmp") : sourceWorkspace;
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "cao-native-test-"));
  const workspace = repositoryWorkspace ? directory : sourceWorkspace;
  const data = join(directory, "data");
  await mkdir(data);
  /** @type {Awaited<ReturnType<typeof startNativeDashboard>> | undefined} */
  let preview;
  try {
    if (typeof options.downloadData !== "function") throw new Error("A verified native test artifact is required.");
    await options.downloadData(data);
    let dashboard;
    if (options.fixtureActions) {
      const document = JSON.parse(await readFile(join(repositoryRoot, "dashboard/site/dashboard.json"), "utf8"));
      for (const action of document.dashboard["cli-actions"]) {
        if (Object.hasOwn(options.fixtureActions, action.id)) action.command = options.fixtureActions[action.id];
      }
      dashboard = join(workspace, "fixture-dashboard.json");
      await writeFile(dashboard, JSON.stringify(document));
      await cp(join(repositoryRoot, "dashboard/site/dashboard-fragments"), join(workspace, "dashboard-fragments"), { recursive: true });
    }
    preview = await startNativeDashboard({
      workspace, data, dataBackend: options.dataBackend,
      canvas: options.canvas, admin: options.admin, site: options.siteRoot || undefined,
      catalog: options.catalogRoot || undefined, ghExecutable: options.commandFixture?.ghExecutable || options.ghExecutable,
      caoUrl: options.caoUrl,
      dashboard,
      approve: options.approveCliAction,
    });
    const running = preview;
    /** @type {Promise<void> | undefined} */
    let closing;
    return { url: preview.url, close: () => closing ??= (async () => {
      try { await running.close(); } finally {
        options.commandFixture?.close();
        await rm(directory, { recursive: true, force: true });
      }
    })() };
  } catch (error) {
    try { await preview?.close(); } finally {
      options.commandFixture?.close();
      await rm(directory, { recursive: true, force: true });
    }
    throw error;
  }
}
