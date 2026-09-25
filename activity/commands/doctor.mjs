export function runDoctor({
  options,
  databasePath,
  doctorSqliteDatabase,
  ttlDays,
  runTtlDays,
  rejectUnknownOptions,
}) {
  rejectUnknownOptions(options, ["database", "ttl-days", "run-ttl-days"]);
  return doctorSqliteDatabase(databasePath, {
    ttlDays: ttlDays(options),
    runTtlDays: runTtlDays(options),
  });
}
