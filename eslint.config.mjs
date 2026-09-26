import noHardcodedGitHubActionsUrl from "./eslint-rules/no-hardcoded-github-actions-url.mjs";

export default [
  {
    ignores: [
      "dashboard/site/**",
      ".tmp/**",
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
];
