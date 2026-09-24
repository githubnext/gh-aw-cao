import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ignoredDirectories = new Set(['.cao', '.git', 'coverage', 'dist', 'node_modules', 'test-results']);

/** @param {string} source */
export function elementRendererNames(source) {
  const registry = source.match(/const ELEMENT_RENDERERS = new Map\(\[([\s\S]*?)\n\s*\]\);/)?.[1] ?? '';
  return [...registry.matchAll(/\[\s*['"]([^'"]+)['"]\s*,/g)].map((match) => match[1]);
}

/** @param {unknown} document */
export function referencedElementNames(document) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {unknown} value */
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = /** @type {Record<string, unknown>} */ (value);
    if (record.mark === 'element' && typeof record.element === 'string') names.add(record.element);
    for (const child of Object.values(record)) visit(child);
  };
  visit(document);
  return names;
}

/**
 * @param {string[]} renderers
 * @param {Iterable<string>} references
 */
export function deadViewNames(renderers, references) {
  const referenced = new Set(references);
  return renderers.filter((name) => !referenced.has(name));
}

/** @param {string[]} names */
export function renderDeadViews(names) {
  if (names.length === 0) return 'No dead dashboard views.';
  return [`Dead dashboard views (${names.length}):`, ...names.map((name) => `- ${name}`)].join('\n');
}

/** @param {string} directory @returns {Promise<string[]>} */
async function findDashboardDocuments(directory) {
  const documents = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory()
      && !ignoredDirectories.has(entry.name)
      && !entry.name.startsWith('.cao-')
      && !entry.name.startsWith('.lazy-page-chunks-')
    ) {
      documents.push(...await findDashboardDocuments(resolve(directory, entry.name)));
    } else if (entry.isFile() && entry.name === 'dashboard.json') {
      documents.push(resolve(directory, entry.name));
    }
  }
  return documents;
}

async function main() {
  const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const rendererPath = resolve(repositoryRoot, 'dashboard/site/src/components/ui-elements.js');
  const renderers = elementRendererNames(await readFile(rendererPath, 'utf8'));
  const references = new Set();
  const dashboardPaths = await findDashboardDocuments(repositoryRoot);

  for (const dashboardPath of dashboardPaths.sort()) {
    const document = JSON.parse(await readFile(dashboardPath, 'utf8'));
    for (const name of referencedElementNames(document)) references.add(name);
  }

  console.log(renderDeadViews(deadViewNames(renderers, references)));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
