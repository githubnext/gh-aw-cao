export function runMode({ arguments_, input, setCaoCampaignMode }) {
  return setCaoCampaignMode(arguments_[0], arguments_.slice(1), { input });
}
