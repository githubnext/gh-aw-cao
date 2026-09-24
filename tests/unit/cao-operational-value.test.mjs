import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..', '..');
const cao = path.join(root, 'activity', 'cao.mjs');

test('cao operational-value runs package scripts and ingests emitted JSONL', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-value-'));
  const packageDirectory = path.join(temporary, 'example');
  const output = path.join(temporary, 'values.jsonl');
  const database = path.join(temporary, 'dashboard.sqlite');
  mkdirSync(packageDirectory);
  const script = path.join(packageDirectory, 'operational-value.mjs');
  writeFileSync(script, `import { readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
for (const repository of request.repositories) {
  console.log(JSON.stringify({timestamp:request.timestamp,repository,valueId:"example-count",value:2}));
}\n`);
  chmodSync(script, 0o755);

  const result = JSON.parse(execFileSync(process.execPath, [
    cao,
    'operational-value',
    '--database', database,
    '--root', temporary,
    '--output', output,
    '--timestamp', '2026-09-24T10:00:00Z',
    '--repository', 'githubnext/gh-aw-cao',
    '--repository', 'github/gh-aw',
  ], { encoding: 'utf8' }));

  assert.deepEqual(result.scripts, ['example']);
  assert.equal(result.values.length, 2);
  const envelopes = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(envelopes.map((entry) => entry.kind), ['operational_value', 'operational_value']);

  execFileSync(process.execPath, [cao, 'ingest-jsonl', '--database', database, '--input', output]);
  const stored = JSON.parse(execFileSync(process.execPath, [
    cao, 'query', '--database', database, '--collection', 'operationalValues'
  ], { encoding: 'utf8' }));
  assert.deepEqual(stored.map(({ repository, valueId, value }) => ({ repository, valueId, value })), [
    { repository: 'github/gh-aw', valueId: 'example-count', value: 2 },
    { repository: 'githubnext/gh-aw-cao', valueId: 'example-count', value: 2 },
  ]);
});

test('Dependabot operational value counts open vulnerability alerts', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-dependabot-value-'));
  const fakeGh = path.join(temporary, 'gh');
  const calls = path.join(temporary, 'calls.log');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
if [[ " $* " =~ (^|[[:space:]?&])page= ]]; then
  echo 'page parameter is not supported' >&2
  exit 1
fi
if [[ " $* " == *" rate_limit "* ]]; then
  printf '5000\\n'
elif [[ " $* " == *"after=cursor"* ]]; then
  printf 'HTTP/2 200\\n\\n[{"number":3}]\\n'
else
  if [[ " $* " != *" repos/githubnext/gh-aw-cao/dependabot/alerts "* ]] || [[ " $* " != *" state=open "* ]] || [[ " $* " != *" per_page=100 "* ]]; then
    echo "unexpected gh api arguments: $*" >&2
    exit 1
  fi
  printf 'HTTP/1.1 100 Continue\\n\\nHTTP/2 200\\nlink: <https://api.github.com/repos/githubnext/gh-aw-cao/dependabot/alerts?state=open&per_page=100&after=cursor>; rel="next"; type="application/json"\\n\\n[\\n{"number":1},\\n\\n{"number":2}\\n]\\n'
fi\n`);
  chmodSync(fakeGh, 0o755);
  const request = JSON.stringify({
    schemaVersion: 1,
    timestamp: '2026-09-24T10:00:00.000Z',
    repositories: ['githubnext/gh-aw-cao']
  });

  const result = JSON.parse(execFileSync(
    process.execPath,
    [path.join(root, 'dependabot', 'operational-value.mjs')],
    { encoding: 'utf8', input: request, env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`,
      CAO_GITHUB_API_MIN_REMAINING: '2000'
    } }
  ));

  assert.deepEqual(result, {
    timestamp: '2026-09-24T10:00:00.000Z',
    repository: 'githubnext/gh-aw-cao',
    valueId: 'dependabot-vulnerability-alerts',
    value: 3
  });
  const ghCalls = readFileSync(calls, 'utf8');
  assert.doesNotMatch(ghCalls, /(^|[\s?&])page=/);
  assert.match(ghCalls, /after=cursor/);
});

test('Dependabot operational value rejects non-success alert responses', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-dependabot-value-status-'));
  const fakeGh = path.join(temporary, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" rate_limit "* ]]; then
  printf '5000\\n'
else
  printf 'HTTP/2 403 Forbidden\\n\\n{"message":"Dependabot alerts are disabled"}\\n'
fi\n`);
  chmodSync(fakeGh, 0o755);
  const request = JSON.stringify({
    schemaVersion: 1,
    timestamp: '2026-09-24T10:00:00.000Z',
    repositories: ['githubnext/gh-aw-cao']
  });

  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(root, 'dependabot', 'operational-value.mjs')],
    { encoding: 'utf8', input: request, env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`,
      CAO_GITHUB_API_MIN_REMAINING: '2000'
    }, stdio: 'pipe' }
  ), /GitHub API returned HTTP 403 Forbidden for githubnext\/gh-aw-cao Dependabot alerts/);
});

