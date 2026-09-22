import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repository = 'githubnext/gh-aw-cao';
const rootResources = [
  'activity',
  'dashboard',
  'cao.sh',
  '.github/actions/setup-cao-runtime',
  '.github/cao/instructions.md',
];

function validateCampaign(campaign) {
  if (!/^(?:root|activity|dashboard|[a-z0-9-]+)$/.test(campaign)) {
    throw new Error(`Invalid CAO campaign name: ${campaign}`);
  }
}

function packageName(record) {
  if (typeof record.package === 'string' && record.package.trim()) return record.package.trim();
  if (typeof record.campaign === 'string' && record.campaign.trim()) return record.campaign.trim();
  if (typeof record.source === 'string') return record.source.split('@')[0].trim();
  return '';
}

function installedRecords(root) {
  const records = [];
  for (const directory of ['packages', 'campaigns']) {
    const recordDirectory = path.join(root, '.github', 'aw', directory);
    let entries;
    try {
      entries = readdirSync(recordDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const record = JSON.parse(readFileSync(path.join(recordDirectory, entry.name), 'utf8'));
      const name = packageName(record);
      if (name === repository || name.startsWith(`${repository}/`)) records.push({ name, record });
    }
  }
  return records;
}

function resolvedRevision(record) {
  const revision = typeof record.resolvedCommit === 'string' ? record.resolvedCommit.trim() : '';
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error(`CAO package record must contain a full resolvedCommit SHA: ${revision || '(missing)'}`);
  }
  return revision;
}

function exactRecordFor(records, campaign) {
  const name = campaign === 'root' ? repository : `${repository}/${campaign}`;
  return records.find((candidate) => candidate.name === name)?.record;
}

function recordFor(records, campaign) {
  const exact = exactRecordFor(records, campaign);
  if (exact) return exact;
  if (campaign === 'activity' || campaign === 'dashboard') {
    const root = records.find((candidate) => candidate.name === repository);
    if (root) return root.record;
  }
  throw new Error(`No installed CAO package record found for ${name}`);
}

async function downloadArchive(revision, destination) {
  const response = await fetch(`https://codeload.github.com/${repository}/tar.gz/${encodeURIComponent(revision)}`);
  if (!response.ok) throw new Error(`Unable to download CAO ${revision}: HTTP ${response.status}`);
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

function archiveRoot(directory) {
  const entries = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (entries.length !== 1) throw new Error('CAO archive did not contain exactly one repository root');
  return path.join(directory, entries[0].name);
}

function copyResource(sourceRoot, repositoryRoot, resource) {
  const source = path.join(sourceRoot, ...resource.split('/'));
  const destination = path.join(repositoryRoot, ...resource.split('/'));
  rmSync(destination, { force: true, recursive: true });
  cpSync(source, destination, { force: true, recursive: true });
}

function validateResources(sourceRoot, resources) {
  for (const resource of resources) {
    const source = path.join(sourceRoot, ...resource.split('/'));
    try {
      statSync(source);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`CAO source revision is missing required resource: ${resource}`);
      }
      throw error;
    }
  }
}

export function materializeCaoFromSource(campaign, sourceRoot, repositoryRoot) {
  validateCampaign(campaign);
  const resources = campaign === 'root' ? rootResources : [campaign];
  validateResources(sourceRoot, resources);
  for (const resource of resources) copyResource(sourceRoot, repositoryRoot, resource);
  return resources;
}

export function planCaoMaterialization(records, campaign) {
  validateCampaign(campaign);
  if (campaign !== 'root') {
    const record = recordFor(records, campaign);
    return [{
      campaign,
      record,
      revision: resolvedRevision(record),
      resources: [campaign],
    }];
  }

  const focused = ['activity', 'dashboard']
    .map((focusedCampaign) => ({
      campaign: focusedCampaign,
      record: exactRecordFor(records, focusedCampaign),
      resources: [focusedCampaign],
    }))
    .filter(({ record }) => record);
  const overriddenResources = new Set(focused.flatMap(({ resources }) => resources));
  return [{
    campaign: 'root',
    record: recordFor(records, 'root'),
    resources: rootResources.filter((resource) => !overriddenResources.has(resource)),
  }, ...focused].map((plan) => ({ ...plan, revision: resolvedRevision(plan.record) }));
}

export async function materializeCao(campaign = 'root', repositoryRoot = process.cwd()) {
  const plans = planCaoMaterialization(installedRecords(repositoryRoot), campaign);
  const temporaryDirectory = mkdtempSync(path.join(tmpdir(), 'cao-materialize-'));
  try {
    const sourceRoots = new Map();
    for (const [index, plan] of plans.entries()) {
      let sourceRoot = sourceRoots.get(plan.revision);
      if (!sourceRoot) {
        const extractionDirectory = path.join(temporaryDirectory, String(index));
        const archive = path.join(temporaryDirectory, `${index}.tar.gz`);
        mkdirSync(extractionDirectory);
        await downloadArchive(plan.revision, archive);
        const tar = spawnSync('tar', ['-xzf', archive, '-C', extractionDirectory], { encoding: 'utf8' });
        if (tar.error || tar.status !== 0) {
          throw new Error(`Unable to extract CAO ${plan.revision}: ${(tar.stderr || tar.error?.message || 'tar failed').trim()}`);
        }
        sourceRoot = archiveRoot(extractionDirectory);
        sourceRoots.set(plan.revision, sourceRoot);
      }
      plan.sourceRoot = sourceRoot;
      validateResources(sourceRoot, plan.resources);
    }
    for (const plan of plans) {
      for (const resource of plan.resources) copyResource(plan.sourceRoot, repositoryRoot, resource);
    }
    return {
      campaign,
      revision: plans[0].revision,
      revisions: Object.fromEntries(plans.map((plan) => [plan.campaign, plan.revision])),
      resources: plans.flatMap((plan) => plan.resources),
    };
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function verifyCaoRuntime(bundle, repositoryRoot = process.cwd()) {
  const required = {
    activity: ['activity/cao.mjs', 'activity/control-settings.mjs', 'activity/collect-logs.sh'],
    dashboard: ['dashboard/site/package.json', 'dashboard/report/aic-usage.mjs'],
  }[bundle];
  if (!required) throw new Error(`Unknown CAO runtime bundle: ${bundle}`);
  const missing = required.filter((file) => {
    try {
      readFileSync(path.join(repositoryRoot, ...file.split('/')));
      return false;
    } catch (error) {
      if (error?.code === 'ENOENT') return true;
      throw error;
    }
  });
  if (missing.length > 0) {
    throw new Error(`CAO ${bundle} runtime is incomplete at its canonical source paths: ${missing.join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, argument = 'root'] = process.argv.slice(2);
  if (command === 'materialize') {
    const result = await materializeCao(argument);
    console.log(`Materialized CAO ${result.campaign} ${result.revision}: ${result.resources.join(', ')}`);
  } else if (command === 'verify') {
    verifyCaoRuntime(argument);
  } else {
    throw new Error('Usage: materialize-cao.mjs <materialize CAMPAIGN|verify BUNDLE>');
  }
}
