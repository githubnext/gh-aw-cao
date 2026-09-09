import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  issueContentDigest,
  publicationCommentMarker,
  publicationMarker,
} from '../../ops-publish/ops-publish.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const scriptPath = join(root, 'ops-publish', 'ops-publish.mjs')
const sourceBody =
  'Finding\n\nGenerated from [AW Doctor / Failures](https://github.com/acme/control/actions/runs/123)'

function sourceIssue(overrides = {}) {
  return {
    number: 42,
    state: 'open',
    title: 'Investigate failing workflow',
    body: sourceBody,
    created_at: '2026-08-27T10:00:00Z',
    user: { login: 'github-actions[bot]', type: 'Bot' },
    labels: [{ name: 'ops:publish-to-target' }],
    ...overrides,
  }
}

const mockFetchSource = `
import { appendFileSync } from "node:fs";

const config = JSON.parse(process.env.MOCK_CONFIG || "{}");
const response = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});
const record = (method, url, options) => appendFileSync(process.env.MOCK_LOG, JSON.stringify({
  method,
  path: url.pathname + url.search,
  authorization: options.headers?.authorization,
  body: options.body ? JSON.parse(options.body) : null,
}) + "\\n");

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const method = String(options.method || "GET").toUpperCase();
  record(method, url, options);

  if (config.forbiddenPath === url.pathname) return response({ message: "Resource not accessible" }, 403);
  if (config.networkFailurePath === url.pathname) throw new Error("Configured network failure");
  if (config.invalidJsonPath === url.pathname) return new Response("not-json", { status: 200 });
  if (config.failurePath === url.pathname && (!config.failureMethod || config.failureMethod === method)) {
    return response({ message: "Configured API failure" }, config.failureStatus || 500);
  }
  if (url.pathname === "/repos/acme/control/actions/runs/123") return response(config.run);
  if (method === "GET" && url.pathname === "/repos/acme/review/issues/42") return response(config.sourceIssue);
  if (method === "PATCH" && url.pathname === "/repos/acme/review/issues/42") return response({ ...config.sourceIssue, state: "closed" });
  if (method === "GET" && url.pathname === "/repos/acme/service") return response(config.targetRepository);
  if (method === "GET" && url.pathname === "/repos/acme/service/commits/main") return response(config.targetCommit);
  if (method === "GET" && url.pathname === "/repos/acme/service/contents/.github/workflows/cao.json") {
    if (config.authorityMissing) return response({ message: "Not Found" }, 404);
    return response({ content: Buffer.from(config.authoritySource).toString("base64") });
  }
  if (method === "GET" && url.pathname === "/repos/acme/service/issues") {
    const page = Number(url.searchParams.get("page"));
    if (config.targetPagesFull) {
      return response(Array.from({ length: 100 }, (_, index) => ({
        number: (page * 100) + index,
        body: "Unrelated issue",
        created_at: "2026-08-28T10:00:00Z",
      })));
    }
    if (config.paginatedExisting && page === 1) {
      return response(Array.from({ length: 100 }, (_, index) => ({
        number: index + 100,
        body: "Unrelated issue",
        created_at: "2026-08-28T10:00:00Z",
      })));
    }
    if (config.targetExisting || (config.paginatedExisting && page === 2)) return response([config.targetIssue]);
    return response([]);
  }
  if (method === "POST" && url.pathname === "/repos/acme/service/issues") {
    const body = JSON.parse(options.body);
    return response({ number: 84, html_url: "https://github.com/acme/service/issues/84", ...body });
  }
  if (method === "GET" && url.pathname === "/repos/acme/review/issues/42/comments") {
    return response(config.commentExisting ? [{ id: 7, body: config.commentBody }] : []);
  }
  if (method === "POST" && url.pathname === "/repos/acme/review/issues/42/comments") {
    return response({ id: 8, ...JSON.parse(options.body) });
  }
  throw new Error("unhandled mock request: " + method + " " + url.pathname + url.search);
};
`

