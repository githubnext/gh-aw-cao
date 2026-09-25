export function runClusterProblems({
  options,
  databasePath,
  signal,
  runProblemClustering,
  option,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["database", "root", "timestamp"]);
  return runProblemClustering({
    databasePath,
    root: option(options, "root", false) || ".",
    timestamp: option(options, "timestamp", false) || new Date().toISOString(),
    signal,
  });
}
