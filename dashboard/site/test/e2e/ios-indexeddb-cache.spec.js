import { expect, test } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizedRunShard } from './normalized-shard.js';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const origin = 'http://ios-cache.dashboard.test';
const firstIdentity = 'a'.repeat(64);
const secondIdentity = 'b'.repeat(64);

/** @param {number} runId */
function shard(runId) {
  return normalizedRunShard(`${JSON.stringify({
    schema_version: 2,
    kind: 'run',
    run: {
      run_id: runId,
      run_attempt: 1,
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow_name: 'Dashboard',
      workflow_path: '.github/workflows/dashboard.md',
      status: 'completed',
      conclusion: 'success',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  })}\n`);
}

test('iPhone WebKit retains canonical data through ingest, reload, and another ingest', async ({ context, page }) => {
  await context.route(`${origin}/**`, async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') {
      await route.fulfill({ contentType: 'text/html', body: '<main>IndexedDB cache test</main>' });
      return;
    }
    const filePath = join(siteRoot, pathname);
    if (existsSync(filePath)) {
      await route.fulfill({
        contentType: pathname.endsWith('.json') ? 'application/json' : 'application/javascript',
        body: readFileSync(filePath)
      });
      return;
    }
    await route.fulfill({ status: 404, body: 'Not found' });
  });

  await page.goto(`${origin}/`);
  const firstShard = shard(1001);
  const secondShard = shard(1002);
  const moduleUrl = `${origin}/src/data/ingest/coordinator.js`;
  const storageUrl = `${origin}/src/data/storage/indexeddb.js`;
  /** @param {string} content @param {string} payloadIdentity */
  const ingest = async (content, payloadIdentity) => page.evaluate(async ({ content, payloadIdentity, moduleUrl }) => {
    const { ingestNormalizedJsonl } = await import(moduleUrl);
    async function* chunks() { yield content; }
    return ingestNormalizedJsonl(indexedDB, chunks(), {
      payloadIdentity,
      payloadScope: `test:${payloadIdentity}`,
      expectedPhase: 'runs',
      storage: navigator.storage
    });
  }, { content, payloadIdentity, moduleUrl });
  const stored = async () => page.evaluate(async (url) => {
    const { readCollection, readTransactions } = await import(url);
    const [runs, receipts] = await Promise.all([
      readCollection(indexedDB, 'runs'),
      readTransactions(indexedDB)
    ]);
    return {
      runIds: runs.map((/** @type {{ id: string }} */ run) => run.id).sort(),
      receiptHashes: receipts.filter((/** @type {{ kind: string }} */ receipt) => receipt.kind === 'ingest-normalized-jsonl')
        .map((/** @type {{ payloadHash: string }} */ receipt) => receipt.payloadHash).sort()
    };
  }, storageUrl);

  expect(await ingest(firstShard, firstIdentity)).toMatchObject({ updated: true });
  const firstState = await stored();
  expect(firstState.runIds).toEqual(['github:run:githubnext/gh-aw-cao:1001']);
  expect(firstState.receiptHashes).toEqual([firstIdentity]);

  await page.reload();
  expect(await stored()).toEqual(firstState);
  expect(await ingest(firstShard, firstIdentity)).toMatchObject({ updated: false, skipped: true });
  expect(await ingest(secondShard, secondIdentity)).toMatchObject({ updated: true });
  expect(await stored()).toEqual({
    runIds: [
      'github:run:githubnext/gh-aw-cao:1001',
      'github:run:githubnext/gh-aw-cao:1002'
    ],
    receiptHashes: [firstIdentity, secondIdentity]
  });

  await page.reload();
  expect((await stored()).runIds).toHaveLength(2);
});
