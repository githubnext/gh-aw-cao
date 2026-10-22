import { runTerminal } from "./terminal.mjs";

const [cwd, serializedSteps] = process.argv.slice(2);
const steps = JSON.parse(serializedSteps);
let step = 0;
let consumed = 0;
const result = await runTerminal("gh", ["cao", "setup", "--json"], {
  cwd,
  env: { ...process.env, CI: "", GH_PROMPT_DISABLED: "", TERM: "dumb" },
  timeout: 45_000,
  onOutput(output, write) {
    const next = steps[step];
    const position = next ? output.indexOf(next[0], consumed) : -1;
    if (position !== -1) {
      consumed = position + next[0].length;
      step += 1;
      write(`${next[1]}\n`);
    }
  },
});
console.log(JSON.stringify({ ...result, answered: step, expected: steps.length }));
