import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import {
  controlEnvironment,
  controlPolicy,
  controlProgram,
  root,
} from '../helpers/control-precompute.mjs'

const program = controlProgram()
const workflowSource = `---
safe-outputs:
  dispatch-workflow:
    workflows: [dependabot-release-train-updater]
---
`

function mockGh(directory) {
  const executable = join(directory, 'gh')
  writeFileSync(
    executable,
    `#!/bin/bash
set -euo pipefail
arguments="$*"
if [[ "$arguments" == "api repos/acme/control --jq .private" ]]; then
  printf 'true\n'
elif [[ "$arguments" == *"repos/acme/control/contents/.github/workflows/cao.json"* ]]; then
  printf '%s' "$CONTROL_POLICY" | base64
elif [[ "$arguments" == *"contents/.github/workflows/dependabot.md"* ]]; then
  printf '%s\\n' "$CONTROL_SOURCE_B64"
elif [[ "$arguments" == *"actions/workflows?per_page=100"* ]]; then
  printf '%s\\n' '{"id":1,"name":"Dependabot / Release Trains","path":".github/workflows/dependabot-release-train-updater.lock.yml","state":"active"}'
elif [[ "$arguments" == aw\\ logs\\ dependabot\\ --start-date* ]]; then
  if [[ "\${MOCK_FAIL_BUDGET:-false}" == "true" ]]; then
    printf 'invalid budget data\n'
    exit 1
  fi
  printf '%s\\n' '{"runs":[{"run_id":1,"status":"completed","aic":100}]}'
elif [[ "$arguments" == aw\\ logs\\ dependabot-release-train-updater* ]]; then
  if [[ "\${MOCK_FAIL_BUDGET:-false}" == "true" ]]; then
    printf 'invalid budget data\n'
    exit 1
  fi
  printf '%s\\n' '{"runs":[{"run_id":2,"status":"completed","aic":400}]}'
elif [[ "$arguments" == *"/repos?"* ]]; then
  printf '%s\\n' "$arguments" >> "$MOCK_GH_LOG"
  if [[ "\${MOCK_FAIL_INVENTORY:-false}" == "true" ]]; then
    printf 'simulated API rate limit\\n' >&2
    exit 1
  fi
  page=$(printf '%s' "$arguments" | sed -n 's/.*[?&]page=\\([0-9][0-9]*\\).*/\\1/p')
  for item in $(seq 1 100); do
    index=$(( (page - 1) * 100 + item ))
    printf '{"id":%s,"full_name":"acme/repo-%s","archived":false,"disabled":false,"private":true,"pushed_at":"2026-01-01T00:00:00Z","default_branch":"main"}\n' "$index" "$index"
  done
else
  printf 'unexpected gh invocation: %s\\n' "$arguments" >&2
  exit 1
fi
`,
  )
  chmodSync(executable, 0o755)
}

function runPrecompute(
  overrides = {},
  policy = controlPolicy({
    inventory: { 'max-scan-repositories': 100000 },
    packagePolicy: { 'max-repositories': 1000, 'rollout-percent': 10 },
  }),
) {
  const temporaryDirectory = mkdtempSync(
    join(tmpdir(), 'central-agentic-ops-load-'),
  )
  const logPath = join(temporaryDirectory, 'gh.log')
  const githubEnvironment = join(temporaryDirectory, 'github-env')
  const safeOutputs = join(temporaryDirectory, 'safe-outputs.jsonl')
  const runnerTemp = join(realpathSync(temporaryDirectory), 'runner-temp')
  const admissionDirectory = join(runnerTemp, 'cao')
  const effectivePolicyPath = join(admissionDirectory, 'effective-policy.json')
  mkdirSync(admissionDirectory, { recursive: true })
  mockGh(temporaryDirectory)
  writeFileSync(githubEnvironment, '')
  writeFileSync(safeOutputs, '')

  const env = controlEnvironment({
    ROLE: 'orchestrator',
    TARGET_REPO: '',
    DISPATCH_MAX: '1000',
    WORKER_CREDITS_PER_TARGET: '0',
    CONTROL_POLICY: policy,
    CONTROL_SOURCE_B64: Buffer.from(workflowSource).toString('base64'),
    GITHUB_ENV: githubEnvironment,
    GH_AW_SAFE_OUTPUTS: safeOutputs,
    MOCK_GH_LOG: logPath,
    PATH: `${temporaryDirectory}${delimiter}${process.env.PATH}`,
    RUNNER_TEMP: runnerTemp,
    ...overrides,
  })
  const resolution = spawnSync('node', [program, 'resolve-policy', '-'], {
    cwd: temporaryDirectory,
    encoding: 'utf8',
    input: policy,
    env,
  })
  if (resolution.status !== 0) {
    return { temporaryDirectory, logPath, result: resolution }
  }
  writeFileSync(effectivePolicyPath, resolution.stdout)

  const result = spawnSync('node', [program, 'precompute'], {
    cwd: temporaryDirectory,
    encoding: 'utf8',
    env,
  })

  return { temporaryDirectory, logPath, result }
}

