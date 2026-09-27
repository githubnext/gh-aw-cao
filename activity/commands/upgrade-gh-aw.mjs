export function runUpgradeGhAw({ arguments_, upgradeGhAw, UsageError }) {
  if (arguments_.length !== 1) {
    throw new UsageError("cao upgrade-gh-aw requires exactly one VERSION");
  }
  return upgradeGhAw(arguments_[0]);
}
