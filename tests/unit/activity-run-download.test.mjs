import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parse } from 'yaml';

const executeFile = promisify(execFile);
const cao = path.resolve('activity/cao.mjs');

test('cao download-runs downloads its assigned shard and records API cost', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cao-run-download-'));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url,
      authorization: request.headers.authorization || '',
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (request.url?.includes('/actions/workflows/cao-activity.yml/runs')) {
      response.writeHead(200, {
        'content-type': 'application/json',
        'x-ratelimit-limit': '15000',
        'x-ratelimit-remaining': '14999',
      });
      response.end(JSON.stringify({
        workflow_runs: [
          { id: 101, run_number: 11, conclusion: 'success' },
          { id: 102, run_number: 12, conclusion: 'success' },
        ],
      }));
    } else if (request.url === '/repos/acme/control/actions/runs/102/artifacts?per_page=100') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        artifacts: [{ id: 202, name: 'cao-activity-index', expired: false }],
      }));
    } else if (request.url === '/repos/acme/control/actions/artifacts/202/zip') {
      response.writeHead(302, { location: `${origin}/storage/artifact` });
      response.end();
    } else if (request.url === '/repos/acme/control/actions/runs/102/logs') {
      response.writeHead(302, { location: `${origin}/storage/logs` });
      response.end();
    } else if (request.url === '/storage/artifact') {
      response.writeHead(200, { 'content-length': '8' });
      response.end('artifact');
    } else if (request.url === '/storage/logs') {
      response.writeHead(200, { 'content-length': '4' });
      response.end('logs');
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const output = path.join(root, 'output');
    const { stdout } = await executeFile(cao, [
      'download-runs',
      '--repo', 'acme/control',
      '--runs', '2',
      '--shard-count', '2',
      '--shard-index', '1',
      '--before', '2026-09-14T22:45:00Z',
      '--output', output,
    ], {
      env: {
        ...process.env,
        GH_TOKEN: 'test-token',
        GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      },
    });
    const result = JSON.parse(stdout);
    const manifest = JSON.parse(await readFile(
      path.join(output, 'download-manifest-1-of-2.json'),
      'utf8',
    ));

    assert.deepEqual(result, {
      downloadedRuns: 1,
      primaryUnits: 4,
      output,
    });
    assert.equal(await readFile(path.join(output, 'shard-1-of-2', '102', 'cao-activity-index.zip'), 'utf8'), 'artifact');
    assert.equal(await readFile(path.join(output, 'shard-1-of-2', '102', 'job-logs.zip'), 'utf8'), 'logs');
    assert.deepEqual(manifest.downloaded, [{
      id: 102,
      runNumber: 12,
      artifactId: 202,
      artifactBytes: 8,
      logBytes: 4,
    }]);
    assert.equal(manifest.before, '2026-09-14T22:45:00Z');
    assert.match(requests[0].url, /created=%3C%3D2026-09-14T22%3A45%3A00\.000Z/);
    const expectedAuthorization = ['Bearer', 'test-token'].join(' ');
    assert.ok(requests.filter(({ url }) => !url.startsWith('/storage/')).every(({ authorization }) => (
      authorization === expectedAuthorization
    )));
    assert.ok(requests.filter(({ url }) => url.startsWith('/storage/')).every(({ authorization }) => (
      authorization === ''
    )));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('the Activity package installs shared run-download infrastructure', async () => {
  const manifest = parse(await readFile('activity/aw.yml', 'utf8'));
  assert.ok(manifest.resources.some((resource) => (
    resource.source === 'run-download.mjs' &&
    resource.destination === '.github/aw/activity/run-download.mjs'
  )));
});
