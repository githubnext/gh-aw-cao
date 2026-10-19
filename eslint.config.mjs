import noHardcodedGitHubActionsUrl from "./eslint-rules/no-hardcoded-github-actions-url.mjs";

export default [
  {
    ignores: [
      ".cao-dashboard-preview-*/**",
      "dashboard/site/**",
      "node_modules/**",
      "test-results/**",
      "tests/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: {
      cao: {
        rules: {
          "no-hardcoded-github-actions-url": noHardcodedGitHubActionsUrl,
        },
      },
    },
    rules: {
      "cao/no-hardcoded-github-actions-url": "error",
    },
  },
  {
    // Preserve the frozen native fixture URL; this module does not construct runtime Actions destinations.
    files: ["docs/operational-value/proof/functions/workflow-normalizer.mjs"],
    rules: { "cao/no-hardcoded-github-actions-url": "off" },
  },
];
