import { performance } from 'node:perf_hooks';
import { stdin, stdout } from 'node:process';
import { computeDoesItRunPortfolio } from './does-it-run.js';

let input = '';
stdin.setEncoding('utf8');
for await (const chunk of stdin) input += chunk;

const request = JSON.parse(input);
const iterations = Number.isInteger(request.benchmarkIterations) && request.benchmarkIterations > 0
  ? request.benchmarkIterations
  : 1;
const durations = [];
let result;
for (let index = 0; index < iterations; index += 1) {
  const startedAt = performance.now();
  result = computeDoesItRunPortfolio(request);
  durations.push(performance.now() - startedAt);
}
durations.sort((left, right) => left - right);

stdout.write(JSON.stringify({
  result,
  benchmark: {
    iterations,
    medianMilliseconds: durations[Math.floor(durations.length / 2)],
    minimumMilliseconds: durations[0],
    maximumMilliseconds: durations.at(-1)
  }
}));
