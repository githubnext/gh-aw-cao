import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const repository = 'githubnext/gh-aw-cao';
const rootResources = [
  'activity',
  'dashboard',
  'skills',
  'cao.sh',
  '.github/actions/setup-cao-runtime',
  '.github/cao/instructions.md',
  '.github/workflows/shared/activity-cache.md',
  '.github/workflows/shared/control.md',
  '.github/workflows/shared/review-bundle.md',
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
  const name = campaign === 'root' ? repository : `${repository}/${campaign}`;
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

function tarString(buffer, start, length) {
  return buffer.subarray(start, start + length).toString('utf8').replace(/\0.*$/, '');
}

function tarSize(buffer) {
  const value = tarString(buffer, 124, 12).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('CAO archive has an invalid entry size');
  return Number.parseInt(value || '0', 8);
}

function tarDestination(directory, entry) {
  entry = entry.replace(/\/+$/, '');
  if (!entry || entry.startsWith('/') || entry.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`CAO archive has an unsafe entry path: ${JSON.stringify(entry)}`);
  }
  const destination = path.resolve(directory, ...entry.split('/'));
  if (!destination.startsWith(`${path.resolve(directory)}${path.sep}`)) {
    throw new Error(`CAO archive has an unsafe entry path: ${JSON.stringify(entry)}`);
  }
  return destination;
}

function paxAttributes(data) {
  const attributes = {};
  let offset = 0;
  while (offset < data.length) {
    const separator = data.indexOf(0x20, offset);
    const length = Number.parseInt(data.subarray(offset, separator).toString('utf8'), 10);
    if (!Number.isSafeInteger(length) || length <= 0 || offset + length > data.length) {
      throw new Error('CAO archive has an invalid PAX header');
    }
    const record = data.subarray(separator + 1, offset + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) attributes[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return attributes;
}

export function extractCaoArchive(archive, directory, native = process.platform === 'win32') {
  if (!native) {
    const tar = spawnSync('tar', ['-xzf', archive, '-C', directory], { encoding: 'utf8' });
    if (tar.error || tar.status !== 0) {
      throw new Error((tar.stderr || tar.error?.message || 'tar failed').trim());
    }
    return;
  }

  const data = gunzipSync(readFileSync(archive));
  let offset = 0;
  let nextPath;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = tarSize(header);
    const payloadStart = offset + 512;
    const payloadEnd = payloadStart + size;
    if (payloadEnd > data.length) throw new Error('CAO archive ended before an entry was complete');
    const type = String.fromCharCode(header[156] || 0);
    const payload = data.subarray(payloadStart, payloadEnd);
    if (type === 'x' || type === 'g') {
      const attributes = paxAttributes(payload);
      if (attributes.path) nextPath = attributes.path;
    } else if (type === 'L') {
      nextPath = payload.toString('utf8').replace(/\0.*$/, '');
    } else {
      const entry = nextPath || [tarString(header, 345, 155), tarString(header, 0, 100)].filter(Boolean).join('/');
      nextPath = undefined;
      const destination = tarDestination(directory, entry);
      if (type === '5') {
        mkdirSync(destination, { recursive: true });
      } else if (type === '\0' || type === '0') {
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, payload);
      } else {
        throw new Error(`CAO archive has unsupported entry type: ${type}`);
      }
    }
    offset = payloadStart + Math.ceil(size / 512) * 512;
  }
}

function copyResource(sourceRoot, repositoryRoot, resource) {
  const source = path.join(sourceRoot, ...resource.split('/'));
  const destination = path.join(repositoryRoot, ...resource.split('/'));
  rmSync(destination, { force: true, recursive: true });
  cpSync(source, destination, { force: true, recursive: true });
}

function copyTrackedResource(sourceRoot, repositoryRoot, resource) {
  const listing = spawnSync('git', ['-C', sourceRoot, 'ls-files', '-z', '--', resource], {
    encoding: 'utf8',
  });
  if (listing.error || listing.status !== 0) {
    throw new Error(
      `Unable to list tracked CAO source files for ${resource}: `
      + `${(listing.stderr || listing.error?.message || `exit ${listing.status}`).trim()}`,
    );
  }
  const files = listing.stdout.split('\0').filter(Boolean);
  if (files.length === 0) {
    throw new Error(`CAO source resource has no tracked files: ${resource}`);
  }
  rmSync(path.join(repositoryRoot, ...resource.split('/')), { force: true, recursive: true });
  for (const file of files) {
    const source = path.join(sourceRoot, ...file.split('/'));
    const destination = path.join(repositoryRoot, ...file.split('/'));
    mkdirSync(path.dirname(destination), { recursive: true });
    cpSync(source, destination, { force: true });
  }
}

function removeUndeployedRootResources(sourceRoot, repositoryRoot) {
  const portableSkills = readdirSync(path.join(sourceRoot, 'skills'));
  for (const skill of portableSkills) {
    rmSync(path.join(repositoryRoot, '.github', 'skills', skill), { force: true, recursive: true });
  }
  const skillsDirectory = path.join(repositoryRoot, '.github', 'skills');
  try {
    if (readdirSync(skillsDirectory).length === 0) rmSync(skillsDirectory);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
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
  for (const resource of resources) copyTrackedResource(sourceRoot, repositoryRoot, resource);
  if (campaign === 'root') removeUndeployedRootResources(sourceRoot, repositoryRoot);
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
        const archiveName = `${index}.tar.gz`;
        const archive = path.join(temporaryDirectory, archiveName);
        mkdirSync(extractionDirectory);
        await downloadArchive(plan.revision, archive);
        try {
          extractCaoArchive(archive, extractionDirectory);
        } catch (error) {
          throw new Error(`Unable to extract CAO ${plan.revision}: ${error.message}`, { cause: error });
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
    if (campaign === 'root') removeUndeployedRootResources(plans[0].sourceRoot, repositoryRoot);
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
    activity: [
      'activity/cao.mjs',
      'activity/commands/index.mjs',
      'activity/setup.mjs',
      'activity/upgrade-gh-aw.mjs',
      'activity/control-settings.mjs',
      'activity/repository-visibility.mjs',
      'activity/collect-logs.sh',
      'activity/marketplace.mjs',
      'activity/problem-clustering.mjs',
      'activity/repository-memory.mjs',
    ],
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
  const [command, argument = 'root', sourceRoot] = process.argv.slice(2);
  if (command === 'materialize') {
    const result = await materializeCao(argument);
    console.log(`Materialized CAO ${result.campaign} ${result.revision}: ${result.resources.join(', ')}`);
  } else if (command === 'materialize-source') {
    if (!sourceRoot) throw new Error('materialize-source requires a source directory');
    const resources = materializeCaoFromSource(argument, path.resolve(sourceRoot), process.cwd());
    console.log(`Materialized CAO ${argument} from ${path.resolve(sourceRoot)}: ${resources.join(', ')}`);
  } else if (command === 'verify') {
    verifyCaoRuntime(argument);
  } else {
    throw new Error('Usage: materialize-cao.mjs <materialize CAMPAIGN|materialize-source CAMPAIGN SOURCE|verify BUNDLE>');
  }
}
