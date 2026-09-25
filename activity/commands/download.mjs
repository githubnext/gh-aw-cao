export function runDownload({ options, downloadDeployedDashboardData, option, rejectUnknownOptions }) {
  rejectUnknownOptions(options, ["url", "output"]);
  return downloadDeployedDashboardData({
    url: option(options, "url", false),
    output: option(options, "output", false),
  });
}
