export function runDiscoverWorkflows({ options, discoverWorkflows, option, rejectUnknownOptions }) {
  rejectUnknownOptions(options, ["root", "control-settings", "inventory", "output", "repo"]);
  return discoverWorkflows({
    root: option(options, "root", false) || ".",
    controlSettingsPath: option(options, "control-settings"),
    inventoryPath: option(options, "inventory"),
    outputPath: option(options, "output"),
    repository: option(options, "repo"),
  });
}
