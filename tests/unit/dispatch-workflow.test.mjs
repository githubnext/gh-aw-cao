import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const helper = fileURLToPath(
  new URL('../../dashboard/dispatch-workflow.mjs', import.meta.url),
)

test('dispatch helper waits for the correlated workflow run', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'cao-dispatch-'))
  const outputPath = join(temporaryRoot, 'github-output')
  const requests = []
  const server = createServer(async (request, response) => {
    const body = []
    for await (const chunk of request) body.push(chunk)
    requests.push({
      method: request.method,
      url: request.url,
      body: Buffer.concat(body).toString(),
    })

    if (request.method === 'POST') {
      response.writeHead(204).end()
    } else if (
      request.url.startsWith(
        '/repos/acme/control/actions/workflows/dashboard-build.yml/runs?',
      )
    ) {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          workflow_runs: [
            {
              id: 42,
              display_title: 'CAO Dashboard Build / request-1',
              status: 'queued',
              html_url: 'https://github.example/acme/control/actions/runs/42',
            },
          ],
        }),
      )
    } else if (request.url === '/repos/acme/control/actions/runs/42') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          id: 42,
          status: 'completed',
          conclusion: 'success',
          run_attempt: 3,
          html_url: 'https://github.example/acme/control/actions/runs/42',
        }),
      )
    } else {
      response.writeHead(404).end()
    }
  })

  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address()
    const child = spawn(process.execPath, [helper], {
      env: {
        ...process.env,
        DISPATCH_INPUTS: '{"request-id":"request-1"}',
        DISPATCH_POLL_INTERVAL_MS: '1',
        DISPATCH_REF: 'main',
        DISPATCH_RUN_NAME: 'CAO Dashboard Build / request-1',
        DISPATCH_TIMEOUT_MINUTES: '1',
        DISPATCH_WORKFLOW: 'dashboard-build.yml',
        GH_TOKEN: 'test-token',
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: 'acme/control',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    const [exitCode] = await once(child, 'exit')

    assert.equal(exitCode, 0, stderr)
    assert.equal(
      await readFile(outputPath, 'utf8'),
      'run-id=42\nrun-attempt=3\nrun-url=https://github.example/acme/control/actions/runs/42\n',
    )
    assert.deepEqual(JSON.parse(requests[0].body), {
      ref: 'main',
      inputs: { 'request-id': 'request-1' },
      return_run_details: true,
    })
    assert.equal(requests.at(-1).url, '/repos/acme/control/actions/runs/42')
  } finally {
    server.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})

test('dispatch helper skips rate limits with a summary warning', async () => {
  const temporaryRoot = await mkdtemp(
    join(tmpdir(), 'cao-dispatch-rate-limit-'),
  )
  const outputPath = join(temporaryRoot, 'github-output')
  const summaryPath = join(temporaryRoot, 'github-step-summary')
  const server = createServer((request, response) => {
    if (request.method === 'POST') {
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({ message: 'API rate limit exceeded for installation' }),
      )
    } else {
      response.writeHead(404).end()
    }
  })

  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const { port } = server.address()
    const child = spawn(process.execPath, [helper], {
      env: {
        ...process.env,
        DISPATCH_INPUTS: '{}',
        DISPATCH_REF: 'main',
        DISPATCH_RUN_NAME: 'CAO Dashboard Build / request-1',
        DISPATCH_WORKFLOW: 'dashboard-build.yml',
        GH_TOKEN: 'test-token',
        GITHUB_API_URL: `http://127.0.0.1:${port}`,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: 'acme/control',
        GITHUB_STEP_SUMMARY: summaryPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const [exitCode] = await once(child, 'exit')

    assert.equal(exitCode, 0)
    assert.equal(await readFile(outputPath, 'utf8'), 'skipped=true\n')
    assert.match(
      await readFile(summaryPath, 'utf8'),
      /GitHub API rate limit exceeded/,
    )
  } finally {
    server.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
})
