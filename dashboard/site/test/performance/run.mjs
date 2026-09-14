import { spawn } from 'node:child_process';

function run(script) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${script} exited with signal ${signal}`));
        return;
      }
      resolvePromise(code ?? 1);
    });
  });
}

const lighthouseStatus = await run('./test/performance/lighthouse.mjs');
if (![0, 42].includes(lighthouseStatus)) {
  process.exitCode = lighthouseStatus;
} else {
  const swimlaneStatus = await run('./test/performance/swimlane.mjs');
  process.exitCode = swimlaneStatus === 0 ? lighthouseStatus : swimlaneStatus;
}
