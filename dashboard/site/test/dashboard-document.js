import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function loadDashboardDocument(path = resolve(process.cwd(), 'dashboard.json')) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  for (const page of document.dashboard.pages) {
    const owner = page.kind === 'built-in' ? page.definition : page;
    owner.views = owner.views.map((/** @type {any} */ view) => (
      typeof view?.$ref === 'string'
        ? JSON.parse(readFileSync(resolve(dirname(path), view.$ref), 'utf8'))
        : view
    ));
  }
  return document;
}
