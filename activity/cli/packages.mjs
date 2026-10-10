import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateCampaignDeclaration } from './policy.mjs';
import { ghAwVersionParts, compareGhAwVersions } from './gh-aw.mjs';
import { commandFailureMessage, writeJsonAtomically } from './files.mjs';

export function campaignSlugFromSpec(spec) {
  const refSeparator = spec.lastIndexOf('@');
  const withoutRef = refSeparator > spec.indexOf('/') ? spec.slice(0, refSeparator) : spec;
  const slug = withoutRef.replace(/\/+$/, '').split('/').pop();
  if (!slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`Unable to determine campaign name from ${spec}`);
  }
  return slug;
}

function resolvePathWithinRoot(root, destination) {
  const resolved = path.resolve(root, destination);
  const canonicalRoot = realpathSync(root);
  let canonicalPath;
  try {
    canonicalPath = realpathSync(resolved);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const missingSegments = [];
    let existingAncestor = resolved;
    while (true) {
      missingSegments.unshift(path.basename(existingAncestor));
      existingAncestor = path.dirname(existingAncestor);
      try {
        canonicalPath = path.join(realpathSync(existingAncestor), ...missingSegments);
        break;
      } catch (ancestorError) {
        if (ancestorError?.code !== 'ENOENT') throw ancestorError;
      }
    }
  }
  const relative = path.relative(canonicalRoot, canonicalPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Installed package destination escapes the repository: ${destination}`);
  }
  return resolved;
}

export async function installedCampaignRecords(root = process.cwd(), { caoOnly = true } = {}) {
  const records = new Map();
  for (const directory of ['campaigns', 'packages']) {
    let recordsDirectory;
    let entries;
    try {
      recordsDirectory = resolvePathWithinRoot(root, path.join('.github', 'aw', directory));
      entries = await readdir(recordsDirectory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory() || !entry.name.endsWith('.json')) continue;
      const recordPath = resolvePathWithinRoot(root, path.join(recordsDirectory, entry.name));
      let record;
      try {
        record = JSON.parse(await readFile(recordPath, 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(`${path.relative(root, recordPath)} contains invalid JSON: ${error.message}`);
        throw error;
      }
      const campaignName = typeof record.package === 'string' && record.package.trim()
        ? record.package.trim()
        : typeof record.campaign === 'string' && record.campaign.trim()
          ? record.campaign.trim()
          : typeof record.source === 'string'
            ? record.source.split('@')[0].trim()
            : '';
      if (!campaignName || (caoOnly
        && campaignName !== 'githubnext/gh-aw-cao'
        && !campaignName.startsWith('githubnext/gh-aw-cao/'))) {
        continue;
      }
      records.set(campaignName, {
        campaign: campaignName,
        source: typeof record.source === 'string' ? record.source : campaignName,
        resolvedCommit: typeof record.resolvedCommit === 'string' && record.resolvedCommit.trim()
          ? record.resolvedCommit.trim()
          : '',
        record,
        recordPath
      });
    }
  }
  return [...records.values()].sort((left, right) => left.campaign.localeCompare(right.campaign));
}

export function materializeInstalledCao(campaign, execute = spawnSync, sourceRoot) {
  const script = path.join('.github', 'workflows', 'shared', 'materialize-cao.mjs');
  const arguments_ = sourceRoot
    ? [script, 'materialize-source', campaign, sourceRoot]
    : [script, 'materialize', campaign];
  const result = execute(process.execPath, arguments_, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to materialize CAO ${campaign}: ${commandFailureMessage(result, 'materializer failed')}`);
  }
}

export function installedPackageUpdateTarget(campaign) {
  return `https://github.com/${campaign}`;
}

