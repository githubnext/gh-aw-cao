import { spawnSync } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { REPOSITORY_COORDINATE } from '../operational-value.mjs';
import { isMapping, commandFailureMessage, writeJsonAtomically } from './files.mjs';
import { parseGhAwVersion } from './gh-aw.mjs';

const CAO_SCHEMA_URL = 'https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/.github/workflows/shared/cao.schema.json';

export const DEFAULT_POLICY_PATH = '.github/workflows/cao.json';

export function validateCampaignDeclaration(document, source) {
  if (!isMapping(document)) throw new Error(`${source} must contain a JSON object`);
  const keys = Object.keys(document);
  const unknown = keys.filter((key) => !['campaign', 'orchestrator', 'workers'].includes(key));
  if (unknown.length > 0) throw new Error(`${source} contains unknown key: ${unknown[0]}`);
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  if (typeof document.campaign !== 'string' || !slug.test(document.campaign)) {
    throw new Error(`${source} campaign must be a kebab-case identifier`);
  }
  if (typeof document.orchestrator !== 'string' || !slug.test(document.orchestrator)) {
    throw new Error(`${source} orchestrator must be a kebab-case workflow identifier`);
  }
  if (!isMapping(document.workers) || Object.keys(document.workers).length === 0) {
    throw new Error(`${source} workers must be a non-empty object`);
  }
  const workflows = new Set();
  for (const [worker, workflow] of Object.entries(document.workers)) {
    if (!slug.test(worker)) throw new Error(`${source} worker ${worker} must be a kebab-case identifier`);
    if (typeof workflow !== 'string' || !slug.test(workflow)) {
      throw new Error(`${source} worker ${worker} must name a kebab-case workflow`);
    }
    if (workflows.has(workflow)) throw new Error(`${source} workers must name unique workflows`);
    workflows.add(workflow);
  }
  return document;
}

// New policies authorize only the repository gh resolves for the current
// checkout; broader collection is an explicit policy and credential decision.
export function resolveControlRepository(execute) {
  const result = execute('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' });
  const instruction = 'Run cao init from a GitHub repository checkout with a configured remote.';
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to determine control repository: ${commandFailureMessage(result, 'gh repo view failed')}. ${instruction}`);
  }
  const repository = String(result.stdout || '').trim();
  if (!REPOSITORY_COORDINATE.test(repository)) {
    throw new Error(`Unable to determine control repository: gh repo view returned ${JSON.stringify(repository)}. ${instruction}`);
  }
  return repository;
}

export function minimalPolicy(version, repository) {
  return {
    $schema: CAO_SCHEMA_URL,
    version: 1,
    'gh-aw-version': version,
    'control-plane': {
      scope: {
        'allowed-owners': [repository.split('/')[0]],
        'allowed-repositories': [repository]
      },
      marketplace: { registries: [{ id: 'official', name: 'Official CAO catalog', repository: 'githubnext/gh-aw-cao', ref: 'main', auth: { type: 'none' } }] }, campaigns: {}
    }
  };
}

export async function initializeCaoPolicy({
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  const absolutePath = path.resolve(policyPath);
  try {
    await stat(absolutePath);
    throw new Error(`${policyPath} already exists`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const version = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
  const repository = resolveControlRepository(execute);
  await writeJsonAtomically(absolutePath, minimalPolicy(version, repository));
  return { command: 'init', policy: policyPath, 'gh-aw-version': version };
}

export function validateGlobalPolicy(document, source) {
  if (!isMapping(document) || document.version !== 1) throw new Error(`${source} must declare version 1`);
  if (document['control-plane'] !== undefined && !isMapping(document['control-plane'])) {
    throw new Error(`${source} control-plane must be an object`);
  }
  if (document['control-plane']?.campaigns !== undefined && !isMapping(document['control-plane'].campaigns)) {
    throw new Error(`${source} control-plane.campaigns must be an object`);
  }
  return document;
}

export async function readCaoPolicy(policyPath, command = 'update') {
  try {
    return validateGlobalPolicy(JSON.parse(await readFile(path.resolve(policyPath), 'utf8')), policyPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${policyPath} is required for cao ${command}`);
    if (error instanceof SyntaxError) throw new Error(`${policyPath} contains invalid JSON: ${error.message}`);
    throw error;
  }
}

export function mergeCaoCampaignDeclaration(policy, declaration) {
  const controlPlane = policy['control-plane'] ?? {};
  const campaigns = controlPlane.campaigns ?? {};
  const existingCampaign = isMapping(campaigns[declaration.campaign]) ? campaigns[declaration.campaign] : {};
  const existingWorkers = isMapping(existingCampaign.workers) ? existingCampaign.workers : {};
  const workers = Object.fromEntries(Object.entries(declaration.workers).map(([worker, workflow]) => {
    const existing = isMapping(existingWorkers[worker]) ? existingWorkers[worker] : {};
    const preserved = {};
    if (typeof existing.enabled === 'boolean') preserved.enabled = existing.enabled;
    if (existing['max-mode'] === 'review' || existing['max-mode'] === 'live') preserved['max-mode'] = existing['max-mode'];
    return [worker, { workflow, ...preserved }];
  }));
  policy['control-plane'] = {
    ...controlPlane,
    campaigns: {
      ...campaigns,
      [declaration.campaign]: {
        ...existingCampaign,
        workers
      }
    }
  };
}
