import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { checkLiveWriteAuthentication } from '../authentication.mjs';
import { parseUpdateArguments, resolveUpdateCommit } from '../commands/update.mjs';
import { DEFAULT_POLICY_PATH, resolveControlRepository, minimalPolicy, validateGlobalPolicy, readCaoPolicy, mergeCaoCampaignDeclaration } from './policy.mjs';
import { UsageError } from './options.mjs';
import { isMapping, commandFailureMessage, writeJsonAtomically } from './files.mjs';
import { parseGhAwVersion, compareGhAwVersions, ensureGhAwMinimumVersion } from './gh-aw.mjs';
import { campaignSlugFromSpec, installedCampaignRecords, materializeInstalledCao, installedPackageUpdateTarget, prepareInstalledPackageReleaseSource, restorePreparedPackageSource, readInstalledCaoDeclaration } from './packages.mjs';

export async function addCaoCampaign(campaignSpec, ghAwOptions = [], {
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  if (!campaignSpec || campaignSpec.startsWith('-')) throw new UsageError('cao add requires a campaign');
  const expectedCampaign = campaignSlugFromSpec(campaignSpec);
  if (expectedCampaign === 'gh-aw-cao') {
    throw new UsageError('cao add cannot install the CAO root package; use install.sh');
  }
  let localSourceRoot;
  try {
    const localSource = path.resolve(campaignSpec);
    if ((await stat(localSource)).isDirectory()) {
      localSourceRoot = path.dirname(realpathSync(localSource));
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const install = execute('gh', ['aw', 'add', campaignSpec, ...ghAwOptions], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024
  });
  if (install.error || install.status !== 0) {
    throw new Error(`gh aw add failed: ${commandFailureMessage(install, 'unknown error')}`);
  }

  materializeInstalledCao(expectedCampaign, execute, localSourceRoot);
  const declaration = await readInstalledCaoDeclaration(campaignSpec);
  if (!declaration) throw new Error(`Campaign ${expectedCampaign} did not install ${expectedCampaign}/cao.json`);

  const absolutePolicyPath = path.resolve(policyPath);
  let policy;
  try {
    policy = validateGlobalPolicy(JSON.parse(await readFile(absolutePolicyPath, 'utf8')), policyPath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      if (error instanceof SyntaxError) throw new Error(`${policyPath} contains invalid JSON: ${error.message}`);
      throw error;
    }
    const version = parseGhAwVersion(execute('gh', ['aw', 'version'], { encoding: 'utf8' }));
    policy = minimalPolicy(version, resolveControlRepository(execute));
  }

  mergeCaoCampaignDeclaration(policy, declaration);
  await writeJsonAtomically(absolutePolicyPath, policy);
  return {
    command: 'add',
    campaign: declaration.campaign,
    orchestrator: declaration.orchestrator,
    workers: Object.keys(declaration.workers),
    policy: policyPath
  };
}

export async function updateCaoCampaigns(ghAwOptions = [], {
  policyPath = DEFAULT_POLICY_PATH,
  execute = spawnSync
} = {}) {
  const { ref, includePrereleases, updateOptions } = parseUpdateArguments(ghAwOptions, UsageError);
  const policy = await readCaoPolicy(policyPath);
  const ghAw = await ensureGhAwMinimumVersion({ policyPath, execute });
  const campaigns = await installedCampaignRecords();
  if (campaigns.length === 0) {
    throw new Error('No installed gh-aw package records found under .github/aw/packages');
  }
  for (const record of campaigns) {
    if (!/^[0-9a-f]{40}$/i.test(record.resolvedCommit)) {
      throw new Error(`Installed CAO package record must contain a full resolvedCommit SHA: ${record.resolvedCommit || '(missing)'}`);
    }
  }

  const resolvedCommit = resolveUpdateCommit(ref, execute, commandFailureMessage, compareGhAwVersions);
  const updatedCampaigns = [];
  const mergedDeclarations = [];
  const releaseTags = new Map();
  for (const record of campaigns) {
    const preparedSource = resolvedCommit ? undefined : await prepareInstalledPackageReleaseSource(record, releaseTags, execute, {
      includePrereleases,
      allowMajor: updateOptions.includes('--major')
    });
    // gh-aw update advances SHA sources to the default branch, so exact refs
    // must be reapplied through add, which also writes the ownership record.
    // Match install.sh: root resources contain an intentional App setup form
    // that gh-aw's Markdown scanner rejects.
    const addOptions = record.campaign === 'githubnext/gh-aw-cao' && !updateOptions.includes('--no-security-scanner')
      ? ['--no-security-scanner', ...updateOptions]
      : updateOptions;
    const updateArguments = resolvedCommit
      ? ['aw', 'add', `${record.campaign}@${resolvedCommit}`, '--force', ...addOptions]
      : ['aw', 'update', installedPackageUpdateTarget(record.campaign), ...updateOptions];
    const update = execute('gh', updateArguments, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    if (update.error || update.status !== 0) {
      await restorePreparedPackageSource(record, preparedSource);
      throw new Error(`gh aw ${updateArguments[1]} failed for ${record.campaign}: ${commandFailureMessage(update, 'unknown error')}`);
    }
    if (resolvedCommit) {
      const installed = (await installedCampaignRecords()).find((candidate) => candidate.campaign === record.campaign);
      if (installed?.resolvedCommit.toLowerCase() !== resolvedCommit) {
        throw new Error(`CAO package ${record.campaign} did not record requested commit ${resolvedCommit}; refusing to materialize`);
      }
    }
    const campaign = record.campaign === 'githubnext/gh-aw-cao'
      ? 'root'
      : record.campaign.split('/').at(-1);
    materializeInstalledCao(campaign, execute);
    const declaration = await readInstalledCaoDeclaration(record.campaign);
    if (declaration) {
      mergeCaoCampaignDeclaration(policy, declaration);
      mergedDeclarations.push(declaration.campaign);
    }
    updatedCampaigns.push(record.campaign);
  }
  if (mergedDeclarations.length > 0) await writeJsonAtomically(path.resolve(policyPath), policy);
  return {
    command: 'update',
    policy: policyPath,
    'gh-aw': ghAw,
    ...(resolvedCommit ? { ref, resolvedCommit } : {}),
    campaigns: updatedCampaigns,
    declarations: mergedDeclarations
  };
}

export async function setCaoCampaignMode(mode, campaignNames, {
  policyPath = DEFAULT_POLICY_PATH,
  checkAuthentication = checkLiveWriteAuthentication
} = {}) {
  if (mode !== 'live' && mode !== 'preview') {
    throw new UsageError('cao mode requires live or preview');
  }
  if (!Array.isArray(campaignNames) || campaignNames.length === 0) {
    throw new UsageError(`cao mode ${mode} requires at least one campaign`);
  }

  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const invalidCampaign = campaignNames.find((campaignName) => typeof campaignName !== 'string' || !slug.test(campaignName));
  if (invalidCampaign !== undefined) {
    throw new UsageError(`Invalid CAO campaign name: ${invalidCampaign}`);
  }

  const policy = await readCaoPolicy(policyPath, 'mode');
  const campaigns = policy['control-plane']?.campaigns ?? {};
  const unknownCampaigns = [...new Set(campaignNames)].filter((campaignName) => !Object.hasOwn(campaigns, campaignName));
  if (unknownCampaigns.length > 0) {
    throw new UsageError(`Unknown CAO campaign${unknownCampaigns.length === 1 ? '' : 's'}: ${unknownCampaigns.join(', ')}`);
  }
  for (const campaignName of campaignNames) {
    if (!isMapping(campaigns[campaignName])) {
      throw new Error(`${policyPath} control-plane campaign ${campaignName} must be an object`);
    }
  }

  if (mode === 'live') checkAuthentication();
  const policyMode = mode === 'preview' ? 'review' : 'live';
  for (const campaignName of new Set(campaignNames)) {
    campaigns[campaignName] = { ...campaigns[campaignName], mode: policyMode };
  }
  await writeJsonAtomically(path.resolve(policyPath), policy);
  return {
    command: 'mode',
    mode,
    campaigns: [...new Set(campaignNames)],
    policy: policyPath
  };
}

export async function setCaoCampaignWorkflowsEnabled(action, campaignNames, {
  execute = spawnSync
} = {}) {
  if (action !== 'enable' && action !== 'disable') {
    throw new UsageError('CAO campaign workflow action must be enable or disable');
  }
  if (!Array.isArray(campaignNames) || campaignNames.length === 0) {
    throw new UsageError(`cao ${action} requires at least one campaign`);
  }
  const campaigns = [...new Set(campaignNames)];
  const invalidCampaign = campaigns.find((campaignName) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(campaignName));
  if (invalidCampaign !== undefined) {
    throw new UsageError(`Invalid CAO campaign name: ${invalidCampaign}`);
  }

  const declarations = [];
  for (const campaignName of campaigns) {
    const declaration = await readInstalledCaoDeclaration(campaignName);
    if (!declaration) {
      throw new Error(`Campaign ${campaignName} is not installed or does not declare CAO workflows`);
    }
    declarations.push(declaration);
  }
  const workflows = [...new Set(declarations.flatMap((declaration) => [
    declaration.orchestrator,
    ...Object.values(declaration.workers)
  ]))];
  for (const workflow of workflows) {
    const workflowFile = `${workflow}.lock.yml`;
    const result = execute('gh', ['workflow', action, workflowFile], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024
    });
    if (result.error || result.status !== 0) {
      throw new Error(`gh workflow ${action} failed for ${workflow}: ${commandFailureMessage(result, 'unknown error')}`);
    }
  }
  return { command: action, campaigns, workflows };
}
