import {
  dashboardFormDefaultValues,
  resolveDashboardQueryParameters,
} from "../../dashboard/site/src/data/queries/view-payload-compiler.js";

export function dashboardBenchmarkQueries(dashboard) {
  const defaults = {};
  for (const page of dashboard.pages ?? []) {
    const form = page.kind === "built-in" ? page.definition?.form : page.form;
    for (const [name, value] of Object.entries(dashboardFormDefaultValues(form))) {
      if (Object.hasOwn(defaults, name) && defaults[name] !== value) {
        throw new TypeError(`Dashboard benchmark parameter "${name}" has conflicting form defaults.`);
      }
      defaults[name] = value;
    }
  }
  return resolveDashboardQueryParameters(dashboard.queries, defaults);
}
