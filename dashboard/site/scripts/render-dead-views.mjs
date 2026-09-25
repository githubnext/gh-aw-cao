import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
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
export function deadElementRendererNames(renderers, references) {
  const referenced = new Set(references);
  return renderers.filter((name) => !referenced.has(name));
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

  for (const dashboardPath of dashboardPaths) {
    const document = JSON.parse(await readFile(dashboardPath, 'utf8'));
    for (const name of referencedElementNames(document)) references.add(name);
  }

  const dead = deadElementRendererNames(renderers, references);
  console.log(`Dead element views (${dead.length}):`);
  for (const name of dead) console.log(`- ${name}`);
  console.log(
    `Analyzed ${renderers.length} element renderers across ${dashboardPaths.length} dashboard.json file(s) from ${relative(repositoryRoot, rendererPath)}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