test('Dependabot operational value rejects repeated pagination links', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-dependabot-value-loop-'));
  const fakeGh = path.join(temporary, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" rate_limit "* ]]; then
  printf '5000\\n'
else
  printf 'HTTP/2 200\\nlink: <https://api.github.com/repos/githubnext/gh-aw-cao/dependabot/alerts?state=open&per_page=100&after=same>; rel="next"; type="application/json"\\n\\n[]\\n'
fi\n`);
  chmodSync(fakeGh, 0o755);
  const request = JSON.stringify({
    schemaVersion: 1,
    timestamp: '2026-09-24T10:00:00.000Z',
    repositories: ['githubnext/gh-aw-cao']
  });

  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(root, 'dependabot', 'operational-value.mjs')],
    { encoding: 'utf8', input: request, env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`,
      CAO_GITHUB_API_MIN_REMAINING: '2000'
    }, stdio: 'pipe' }
  ), /Dependabot alerts pagination repeated a page/);
});

test('Dependabot operational value rejects unexpected pagination links', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-dependabot-value-link-'));
  const fakeGh = path.join(temporary, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" rate_limit "* ]]; then
  printf '5000\\n'
else
  printf 'HTTP/2 200\\nlink: <https://example.com/repos/githubnext/gh-aw-cao/dependabot/alerts?state=open&per_page=100&after=cursor>; rel="next"\\n\\n[]\\n'
fi\n`);
  chmodSync(fakeGh, 0o755);
  const request = JSON.stringify({
    schemaVersion: 1,
    timestamp: '2026-09-24T10:00:00.000Z',
    repositories: ['githubnext/gh-aw-cao']
  });

  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(root, 'dependabot', 'operational-value.mjs')],
    { encoding: 'utf8', input: request, env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`,
      CAO_GITHUB_API_MIN_REMAINING: '2000'
    }, stdio: 'pipe' }
  ), /GitHub API returned an unexpected Dependabot alerts next link/);
});

test('Dependabot operational value rejects excessive pagination', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-dependabot-value-pages-'));
  const fakeGh = path.join(temporary, 'gh');
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" rate_limit "* ]]; then
  printf '5000\\n'
else
  cursor="$(sed -n 's/.*after=\\([0-9][0-9]*\\).*/\\1/p' <<< "$*")"
  if [[ -z "$cursor" ]]; then cursor=0; fi
  next=$((cursor + 1))
  printf 'HTTP/2 200\\nlink: <https://api.github.com/repos/githubnext/gh-aw-cao/dependabot/alerts?state=open&per_page=100&after=%s>; rel="next"\\n\\n[]\\n' "$next"
fi\n`);
  chmodSync(fakeGh, 0o755);
  const request = JSON.stringify({
    schemaVersion: 1,
    timestamp: '2026-09-24T10:00:00.000Z',
    repositories: ['githubnext/gh-aw-cao']
  });

  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(root, 'dependabot', 'operational-value.mjs')],
    { encoding: 'utf8', input: request, env: {
      ...process.env,
      PATH: `${temporary}:${process.env.PATH}`,
      CAO_DEPENDABOT_ALERTS_MAX_PAGES: '2',
      CAO_GITHUB_API_MIN_REMAINING: '2000'
    }, stdio: 'pipe' }
  ), /Dependabot alerts pagination exceeded 2 pages/);
});

test('Daily File Diet shares one value module between CAO collection and historical evaluation', async () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-daily-file-diet-value-'));
  const packageDirectory = path.join(temporary, 'daily-file-diet');
  const sourceDirectory = path.join(temporary, 'source');
  const archive = path.join(temporary, 'repository.tar.gz');
  const fakeGh = path.join(temporary, 'gh');
  const output = path.join(temporary, 'values.jsonl');
  const commit = '0123456789abcdef0123456789abcdef01234567';
  mkdirSync(path.join(sourceDirectory, 'pkg'), { recursive: true });
  writeFileSync(path.join(sourceDirectory, 'pkg', 'large.go'), 'line\n'.repeat(1200));
  writeFileSync(path.join(sourceDirectory, 'pkg', 'healthy.go'), 'line\n'.repeat(800));
  execFileSync('tar', ['-czf', archive, '-C', sourceDirectory, '.']);
  cpSync(path.join(root, 'daily-file-diet'), packageDirectory, { recursive: true });
  writeFileSync(path.join(packageDirectory, 'operational-value', 'other-workflow.mjs'), `
