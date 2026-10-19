const NativeDate = Date;
const renderEpoch = NativeDate.parse("2026-10-19T13:51:00Z");

// Pin an observed report-generation epoch, not a historical observation.
globalThis.Date = class extends NativeDate {
  constructor(...args) {
    super(...(args.length ? args : [renderEpoch]));
  }

  static now() {
    return renderEpoch;
  }
};
