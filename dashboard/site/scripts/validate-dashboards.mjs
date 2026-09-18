import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { validateDashboardDocument } from '../src/validator.js';

const repositoryRoot = resolve(process.cwd(), '../..');
const ignoredDirectories = new Set(['.cao', '.git', 'coverage', 'dist', 'node_modules', 'test-results']);

async function findDashboardDocuments(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const documents = [];

  for (const entry of entries) {
    if (entry.isDirectory() && !ignoredDirectories.has(entry.name) && !entry.name.startsWith('.cao-')) {
      documents.push(...await findDashboardDocuments(resolve(directory, entry.name)));
    } else if (entry.isFile() && entry.name === 'dashboard.json') {
      documents.push(resolve(directory, entry.name));
    }
  }

  return documents;
}

const dashboardPaths = (await findDashboardDocuments(repositoryRoot)).sort();
let invalidCount = 0;

for (const dashboardPath of dashboardPaths) {
  const result = validateDashboardDocument(await readFile(dashboardPath, 'utf8'));
  if (result.ok) continue;

  invalidCount += 1;
  const displayPath = relative(repositoryRoot, dashboardPath);
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
