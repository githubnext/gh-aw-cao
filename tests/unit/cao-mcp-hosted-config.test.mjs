import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('hosted MCP loads the same named queries advertised by its agent catalog', () => {
  const dockerfile = readFileSync(new URL('../../server/Dockerfile', import.meta.url), 'utf8');
  const compose = readFileSync(new URL('../../server/coolify/compose.yml', import.meta.url), 'utf8');
  const queries = JSON.parse(readFileSync(new URL('../../dashboard/site/src/agent/queries.generated.json', import.meta.url), 'utf8'));

  assert.match(dockerfile, /COPY .*queries\.generated\.json \/app\/agent\/queries\.json/);
  assert.match(dockerfile, /"--dashboard-queries", "\/app\/agent\/queries\.json"/);
  assert.match(compose, /- --dashboard-queries\s+- \/app\/agent\/queries\.json/);
  assert.ok(queries.some(({ name }) => name === 'database-campaign-count'));
  assert.ok(queries.some(({ name }) => name === 'campaign-readme-orchestrators'));
});
