import { writeFile } from 'node:fs/promises';

import { loadAgentDashboardDocument, readAgentCatalog } from '../activity/agent-catalog.mjs';

const output = new URL('../dashboard/site/src/agent/catalog.generated.json', import.meta.url);
const dashboardOutput = new URL('../dashboard/site/src/agent/dashboard.generated.json', import.meta.url);
const [catalog, dashboard] = await Promise.all([
  readAgentCatalog(),
  loadAgentDashboardDocument()
]);
await writeFile(output, `${JSON.stringify(catalog, null, 2)}\n`);
await writeFile(dashboardOutput, `${JSON.stringify(dashboard, null, 2)}\n`);
