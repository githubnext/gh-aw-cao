export function runMode({ arguments_, setCaoCampaignMode }) {
  return setCaoCampaignMode(arguments_[0], arguments_.slice(1));
}