export const definition = {
  slug: "other-workflow",
  evidence: {
    repositories: ["github/gh-aw"],
    window: {durationDays: 1, maturationDays: 0}
  },
  metrics: [{id: "largest-file-health"}]
};
export async function collectBatch(windows) {
  return windows.map(() => ({evidence: {value: 0.25}}));
}
export function scoreMetric(id, evidence) {
  if (id !== "largest-file-health") throw new Error("unknown metric");
  return evidence.value;
}
`);
  writeFileSync(fakeGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *"tarball/"* ]]; then
  cat ${JSON.stringify(archive)}
elif [[ " $* " == *" --paginate --slurp "* ]]; then
  printf '[[{"sha":"${commit}","commit":{"committer":{"date":"2026-09-24T18:00:00Z"}}}]]\\n'
else
  printf '[{"sha":"${commit}","commit":{"committer":{"date":"2026-09-24T18:00:00Z"}}}]\\n'
fi
`);
  chmodSync(fakeGh, 0o755);

  const result = JSON.parse(execFileSync(process.execPath, [
    cao,
    'operational-value',
    '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary,
    '--output', output,
    '--timestamp', '2026-09-24T19:30:24Z',
    '--repository', 'github/gh-aw',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${temporary}:${process.env.PATH}` },
  }));

  assert.deepEqual(result.scripts, ['daily-file-diet']);
  assert.deepEqual(
    result.values.map(({ campaign, repository, valueId, value }) => ({
      campaign, repository, valueId, value,
    })),
    [
      {
        campaign: 'daily-file-diet',
        repository: 'github/gh-aw',
        valueId: 'daily-file-diet.largest-file-health',
        value: 0.8325,
      },
      {
        campaign: 'daily-file-diet',
        repository: 'github/gh-aw',
        valueId: 'daily-file-diet.compliant-line-mass-share',
        value: 0.4,
      },
      {
        campaign: 'daily-file-diet',
        repository: 'github/gh-aw',
        valueId: 'other-workflow.largest-file-health',
        value: 0.25,
      },
    ],
  );
  const valueModule = await import(pathToFileURL(
    path.join(root, 'daily-file-diet', 'operational-value', 'daily-file-diet.mjs')
  ));
  const evidence = {
    eligibleFileCount: 2,
    totalLines: 2000,
    largestFileLines: 1200,
    compliantLines: 800,
  };
  assert.deepEqual(
    result.values
      .filter(({ valueId }) => valueId.startsWith('daily-file-diet.'))
      .map(({ valueId, value }) => ({ valueId, value })),
    valueModule.definition.metrics.map(({ id }) => ({
      valueId: `daily-file-diet.${id}`,
      value: valueModule.scoreMetric(id, evidence),
    })),
  );
  const envelopes = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(envelopes.map(({ operational_value: value }) => ({
    campaign: value.campaign,
    repository: value.repository,
    valueId: value.value_id,
    value: value.value,
  })), result.values.map(({ campaign, repository, valueId, value }) => ({
    campaign, repository, valueId, value,
  })));

  const unrelated = JSON.parse(execFileSync(process.execPath, [
    cao,
    'operational-value',
    '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary,
    '--timestamp', '2026-09-24T19:30:24Z',
    '--repository', 'githubnext/gh-aw-cao',
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${temporary}:${process.env.PATH}` },
  }));
  assert.deepEqual(unrelated.values, []);
});

test('cao operational-value rejects non-numeric metrics and bounds retained output', () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), 'cao-operational-retention-'));
  const packageDirectory = path.join(temporary, 'example');
  const output = path.join(temporary, 'values.jsonl');
  mkdirSync(packageDirectory);
  const script = path.join(packageDirectory, 'operational-value.mjs');
  writeFileSync(script, `process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({timestamp:"2026-09-24T10:00:00.000Z",repository:"githubnext/gh-aw-cao",valueId:"example",value:1})));\n`);
  chmodSync(script, 0o755);
  writeFileSync(output, [
    JSON.stringify({ schema_version: 2, kind: 'operational_value', operational_value: {
      timestamp: '2026-08-01T10:00:00.000Z', repository: 'githubnext/gh-aw-cao', value_id: 'old', value: 1
    } }),
    JSON.stringify({ schema_version: 2, kind: 'operational_value', operational_value: {
      timestamp: '2026-09-20T10:00:00.000Z', repository: 'githubnext/gh-aw-cao', value_id: 'retained', value: 1
    } })
  ].join('\n'));

  execFileSync(process.execPath, [
    cao, 'operational-value', '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary, '--output', output, '--timestamp', '2026-09-24T10:00:00Z',
    '--repository', 'githubnext/gh-aw-cao', '--retention-days', '30'
  ]);
  const envelopes = readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(envelopes.map((entry) => entry.operational_value.value_id), ['retained', 'example']);

  writeFileSync(script, `process.stdin.resume();
process.stdin.on('end', () => console.log(JSON.stringify({timestamp:"2026-09-24T10:00:00Z",repository:"githubnext/gh-aw-cao",valueId:"invalid",value:null})));\n`);
  assert.throws(() => execFileSync(process.execPath, [
    cao, 'operational-value', '--database', path.join(temporary, 'dashboard.sqlite'),
    '--root', temporary, '--repository', 'githubnext/gh-aw-cao'
  ], { stdio: 'pipe' }), /must be a finite number/);
});
