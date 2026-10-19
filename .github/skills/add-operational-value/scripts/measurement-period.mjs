function timestamp(value) {
  if (typeof value !== "string") return null;
  const parts = /^([0-9]{4})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$/.exec(value);
  if (!parts) return null;
  const year = Number(parts[1]), month = Number(parts[2]), day = Number(parts[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (year === 0 || day > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function operationalValuePeriod(record, observedAt, field) {
  const metadata = {};
  const required = ["windowStart", "windowEnd", "measurementKind", "coverageStatus"];
  if (required.some(key => Object.hasOwn(record, key))) {
    const start = timestamp(record.windowStart), end = timestamp(record.windowEnd);
    if (start === null || end === null) {
      throw new TypeError(`${field} must contain valid RFC 3339 measurement timestamps`);
    }
    if (Date.parse(start) >= Date.parse(end) || Date.parse(end) > Date.parse(observedAt)
      || !["interval", "snapshot"].includes(record.measurementKind)
      || !["complete", "partial", "missing", "unknown"].includes(record.coverageStatus)) {
      throw new TypeError(`${field} must contain a valid measurement period and coverage`);
    }
    Object.assign(metadata, { windowStart: start, windowEnd: end,
      measurementKind: record.measurementKind, coverageStatus: record.coverageStatus });
  }
  for (const key of ["populationDigest", "evidenceDigest"]) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
      throw new TypeError(`${field}.${key} must be a SHA-256 fingerprint`);
    }
    metadata[key] = value;
  }
  if (Object.hasOwn(record, "eligibleCount")) {
    const count = record.eligibleCount;
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new TypeError(`${field}.eligibleCount must be a non-negative safe integer`);
    }
    metadata.eligibleCount = count;
  }
  if (Object.hasOwn(record, "missingReason")) {
    if (typeof record.missingReason !== "string" || !record.missingReason.trim()) {
      throw new TypeError(`${field}.missingReason is required`);
    }
    metadata.missingReason = record.missingReason.trim();
  }
  return metadata;
}