function runCommand(
  command,
  {
    approvedIssue,
    config = {},
    env = {},
    event,
    settings = {
      allowed_owners: ['acme'],
      allowed_repositories: ['acme/service'],
      packages: {
        'aw-doctor': {
          worker_policies: {
            'aw-failures-investigator': {
              worker: 'failures-investigator',
              enabled: true,
              max_mode: null,
            },
          },
        },
      },
      publishing_enabled: true,
      publishing_control_repositories: ['acme/control'],
      publishing_reviewers: ['octocat'],
    },
  } = {},
) {
  const temporaryRoot = mkdtempSync(
    join(tmpdir(), 'central-agentic-ops-publish-'),
  )
  const mockFetchPath = join(temporaryRoot, 'mock-fetch.mjs')
  const logPath = join(temporaryRoot, 'requests.jsonl')
  const outputPath = join(temporaryRoot, 'output.txt')
  const eventPath = join(temporaryRoot, 'event.json')
  const settingsPath = join(temporaryRoot, 'control-settings.json')
  const currentSourceIssue = config.sourceIssue || sourceIssue()
  const approvedSourceIssue = approvedIssue || currentSourceIssue
  const targetIssue = {
    number: 84,
    html_url: 'https://github.com/acme/service/issues/84',
    body: `Existing publication\n\n${publicationMarker('acme/review', 42)}`,
    created_at: '2026-08-27T10:01:00Z',
  }
  const completeConfig = {
    sourceIssue: currentSourceIssue,
    targetRepository: {
      default_branch: 'main',
      archived: false,
      disabled: false,
      has_issues: true,
    },
    targetCommit: { sha: '0123456789abcdef0123456789abcdef01234567' },
    authoritySource: JSON.stringify({
      version: 1,
      'target-authority': {
        packages: { 'aw-doctor': { authority: 'acme/control' } },
      },
    }),
    targetIssue,
    commentBody: `Published\n\n${publicationCommentMarker('acme/service', 84)}`,
    run: {
      id: 123,
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      path: '.github/workflows/aw-failures-investigator.lock.yml',
      head_branch: 'main',
      created_at: '2026-08-27T10:00:00Z',
      updated_at: '2026-08-27T10:02:00Z',
      display_title: 'AW failure investigation · acme/service · review',
      html_url: 'https://github.com/acme/control/actions/runs/123',
      repository: { full_name: 'acme/control', default_branch: 'main' },
    },
    ...config,
  }
  writeFileSync(mockFetchPath, mockFetchSource)
  writeFileSync(outputPath, '')
  writeFileSync(settingsPath, JSON.stringify(settings))
  if (event) writeFileSync(eventPath, JSON.stringify(event))
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', mockFetchPath, scriptPath, command],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          CONTROL_SETTINGS: settingsPath,
          CONTROL_REPOSITORY: 'acme/control',
          CONTROL_TOKEN: 'control-token',
          GITHUB_API_URL: 'https://api.github.com',
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_OUTPUT: outputPath,
          GITHUB_REPOSITORY: 'acme/review',
          GITHUB_SERVER_URL: 'https://github.com',
          MOCK_CONFIG: JSON.stringify(completeConfig),
          MOCK_LOG: logPath,
          PACKAGE: 'aw-doctor',
          REVIEWER: 'octocat',
          SOURCE_CONTENT_DIGEST: issueContentDigest(
            approvedSourceIssue.title,
            approvedSourceIssue.body,
          ),
          SOURCE_ISSUE: '42',
          SOURCE_ISSUE_CREATED_AT: currentSourceIssue.created_at,
          SOURCE_RUN_ID: '123',
          SOURCE_RUN_URL: 'https://github.com/acme/control/actions/runs/123',
          SOURCE_TOKEN: 'source-token',
          TARGET_REPOSITORY: 'acme/service',
          TARGET_TOKEN: 'target-token',
          ...env,
        },
      },
    )
    const requests = existsSync(logPath)
      ? readFileSync(logPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map(JSON.parse)
      : []
    return {
      ...result,
      output: readFileSync(outputPath, 'utf8'),
      requests,
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

test('inspect and validate-run emit trusted publication inputs', () => {
  const issue = sourceIssue()
  const inspection = runCommand('inspect', {
    event: {
      action: 'labeled',
      label: { name: 'ops:publish-to-target' },
      repository: { full_name: 'acme/review' },
      sender: { login: 'octocat', type: 'User' },
      issue,
    },
  })
  assert.equal(inspection.status, 0, inspection.stderr)
  assert.match(
    inspection.output,
    new RegExp(
      `source_content_digest=${issueContentDigest(issue.title, issue.body)}`,
    ),
  )
  assert.match(inspection.output, /control_repository=acme\/control/)
  assert.match(inspection.output, /source_created_at=2026-08-27T10:00:00Z/)

  const validation = runCommand('validate-run')
  assert.equal(validation.status, 0, validation.stderr)
  assert.match(validation.output, /package=aw-doctor/)
  assert.match(validation.output, /target_repository=acme\/service/)
  assert.equal(validation.requests[0].authorization, 'Bearer control-token')
})

test('publish creates the approved target issue and completes its source', () => {
  const result = runCommand('publish')
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.output,
    /target_issue_url=https:\/\/github.com\/acme\/service\/issues\/84/,
  )

  const targetRequests = result.requests.filter(({ path }) =>
    path.startsWith('/repos/acme/service'),
  )
  const sourceRequests = result.requests.filter(({ path }) =>
    path.startsWith('/repos/acme/review'),
  )
  assert.ok(
    targetRequests.every(
      ({ authorization }) => authorization === 'Bearer target-token',
    ),
  )
  assert.ok(
    sourceRequests.every(
      ({ authorization }) => authorization === 'Bearer source-token',
    ),
  )

  const create = result.requests.find(
    ({ method, path }) =>
      method === 'POST' && path === '/repos/acme/service/issues',
  )
  assert.equal(create.body.title, 'Investigate failing workflow')
  assert.match(
    create.body.body,
    new RegExp(publicationMarker('acme/review', 42)),
  )
  const comment = result.requests.find(
    ({ method, path }) =>
      method === 'POST' && path === '/repos/acme/review/issues/42/comments',
  )
  assert.match(
    comment.body.body,
    new RegExp(publicationCommentMarker('acme/service', 84)),
  )
  assert.ok(
    result.requests.some(
      ({ method, path }) =>
        method === 'PATCH' && path === '/repos/acme/review/issues/42',
    ),
  )
})

test('publish reuses existing target issues and source comments', () => {
  const result = runCommand('publish', {
    config: { targetExisting: true, commentExisting: true },
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(
    result.requests.some(
      ({ method, path }) =>
        method === 'POST' && path === '/repos/acme/service/issues',
    ),
    false,
  )
  assert.equal(
    result.requests.some(
      ({ method, path }) => method === 'POST' && path.endsWith('/comments'),
    ),
    false,
  )
  assert.ok(
    result.requests.some(
      ({ method, path }) =>
        method === 'PATCH' && path === '/repos/acme/review/issues/42',
    ),
  )
})

test('publish follows pagination to find an existing target issue', () => {
  const result = runCommand('publish', { config: { paginatedExisting: true } })
  assert.equal(result.status, 0, result.stderr)
  const issuePages = result.requests.filter(
    ({ method, path }) =>
      method === 'GET' && path.startsWith('/repos/acme/service/issues?'),
  )
  assert.equal(issuePages.length, 2)
  assert.equal(
    result.requests.some(
      ({ method, path }) =>
        method === 'POST' && path === '/repos/acme/service/issues',
    ),
    false,
  )
})

test('publish rejects content changed after approval', () => {
  const approvedIssue = sourceIssue()
  const result = runCommand('publish', {
    approvedIssue,
    config: {
      sourceIssue: sourceIssue({ body: `${sourceBody}\n\nUnapproved edit` }),
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr,
    /content changed after ops:publish-to-target approval/,
  )
  assert.equal(
    result.requests.some(({ path }) => path.startsWith('/repos/acme/service')),
    false,
  )
})

test('publish rejects invalid source and target state', () => {
  for (const [config, message] of [
    [
      { sourceIssue: sourceIssue({ state: 'closed' }) },
      /no longer an open bot-authored issue/,
    ],
    [{ sourceIssue: sourceIssue({ labels: [] }) }, /label was removed/],
    [
      {
        targetRepository: {
          default_branch: 'main',
          archived: true,
          disabled: false,
          has_issues: true,
        },
      },
      /cannot accept published issues/,
    ],
  ]) {
    const result = runCommand('publish', { config })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, message)
  }
})

test('publish ignores missing, malformed, or mismatched target authority', () => {
  for (const config of [
    { authorityMissing: true },
    { authoritySource: 'version: [' },
    {
      authoritySource: JSON.stringify({
        version: 1,
        'target-authority': {
          packages: { 'aw-doctor': { authority: 'acme/other' } },
        },
      }),
    },
  ]) {
    const result = runCommand('publish', { config })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      result.requests.some(
        ({ method, path }) =>
          method === 'POST' && path === '/repos/acme/service/issues',
      ),
      true,
    )
  }
})

test('publish surfaces GitHub API authorization failures without writing', () => {
  const result = runCommand('publish', {
    config: { forbiddenPath: '/repos/acme/service' },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GitHub API 403/)
  assert.equal(
    result.requests.some(({ method }) => method === 'POST'),
    false,
  )
})

test('validate-run surfaces authentication, server, network, and malformed JSON failures', () => {
  for (const [config, message] of [
    [
      {
        failurePath: '/repos/acme/control/actions/runs/123',
        failureStatus: 401,
      },
      /GitHub API 401/,
    ],
    [
      {
        failurePath: '/repos/acme/control/actions/runs/123',
        failureStatus: 500,
      },
      /GitHub API 500/,
    ],
    [
      { networkFailurePath: '/repos/acme/control/actions/runs/123' },
      /Configured network failure/,
    ],
    [
      { invalidJsonPath: '/repos/acme/control/actions/runs/123' },
      /GitHub API returned invalid JSON/,
    ],
  ]) {
    const result = runCommand('validate-run', { config })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, message)
  }
})

test('publish rejects malformed command inputs and missing target credentials', () => {
  for (const [env, message] of [
    [
      { SOURCE_CONTENT_DIGEST: 'not-a-digest' },
      /approved source content digest is invalid/,
    ],
    [{ PACKAGE: 'unknown' }, /package is unsupported/],
    [{ TARGET_TOKEN: '' }, /required GitHub credential is not configured/],
  ]) {
    const result = runCommand('publish', { env })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, message)
  }
})

test('publish propagates target creation failures without completing the source', () => {
  const result = runCommand('publish', {
    config: {
      failurePath: '/repos/acme/service/issues',
      failureMethod: 'POST',
      failureStatus: 422,
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /GitHub API 422/)
  assert.equal(
    result.requests.some(({ path }) => path.endsWith('/comments')),
    false,
  )
  assert.equal(
    result.requests.some(
      ({ method, path }) =>
        method === 'PATCH' && path === '/repos/acme/review/issues/42',
    ),
    false,
  )
})

test('publish fails closed when target idempotency cannot be proven within its bound', () => {
  const result = runCommand('publish', { config: { targetPagesFull: true } })
  assert.notEqual(result.status, 0)
  assert.match(
    result.stderr,
    /could not prove publication idempotency within 100 target issue pages/,
  )
  assert.equal(
    result.requests.filter(
      ({ method, path }) =>
        method === 'GET' && path.startsWith('/repos/acme/service/issues?'),
    ).length,
    100,
  )
  assert.equal(
    result.requests.some(({ method }) => method === 'POST'),
    false,
  )
})