export async function prepareInstalledPackageReleaseSource(
  record,
  releaseTags,
  execute,
  { includePrereleases = false, allowMajor = false } = {}
) {
  if (!record.record || !record.recordPath) return undefined;
  const sourceRef = record.source.split('@').at(-1);
  const sourceIsCommit = /^[0-9a-f]{40}$/i.test(sourceRef);
  const sourceIsRelease = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(sourceRef);
  if (!sourceIsCommit && !(includePrereleases && sourceIsRelease)) return undefined;
  if (sourceIsCommit && !/^[0-9a-f]{40}$/i.test(record.resolvedCommit)) {
    throw new Error(`Installed CAO package record has an invalid resolvedCommit: ${record.resolvedCommit || '(missing)'}`);
  }
  let releaseTag = sourceIsRelease ? sourceRef : releaseTags.get(record.resolvedCommit);
  if (!releaseTag) {
    const tags = execute('gh', [
      'api',
      '--paginate',
      '/repos/githubnext/gh-aw-cao/tags',
      '--jq',
      `.[] | select(.commit.sha == "${record.resolvedCommit}") | .name`
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (tags.error || tags.status !== 0) {
      throw new Error(`Unable to resolve CAO tag for ${record.resolvedCommit}: ${commandFailureMessage(tags, 'gh api failed')}`);
    }
    const candidates = String(tags.stdout || '').trim().split(/\s+/)
      .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag));
    for (const candidate of candidates) {
      const prereleaseFilter = includePrereleases ? 'true' : '.prerelease == false';
      const release = execute('gh', [
        'api',
        `/repos/githubnext/gh-aw-cao/releases/tags/${encodeURIComponent(candidate)}`,
        '--jq',
        `select(.draft == false and ${prereleaseFilter}) | .tag_name`
      ], { encoding: 'utf8' });
      if (!release.error && release.status === 0 && String(release.stdout || '').trim() === candidate) {
        releaseTag = candidate;
        break;
      }
    }
    if (!releaseTag) {
      throw new Error(`No CAO release tag found for ${record.resolvedCommit}; run "cao update latest" to replace installed CAO packages with the latest stable release`);
    }
    releaseTags.set(record.resolvedCommit, releaseTag);
  }
  if (includePrereleases) {
    const releases = execute('gh', [
      'api',
      '--paginate',
      '/repos/githubnext/gh-aw-cao/releases?per_page=100',
      '--jq',
      '.[] | select(.draft == false) | .tag_name'
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (releases.error || releases.status !== 0) {
      throw new Error(`Unable to list CAO releases: ${commandFailureMessage(releases, 'gh api failed')}`);
    }
    const currentMajor = ghAwVersionParts(releaseTag).numbers[0];
    releaseTag = String(releases.stdout || '').trim().split(/\s+/)
      .filter((tag) => /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(tag))
      .filter((tag) => allowMajor || ghAwVersionParts(tag).numbers[0] === currentMajor)
      .filter((tag) => compareGhAwVersions(tag, releaseTag) >= 0)
      .sort(compareGhAwVersions)
      .at(-1) ?? releaseTag;
  }
  const prepared = {
    record: structuredClone(record.record),
    writtenRecord: undefined,
    workflows: new Map()
  };
  try {
    record.record.source = `${record.campaign}@${releaseTag}`;
    for (const file of record.record.files ?? []) {
      if (!file.destination?.endsWith('.md')) continue;
      const workflowPath = resolvePathWithinRoot(process.cwd(), file.destination);
      let content;
      try {
        content = await readFile(workflowPath, 'utf8');
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      const sourcePrefix = `source: ${record.campaign}@`;
      const lines = content.split(/\r?\n/);
      const sourceIndex = lines.findIndex((line) => line.startsWith(sourcePrefix));
      if (sourceIndex === -1) continue;
      lines[sourceIndex] = `${sourcePrefix}${releaseTag}`;
      const updated = lines.join(content.includes('\r\n') ? '\r\n' : '\n');
      prepared.workflows.set(workflowPath, { original: content, written: updated });
      await writeFile(workflowPath, updated);
      file.sha256 = createHash('sha256').update(updated).digest('hex');
    }
    prepared.writtenRecord = structuredClone(record.record);
    await writeJsonAtomically(record.recordPath, record.record);
    return prepared;
  } catch (error) {
    for (const [workflowPath, content] of prepared.workflows) await writeFile(workflowPath, content.original);
    await writeJsonAtomically(record.recordPath, prepared.record);
    throw error;
  }
}

export async function restorePreparedPackageSource(record, prepared) {
  if (!prepared) return;
  for (const [workflowPath, content] of prepared.workflows) {
    let current;
    try {
      current = await readFile(workflowPath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (current === content.written) await writeFile(workflowPath, content.original);
  }
  let currentRecord;
  try {
    currentRecord = JSON.parse(await readFile(record.recordPath, 'utf8'));
  } catch {
    return;
  }
  if (JSON.stringify(currentRecord) === JSON.stringify(prepared.writtenRecord)) {
    await writeJsonAtomically(record.recordPath, prepared.record);
  }
}

export async function readInstalledCaoDeclaration(campaignName) {
  const expectedCampaign = campaignSlugFromSpec(campaignName);
  const declarationPath = path.resolve(expectedCampaign, 'cao.json');
  let declaration;
  try {
    declaration = validateCampaignDeclaration(
      JSON.parse(await readFile(declarationPath, 'utf8')),
      path.relative(process.cwd(), declarationPath)
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    if (error instanceof SyntaxError) throw new Error(`Campaign ${expectedCampaign} installed invalid cao.json: ${error.message}`);
    throw error;
  }
  if (declaration.campaign !== expectedCampaign) {
    throw new Error(`Installed CAO declaration names campaign ${declaration.campaign}, expected ${expectedCampaign}`);
  }
  return declaration;
}
