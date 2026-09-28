export function runDownload({ options, downloadDeployedDashboardData, option, rejectUnknownOptions }) {
  rejectUnknownOptions(options, ["url", "output", "manifest-sha256"]);
  return downloadDeployedDashboardData({
    url: option(options, "url", false),
    output: option(options, "output", false),
    manifestSha256: option(options, "manifest-sha256", false),
  });
}
