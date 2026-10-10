// @ts-check

import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateQueryEditorDocument } from "./site/src/data/query-editor.js";
import { validateDashboardDocument } from "./site/src/validator.js";

export const localCustomViewsDirectory = ".cao/dashboard/custom-views";
const maximumCustomViews = 50;
/** @typedef {{ 'language-version': string, dashboard: import('./site/src/presenter.js').PresentableDashboard }} CustomViewDocument */

export class InvalidCustomViewDocumentError extends Error {}

/** @param {string} workspace @param {boolean} create */
async function customViewsDirectory(workspace, create) {
  let directory = workspace;
  for (const segment of localCustomViewsDirectory.split("/")) {
    directory = join(directory, segment);
    if (create) await mkdir(directory, { recursive: false }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const metadata = await lstat(directory).catch((error) => {
      if (!create && error.code === "ENOENT") return null;
      throw error;
    });
    if (!metadata) return null;
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Local custom view storage must use workspace-owned directories, not symlinks.");
    }
  }
  return directory;
}

/** @param {string} content */
function validatedDocument(content) {
  const result = validateQueryEditorDocument(content);
  if (!result.ok) throw new InvalidCustomViewDocumentError(result.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  return { "language-version": result.document.languageVersion, dashboard: result.document.dashboard };
}

/** @param {string} workspace */
export async function loadLocalCustomViews(workspace) {
  const directory = await customViewsDirectory(workspace, false);
  if (!directory) return [];
  const names = (await readdir(directory)).filter((name) => /^local-[a-f0-9]{24}\.json$/.test(name)).sort();
  if (names.length > maximumCustomViews) throw new Error(`Local custom view storage supports at most ${maximumCustomViews} views.`);
  return Promise.all(names.map(async (name) => {
    const path = join(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 160 * 1024) {
      throw new Error(`Invalid local custom view file: ${name}.`);
    }
    let document;
    try {
      document = validatedDocument(await readFile(path, "utf8"));
    } catch (error) {
      if (!(error instanceof InvalidCustomViewDocumentError)) throw error;
      throw new Error(`Invalid local custom view file: ${name}.`, { cause: error });
    }
    return { id: name.slice(0, -5), path, document };
  }));
}

/** @param {string} workspace @param {string} content */
export async function saveLocalCustomView(workspace, content) {
  const document = validatedDocument(content);
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  validatedDocument(serialized);
  const id = `local-${createHash("sha256").update(serialized).digest("hex").slice(0, 24)}`;
  const materialized = validateDashboardDocument(JSON.stringify(materializeLocalCustomView(document, id)));
  if (!materialized.ok) throw new InvalidCustomViewDocumentError(materialized.errors.map((error) => `${error.path}: ${error.message}`).join("\n"));
  const existing = await loadLocalCustomViews(workspace);
  if (existing.some((view) => view.id === id)) return { id, path: `${localCustomViewsDirectory}/${id}.json` };
  if (existing.length >= maximumCustomViews) throw new Error(`Local custom view storage supports at most ${maximumCustomViews} views.`);
  const directory = await customViewsDirectory(workspace, true);
  if (!directory) throw new Error("Local custom view storage is unavailable.");
  const pending = join(directory, `.pending-${randomBytes(16).toString("hex")}`);
  try {
    await writeFile(pending, serialized, { flag: "wx", mode: 0o600 });
    await link(pending, join(directory, `${id}.json`)).catch(async (error) => {
      if (error.code !== "EEXIST" || await readFile(join(directory, `${id}.json`), "utf8") !== serialized) throw error;
    });
  } finally {
    await rm(pending, { force: true });
  }
  return { id, path: `${localCustomViewsDirectory}/${id}.json` };
}

/**
 * Isolates authored identifiers without rewriting labels, fields, or operands.
 * @param {CustomViewDocument} document
 * @param {string} id
 */
export function materializeLocalCustomView(document, id) {
  const queries = new Map((document.dashboard.queries ?? []).map((query) => [String(query.name), `${id}-${query.name}`]));
  const templates = new Map((document.dashboard["card-templates"] ?? []).map((card) => [card.id, `${id}-${card.id}`]));
  const units = new Map(Object.keys(document.dashboard.units ?? {}).map((unit) => [unit, `${id}-${unit}`]));
  const page = document.dashboard.pages[0];
  if (page.kind !== "custom") throw new Error("Local custom views require a custom page.");
  const views = new Map(page.views.flatMap((view) => {
    if (!view || typeof view !== "object" || !("id" in view) || typeof view.id !== "string") return [];
    return [[view.id, `${id}-${view.id}`]];
  }));
  /** @param {unknown} value @param {string} [key] @returns {unknown} */
  const references = (value, key) => {
    if (typeof value === "string") {
      if (["from", "source", "sources", "union", "partial-source", "context-source", "summary-source"].includes(key ?? "")) return queries.get(value) ?? value;
      if (key === "card") return templates.get(value) ?? value;
      if (key === "unit") return units.get(value) ?? value;
      if (key === "views") return views.get(value) ?? value;
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => references(item, key));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, references(item, name)]));
  };
  const result = /** @type {CustomViewDocument} */ (references(document));
  result.dashboard.id = id;
  result.dashboard.pages[0].id = id;
  for (const query of result.dashboard.queries ?? []) query.name = queries.get(String(query.name));
  for (const card of result.dashboard["card-templates"] ?? []) card.id = templates.get(card.id) ?? card.id;
  if (result.dashboard.units) {
    result.dashboard.units = Object.fromEntries(Object.entries(result.dashboard.units).map(([unit, definition]) => [units.get(unit) ?? unit, definition]));
  }
  const customPage = result.dashboard.pages[0];
  if (customPage.kind !== "custom") throw new Error("Local custom views require a custom page.");
  for (const view of customPage.views) {
    if (!view || typeof view !== "object") continue;
    if ("id" in view && typeof view.id === "string") view.id = views.get(view.id);
    if ("data" in view && view.data && typeof view.data === "object") {
      view.data = { ...result.dashboard.defaults, ...view.data };
    }
  }
  result.dashboard.navigation = [{ label: "Custom views", pages: [id] }];
  return result;
}
