export function runAdd({ arguments_, addCaoCampaign, UsageError }) {
  if (arguments_.some((argument) => argument === '--repository' || argument.startsWith('--repository='))) {
    throw new UsageError('Repository enrollment requires gh cao repos add OWNER/REPO; Node cao add --repository is no longer supported.');
  }
  return addCaoCampaign(arguments_[0], arguments_.slice(1));
}
