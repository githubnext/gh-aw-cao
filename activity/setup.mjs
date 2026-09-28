import { spawnSync } from 'node:child_process';
import { readFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

const DEFAULT_POLICY_PATH = '.github/workflows/cao.json';
const REPOSITORY_COORDINATE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function commandFailureMessage(result, fallback) {
  return (result.stderr || '').trim() || result.error?.message || fallback;
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function writeJsonAtomically(filePath, document) {
  const absolutePath = path.resolve(filePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  const temporaryPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { flag: 'wx' });
    await rename(temporaryPath, absolutePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function resolveControlRepository(execute) {
  const result = execute('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' });
  const repository = String(result.stdout || '').trim();
  if (result.error || result.status !== 0 || !REPOSITORY_COORDINATE.test(repository)) {
    throw new Error(
      `Unable to determine control repository: ${commandFailureMessage(result, 'gh repo view failed')}. `
      + 'Run cao setup from a GitHub repository checkout with a configured remote.',
    );
  }
  return repository;
}

function parseRepositoryList(value, fallback, UsageError) {
  const repositories = String(value || '')
    .split(',')
    .map((repository) => repository.trim())
    .filter(Boolean);
  const selected = repositories.length > 0 ? repositories : fallback;
  for (const repository of selected) {
    if (!REPOSITORY_COORDINATE.test(repository)) {
      throw new UsageError(`Repository must use owner/name format: ${repository}`);
    }
  }
  return [...new Set(selected)];
}

function inspectRepository(repository, execute) {
  const result = execute('gh', [
    'repo',
    'view',
    repository,
    '--json',
    'nameWithOwner,visibility',
  ], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to inspect ${repository}: ${commandFailureMessage(result, 'gh repo view failed')}`);
  }
  let document;
  try {
    document = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Unable to inspect ${repository}: gh repo view returned invalid JSON`);
  }
  if (!REPOSITORY_COORDINATE.test(document.nameWithOwner) || typeof document.visibility !== 'string') {
    throw new Error(`Unable to inspect ${repository}: gh repo view returned incomplete repository data`);
  }
  return {
    repository: document.nameWithOwner,
    owner: document.nameWithOwner.split('/')[0],
    visibility: document.visibility.toLowerCase(),
  };
}

function createTerminalPrompt({ input, output, UsageError }) {
  if (!input.isTTY || !output.isTTY) {
    throw new UsageError('cao setup requires an interactive terminal');
  }
  const terminal = createInterface({ input, output });
  const text = async (message, defaultValue = '') => {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await terminal.question(`${message}${suffix}: `)).trim();
    return answer || defaultValue;
  };
  return {
    text,
    note(message) {
      output.write(`${message}\n`);
    },
    async select(message, choices) {
      output.write(`${message}\n`);
      choices.forEach((choice, index) => output.write(`  ${index + 1}. ${choice.label}\n`));
      while (true) {
        const answer = await text('Choose', '1');
        const index = Number.parseInt(answer, 10) - 1;
        if (Number.isInteger(index) && choices[index]) return choices[index].value;
        output.write(`Enter a number from 1 to ${choices.length}.\n`);
      }
    },
    async confirm(message) {
      const answer = (await terminal.question(`${message} [y/N]: `)).trim().toLowerCase();
      return answer === 'y' || answer === 'yes';
    },
    close() {
      terminal.close();
    },
  };
}

export async function setupCaoControlPlane({
  input = process.stdin,
  output = process.stderr,
  prompt,
  execute = spawnSync,
  policyPath = DEFAULT_POLICY_PATH,
  setupAuthentication,
  UsageError = Error,
} = {}) {
  if (typeof setupAuthentication !== 'function') {
    throw new Error('CAO setup authentication handler is unavailable');
  }
  const interactive = prompt || createTerminalPrompt({ input, output, UsageError });
  const ownsPrompt = prompt === undefined;
  let temporaryDirectory;
  try {
    const auth = execute('gh', ['auth', 'status'], { encoding: 'utf8' });
    if (auth.error || auth.status !== 0) {
      throw new Error(`GitHub CLI authentication check failed: ${commandFailureMessage(auth, 'gh auth status failed')}`);
    }

    const controlRepository = resolveControlRepository(execute);
    const control = inspectRepository(controlRepository, execute);
    const policy = JSON.parse(await readFile(path.resolve(policyPath), 'utf8'));
    const campaigns = policy?.['control-plane']?.campaigns;
    if (!isMapping(campaigns) || Object.keys(campaigns).length > 0) {
      throw new Error('cao setup only configures a bare control plane with no declared campaigns');
    }

    interactive.note('\nSet up this CAO control plane');
    interactive.note('No campaign will be installed, enabled, or run.\n');
    const targetAnswer = await interactive.text(
      'Repositories CAO should be able to read (comma-separated owner/name)',
      control.repository,
    );
    const requestedRepositories = parseRepositoryList(targetAnswer, [control.repository], UsageError);
    const inspected = [
      control,
      ...requestedRepositories
        .filter((repository) => repository.toLowerCase() !== control.repository.toLowerCase())
        .map((repository) => inspectRepository(repository, execute)),
    ];
    const repositories = [...new Set(inspected.map(({ repository }) => repository))];
    const owners = [...new Set(inspected.map(({ owner }) => owner))];
    const hasNonPublicTarget = inspected.some(({ repository, visibility }) => (
      repository.toLowerCase() !== control.repository.toLowerCase() && visibility !== 'public'
    ));
    if (control.visibility === 'public' && hasNonPublicTarget) {
      throw new Error('A public control repository cannot be configured for non-public repository evidence; use a private control repository');
    }

    const choices = [owners.length === 1
      ? {
          value: 'github-app',
          label: 'Organization GitHub Apps - private or privileged repository data',
        }
      : {
          value: 'enterprise-app',
          label: 'Enterprise GitHub Apps - organizations in one enterprise',
        },
      {
        value: 'token',
        label: 'Fine-grained PATs - separate user-bound credentials for each resource owner',
      }];

    const profile = await interactive.select('How should CAO authenticate?', choices);
    if (!choices.some((choice) => choice.value === profile)) {
      throw new UsageError(`Authentication profile is not available for this repository scope: ${profile}`);
    }
    const intendedPolicy = structuredClone(policy);
    intendedPolicy['control-plane'].scope = {
      'allowed-owners': owners,
      'allowed-repositories': repositories,
    };
    temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'cao-setup-'));
    const intendedPolicyPath = path.join(temporaryDirectory, 'cao.json');
    await writeJsonAtomically(intendedPolicyPath, intendedPolicy);

    const authenticationArguments = ['--repo', control.repository];
    if (profile === 'github-app' || profile === 'token') {
      authenticationArguments.push('--policy', intendedPolicyPath);
    }
    if (profile === 'github-app' || profile === 'enterprise-app' || profile === 'token') {
      authenticationArguments.push('--write-repository', control.repository);
    }
    if (profile === 'enterprise-app') {
      authenticationArguments.push('--policy', intendedPolicyPath);
      const readClientId = await interactive.text('Read App client ID');
      const writeClientId = await interactive.text('Write App client ID');
      if (!readClientId || !writeClientId) {
        throw new UsageError('Enterprise App setup requires both client IDs');
      }
      authenticationArguments.push(
        '--read-client-id', readClientId,
        '--write-client-id', writeClientId,
      );
    }
    if (profile === 'token') {
      authenticationArguments.push('--expires-in', '30', '--acknowledge-token-risks');
    }

    interactive.note('\nSetup plan');
    interactive.note(`  Control repository: ${control.repository} (${control.visibility})`);
    interactive.note(`  Read scope: ${repositories.join(', ')}`);
    interactive.note(`  Review output write scope: ${control.repository}`);
    interactive.note(`  Authentication: ${profile}`);
    interactive.note('  Campaigns: none');
    if (!await interactive.confirm('Apply this setup?')) {
      return { command: 'setup', cancelled: true };
    }

    const authentication = setupAuthentication(profile, authenticationArguments, { execute });
    await writeJsonAtomically(path.resolve(policyPath), intendedPolicy);
    return {
      command: 'setup',
      controlRepository: control.repository,
      visibility: control.visibility,
      repositories,
      profile,
      authentication,
      campaigns: [],
    };
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    if (ownsPrompt) interactive.close();
  }
}
