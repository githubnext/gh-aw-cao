import { performance } from 'node:perf_hooks';
import { stdin, stdout } from 'node:process';
import { computeHowWellPortfolio } from './how-well-does-it-run.js';

let input = '';
stdin.setEncoding('utf8');
for await (const chunk of stdin) input += chunk;

const request = JSON.parse(input);
const startedAt = performance.now();
const result = computeHowWellPortfolio(request);
stdout.write(JSON.stringify({
  result,
  benchmark: { milliseconds: performance.now() - startedAt }
}));
