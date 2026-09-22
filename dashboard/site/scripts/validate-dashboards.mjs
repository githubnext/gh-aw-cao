import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { parse } from 'yaml';
import { renderDashboardQueryUsageGraph } from '../src/query-usage.js';
import { validateDashboardDocument } from '../src/validator.js';

const repositoryRoot = resolve(process.cwd(), '../..');
const ignoredDirectories = new Set(['.cao', '.git', 'coverage', 'dist', 'node_modules', 'test-results']);

async function findDashboardDocuments(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const documents = [];

  for (const entry of entries) {
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

const dashboardPaths = (await findDashboardDocuments(repositoryRoot)).sort();
const renderQueryGraphs = process.argv.includes('--render-query-graphs');
let invalidCount = 0;

for (const dashboardPath of dashboardPaths) {
  const source = await readFile(dashboardPath, 'utf8');
  const result = validateDashboardDocument(source);
  const displayPath = relative(repositoryRoot, dashboardPath);
  const hasDeadQueries = !result.ok && result.errors.some((error) => error.code === 'DLS-E015');
  if (renderQueryGraphs || hasDeadQueries) {
    try {
      const dashboard = parse(source)?.dashboard;
      if (dashboard && typeof dashboard === 'object' && !Array.isArray(dashboard)) {
        console.error(`Query usage graph for ${displayPath}:`);
        console.error(renderDashboardQueryUsageGraph(dashboard));
      }
    } catch {
      // Validation below reports malformed input without aborting analysis of other documents.
    }
  }
  if (result.ok) continue;

  invalidCount += 1;
  for (const error of result.errors) {
    console.error(`${displayPath}:${error.path}: ${error.code} ${error.message}`);
  }
}

if (invalidCount > 0) {
  console.error(`${invalidCount} dashboard.json file(s) failed validation.`);
  process.exitCode = 1;
} else {
  console.log(`Validated ${dashboardPaths.length} dashboard.json file(s).`);
}
