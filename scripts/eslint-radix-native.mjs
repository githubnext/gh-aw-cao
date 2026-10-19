import { createRequire } from "node:module";
import { Linter } from "eslint";

const require = createRequire(import.meta.url);
export const eslintVersion = require("eslint/package.json").version;
if (eslintVersion !== "9.39.5") throw new Error("Frozen ESLint toolchain changed");
const linter = new Linter();

export function radixFacts(content) {
  const diagnostics = linter.verify(content, {
    languageOptions: { ecmaVersion: "latest", sourceType: "commonjs" },
    rules: { radix: ["error", "always"] },
  });
  if (diagnostics.some(row => row.fatal)) return { syntaxValid: false, defects: null };
  return { syntaxValid: true,
    defects: diagnostics.filter(row => row.ruleId === "radix" && row.messageId === "missingRadix").length };
}
