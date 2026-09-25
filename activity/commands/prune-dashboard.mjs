export function runPruneDashboard({ options, pruneDashboardFile, option, rejectUnknownOptions }) {
  rejectUnknownOptions(options, ["input", "output"]);
  return pruneDashboardFile({
    inputPath: option(options, "input"),
    outputPath: option(options, "output", false),
  });
}