test(
  'control precompute bounds a 100,000-repository inventory',
  { timeout: 120_000 },
  () => {
    const started = performance.now()
    const run = runPrecompute()

    try {
      assert.equal(run.result.status, 0, run.result.stderr)
      const output = JSON.parse(
        readFileSync('/tmp/gh-aw/agent/control-precompute.json', 'utf8'),
      )
      const inventoryCalls = readFileSync(run.logPath, 'utf8')
        .trim()
        .split('\n')
      assert.equal(output.total_repositories_scanned, 100000)
      assert.match(output.inventory_version, /^sha256:[0-9a-f]{64}$/)
      assert.equal(output.batch_count, 1)
      assert.equal(output.candidate_repositories.length, 100000)
      assert.equal(output.effective_max_repos, 1000)
      assert.equal(inventoryCalls.length, 1000)
      assert.ok(
        performance.now() - started < 120_000,
        'bounded inventory exceeded 120 seconds',
      )
    } finally {
      rmSync(run.temporaryDirectory, { recursive: true, force: true })
    }
  },
)

test('control precompute assigns stable cells and bounded batches', () => {
  const firstPolicy = controlPolicy({
    inventory: {
      'max-scan-repositories': 1000,
      'cell-count': 4,
      'cell-index': 1,
      'batch-size': 100,
      'batch-index': 1,
    },
    packagePolicy: { 'max-repositories': 1000, 'rollout-percent': 10 },
  })
  const first = runPrecompute({}, firstPolicy)

  try {
    assert.equal(first.result.status, 0, first.result.stderr)
    const firstOutput = JSON.parse(
      readFileSync('/tmp/gh-aw/agent/control-precompute.json', 'utf8'),
    )
    assert.equal(firstOutput.inventory_repository_count, 1000)
    assert.equal(firstOutput.cell_repository_count, 250)
    assert.equal(firstOutput.batch_count, 3)
    assert.equal(firstOutput.candidate_repositories.length, 100)
    assert.equal(firstOutput.candidate_repositories[0].id, 401)
    assert.equal(firstOutput.candidate_repositories.at(-1).id, 797)
    assert.ok(
      firstOutput.candidate_repositories.every(({ id }) => id % 4 === 1),
    )

    const second = runPrecompute(
      {},
      controlPolicy({
        inventory: {
          'max-scan-repositories': 1000,
          'cell-count': 4,
          'cell-index': 1,
          'batch-size': 100,
          'batch-index': 2,
        },
        packagePolicy: { 'max-repositories': 1000, 'rollout-percent': 10 },
      }),
    )
    try {
      assert.equal(second.result.status, 0, second.result.stderr)
      const secondOutput = JSON.parse(
        readFileSync('/tmp/gh-aw/agent/control-precompute.json', 'utf8'),
      )
      assert.equal(
        secondOutput.inventory_version,
        firstOutput.inventory_version,
      )
      assert.equal(secondOutput.candidate_repositories.length, 50)
      assert.equal(secondOutput.candidate_repositories[0].id, 801)
      assert.equal(secondOutput.candidate_repositories.at(-1).id, 997)
      assert.notEqual(secondOutput.batch_id, firstOutput.batch_id)
    } finally {
      rmSync(second.temporaryDirectory, { recursive: true, force: true })
    }
  } finally {
    rmSync(first.temporaryDirectory, { recursive: true, force: true })
  }
})

test('control precompute attaches package target modes to candidates', () => {
  const policy = controlPolicy({
    inventory: { 'max-scan-repositories': 100 },
    packagePolicy: {
      mode: 'review',
      'max-repositories': 10,
      targets: {
        'acme/repo-1': { mode: 'live' },
      },
    },
    workerPolicy: { 'max-mode': 'live' },
  })
  const run = runPrecompute({ REQUESTED_MODE: '' }, policy)

  try {
    assert.equal(run.result.status, 0, run.result.stderr)
    const output = JSON.parse(
      readFileSync('/tmp/gh-aw/agent/control-precompute.json', 'utf8'),
    )
    assert.equal(output.safe_output_mode, 'review')
    assert.deepEqual(output.worker_workflows[0], {
      configured: 'dependabot-release-train-updater',
      matched: true,
      worker: 'release-train-updater',
      policy_enabled: true,
      max_mode: 'live',
      id: 1,
      name: 'Dependabot / Release Trains',
      path: '.github/workflows/dependabot-release-train-updater.lock.yml',
      state: 'active',
      eligible: true,
      skip_reason: null,
    })
    assert.equal(
      output.candidate_repositories.find(
        ({ full_name }) => full_name === 'acme/repo-1',
      ).safe_output_mode,
      'live',
    )
    assert.equal(
      output.candidate_repositories.find(
        ({ full_name }) => full_name === 'acme/repo-2',
      ).safe_output_mode,
      'review',
    )

    const narrowedRun = runPrecompute({ REQUESTED_MODE: 'review' }, policy)
    try {
      assert.equal(narrowedRun.result.status, 0, narrowedRun.result.stderr)
      const narrowedOutput = JSON.parse(
        readFileSync('/tmp/gh-aw/agent/control-precompute.json', 'utf8'),
      )
      assert.ok(
        narrowedOutput.candidate_repositories.every(
          ({ safe_output_mode }) => safe_output_mode === 'review',
        ),
      )
    } finally {
      rmSync(narrowedRun.temporaryDirectory, { recursive: true, force: true })
    }
  } finally {
    rmSync(run.temporaryDirectory, { recursive: true, force: true })
  }
})

