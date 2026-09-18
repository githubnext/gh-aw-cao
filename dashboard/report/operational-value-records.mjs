export function hasOperationalValueResult(record) {
  return record?.resultAvailable === true
    || Boolean(record?.evaluatorDigest || record?.observation);
}
