#!/usr/bin/env node

import { run } from "./common.mjs";

const output = JSON.parse(run(new URL("./extract-workflow-intent.mjs", import.meta.url).pathname, process.argv.slice(2)));
console.log("# Workflow adoption");
console.log(JSON.stringify(output.adoption, null, 2));
console.log(`\n# Workflow instructions at adoption: ${output.workflowPath}`);
console.log(`${output.intentSources.frontmatter ? `---\n${output.intentSources.frontmatter}\n---\n` : ""}${output.intentSources.instructions}`);
console.log(`\n# Compiled workflow at adoption: ${output.lockPath}`);
console.log(output.intentSources.compiledWorkflow);
