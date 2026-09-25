export function runAdd({ arguments_, addCaoCampaign }) {
  return addCaoCampaign(arguments_[0], arguments_.slice(1));
}
