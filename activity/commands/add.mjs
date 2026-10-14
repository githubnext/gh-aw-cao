export function runAdd({ arguments_, addCaoCampaign, addCaoRepository, UsageError }) {
  if (arguments_[0] === '--repository') {
    if (arguments_.length !== 2) throw new UsageError('cao add --repository requires exactly one OWNER/REPO');
    return addCaoRepository(arguments_[1]);
  }
  return addCaoCampaign(arguments_[0], arguments_.slice(1));
}
