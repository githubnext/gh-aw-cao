import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { parsePolicy } from '../../.github/workflows/shared/policy.mjs';
import { DEFAULT_POLICY_PATH } from './policy.mjs';
import { commandFailureMessage, writeJsonAtomically } from './files.mjs';
import { UsageError } from './options.mjs';

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

export async function addCaoRepository(repository, {
  policyPath = DEFAULT_POLICY_PATH, execute = spawnSync,
} = {}) {
  if (typeof repository !== 'string' || repository.length > 200 || !repositoryPattern.test(repository)) {
    throw new UsageError('cao add --repository requires an exact OWNER/REPO');
  }
  let policy;
  try { policy = parsePolicy(await readFile(policyPath, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${policyPath} is required for repository enrollment`);
    throw error;
  }
  const control = policy['control-plane'];
  const scope = control?.scope;
  if (!Array.isArray(scope?.['allowed-repositories']) || !Array.isArray(scope?.['allowed-owners'])) {
    throw new Error('Repository enrollment requires explicit allowed-owners and allowed-repositories policy; broad discovery scope is not rewritten.');
  }
  const result = execute('gh', ['repo', 'view', repository, '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`Repository access could not be verified: ${commandFailureMessage(result, 'gh repo view failed')}`);
  }
  const canonical = String(result.stdout ?? '').trim();
  if (!repositoryPattern.test(canonical) || canonical.toLowerCase() !== repository.toLowerCase()) {
    throw new Error('Repository lookup did not resolve the exact requested repository.');
  }
  const alreadyEnrolled = scope['allowed-repositories'].some((value) => value.toLowerCase() === canonical.toLowerCase());
  if (!alreadyEnrolled) {
    scope['allowed-repositories'].push(canonical);
    const owner = canonical.split('/')[0];
    if (!scope['allowed-owners'].some((value) => value.toLowerCase() === owner.toLowerCase())) scope['allowed-owners'].push(owner);
    for (const campaign of Object.values(control.campaigns ?? {})) {
      // Never let an existing live campaign/default
      // silently promote a newly enrolled repository.
      campaign.targets ??= {};
      campaign.targets[canonical] = { mode: 'review' };
    }
    parsePolicy(JSON.stringify(policy));
    await writeJsonAtomically(policyPath, policy);
  }
  return {
    command: 'add', repository: canonical, policy: policyPath, alreadyEnrolled,
    message: alreadyEnrolled ? 'Repository is already enrolled; existing policy was preserved.'
      : 'Repository staged in review mode. Review, commit, and push the policy change before activation. Configure credential access separately; explicit Activity scope is unchanged.',
  };
}
