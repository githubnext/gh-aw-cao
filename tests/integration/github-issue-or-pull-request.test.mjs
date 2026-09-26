import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { issueStatusQuery } from '../../activity/cao.mjs';

const execFileAsync = promisify(execFile);

test('GitHub issueOrPullRequest resolves an issue discovered by gh CLI', async () => {
  const repository = process.env.GITHUB_REPOSITORY;
  assert.ok(repository, 'GITHUB_REPOSITORY is required');
  const [owner, name] = repository.split('/');
  assert.ok(owner && name, 'GITHUB_REPOSITORY must be OWNER/REPOSITORY');

  const listed = await execFileAsync('gh', [
    'issue', 'list',
    '--repo', repository,
    '--state', 'all',
    '--limit', '1',
    '--json', 'number'
  ], { encoding: 'utf8' });
  const [issue] = JSON.parse(listed.stdout);
  assert.ok(Number.isSafeInteger(issue?.number), 'gh issue list returned no issue');

  const query = issueStatusQuery([{ number: issue.number }]);
  const queried = await execFileAsync('gh', [
    'api', 'graphql',
    '-f', `query=${query}`,
    '-f', `owner=${owner}`,
    '-f', `name=${name}`
  ], { encoding: 'utf8' });
  const result = JSON.parse(queried.stdout).data?.repository?.i0;

  assert.equal(result?.number, issue.number);
  assert.match(result?.state, /^(OPEN|CLOSED)$/);
  assert.equal(result?.url, `https://github.com/${owner}/${name}/issues/${issue.number}`);
});
