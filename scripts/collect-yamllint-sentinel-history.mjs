import { collectLintHistory, lintScopes } from "./collect-lint-native-history.mjs";

// One fixed self-output sentinel is a bounded partial facet, not the generated fleet.
lintScopes["daily-yamllint-fixer"].paths = [".github/workflows/daily-yamllint-fixer.lock.yml"];
collectLintHistory("daily-yamllint-fixer", process.argv[2]);