test('control precompute excludes workers disabled by policy', () => {
  const run = runPrecompute(
    {},
    controlPolicy({
      packagePolicy: { 'max-repositories': 10 },
      workerPolicy: { enabled: false },
    }),
  )

  try {
    assert.equal(run.result.status, 0, run.result.stderr)
    const output = JSON.parse(
      readFileSync('/tmp/gh-aw/agent/control-precompute.json', 'utf8'),
    )
    assert.equal(output.worker, '')
    assert.equal(output.worker_workflows[0].policy_enabled, false)
    assert.equal(output.worker_workflows[0].eligible, false)
    assert.equal(
      output.worker_workflows[0].skip_reason,
      'worker disabled by control-plane policy',
    )
    assert.equal(output.effective_max_repos, 0)
  } finally {
    rmSync(run.temporaryDirectory, { recursive: true, force: true })
  }
})

test('control precompute ignores deprecated monthly package budgets', () => {
  const run = runPrecompute(
    {
      ORCHESTRATOR_CREDITS: '250',
      WORKER_CREDITS_PER_TARGET: '600',
    },
    controlPolicy({
      inventory: { 'max-scan-repositories': 1000 },
      packagePolicy: {
        'max-repositories': 10,
        'rollout-percent': 100,
        'monthly-ai-credit-budget': 2000,
      },
    }),
  )

  try {
    assert.equal(run.result.status, 0, run.result.stderr)
    const output = JSON.parse(
      readFileSync('/tmp/gh-aw/agent/control-precompute.json', 'utf8'),
    )
    assert.equal(output.monthly_credit_budget, 0)
    assert.equal(output.monthly_ai_credits_spent, 0)
    assert.equal(output.monthly_ai_credits_remaining, 0)
    assert.equal(output.monthly_budget_error, '')
    assert.equal(output.monthly_budget_target_cap, 10)
    assert.equal(output.effective_max_repos, 10)
  } finally {
    rmSync(run.temporaryDirectory, { recursive: true, force: true })
  }
})

test('control precompute does not read monthly budget usage logs', () => {
  const run = runPrecompute(
    {
      DISPATCH_MAX: '10',
      WORKER_CREDITS_PER_TARGET: '600',
      MOCK_FAIL_BUDGET: 'true',
    },
    controlPolicy({
      inventory: { 'max-scan-repositories': 1000 },
      packagePolicy: {
        'max-repositories': 10,
        'monthly-ai-credit-budget': 2000,
      },
    }),
  )

  try {
    assert.equal(run.result.status, 0, run.result.stderr)
    const output = JSON.parse(
      readFileSync('/tmp/gh-aw/agent/control-precompute.json', 'utf8'),
    )
    assert.equal(output.monthly_budget_error, '')
    assert.equal(output.monthly_budget_target_cap, 10)
    assert.equal(output.effective_max_repos, 10)
  } finally {
    rmSync(run.temporaryDirectory, { recursive: true, force: true })
  }
})

test('control precompute rejects an invalid monthly package budget', () => {
  const run = runPrecompute(
    {},
    controlPolicy({
      inventory: { 'max-scan-repositories': 1000 },
      packagePolicy: { 'monthly-ai-credit-budget': 1.5 },
    }),
  )

  try {
    assert.notEqual(run.result.status, 0)
    assert.match(
      run.result.stderr,
      /control-plane\.packages\.dependabot\.monthly-ai-credit-budget must be an integer in >= 0/,
    )
  } finally {
    rmSync(run.temporaryDirectory, { recursive: true, force: true })
  }
})

test('control precompute fails inventory closed after bounded API errors', () => {
  const run = runPrecompute({ MOCK_FAIL_INVENTORY: 'true' })

  try {
    assert.equal(run.result.status, 0, run.result.stderr)
    const output = JSON.parse(
      readFileSync('/tmp/gh-aw/agent/control-precompute.json', 'utf8'),
    )
    const inventoryCalls = readFileSync(run.logPath, 'utf8').trim().split('\n')
    assert.equal(output.total_repositories_scanned, 0)
    assert.equal(output.effective_max_repos, 0)
    assert.deepEqual(output.candidate_repositories, [])
    assert.match(output.repo_error, /simulated API rate limit/)
    assert.equal(
      inventoryCalls.length,
      2,
      'inventory fallback retried beyond organization and user endpoints',
    )
  } finally {
    rmSync(run.temporaryDirectory, { recursive: true, force: true })
  }
})
