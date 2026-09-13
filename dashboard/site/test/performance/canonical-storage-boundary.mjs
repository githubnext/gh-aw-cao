import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const siteRoot = resolve(import.meta.dirname, '../..');
const outputRoot = resolve(
  process.env.DASHBOARD_STORAGE_BOUNDARY_OUTPUT_DIR
    || join(siteRoot, 'test-results', 'storage-performance-boundary')
);
const scales = (process.env.DASHBOARD_STORAGE_BOUNDARY_SCALES || '0.01,0.02,0.04,0.06,0.08,0.1,0.105,0.11,0.12')
  .split(',')
  .map(Number)
  .sort((left, right) => left - right);
const budgetMs = 10_000;

if (scales.length < 2 || scales.some((scale) => !Number.isFinite(scale) || scale <= 0 || scale > 1)) {
  throw new Error('DASHBOARD_STORAGE_BOUNDARY_SCALES must contain at least two comma-separated values between 0 and 1.');
}

function totalRecords(corpus) {
  return Object.values(corpus).reduce((total, count) => total + Number(count), 0);
}

function boundaryPoint(points) {
  const above = points.findIndex((point) => point.coldReplaceMs >= budgetMs);
  if (above < 1) return null;
  const lower = points[above - 1];
  const upper = points[above];
  const ratio = (budgetMs - lower.coldReplaceMs) / (upper.coldReplaceMs - lower.coldReplaceMs);
  return Math.round(lower.totalRecords + ratio * (upper.totalRecords - lower.totalRecords));
}

function evaluationPoint(points) {
  const above = points.findIndex((point) => point.coldReplaceMs >= budgetMs);
  return above > 0 ? points[above - 1].totalRecords : null;
}

function chart(points, crossing) {
  const width = 960;
  const height = 560;
  const margin = { top: 48, right: 48, bottom: 72, left: 88 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maxRecords = Math.max(...points.map((point) => point.totalRecords));
  const maxMs = Math.max(budgetMs * 1.15, ...points.map((point) => point.coldReplaceMs)) * 1.08;
  const x = (records) => margin.left + (records / maxRecords) * plotWidth;
  const y = (milliseconds) => margin.top + plotHeight - (milliseconds / maxMs) * plotHeight;
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${x(point.totalRecords).toFixed(1)} ${y(point.coldReplaceMs).toFixed(1)}`).join(' ');
  const xTicks = Array.from({ length: 6 }, (_, index) => Math.round(maxRecords * index / 5));
  const yTicks = Array.from({ length: 6 }, (_, index) => Math.round(maxMs * index / 5));
  const crossingX = crossing === null ? null : x(crossing);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">IndexedDB cold replacement boundary</title>
  <description id="description">Measured cold replacement latency by canonical record count, with a ten second storage contract boundary.</description>
  <rect width="${width}" height="${height}" fill="#ffffff"/>
  <text x="${margin.left}" y="28" font-family="sans-serif" font-size="20" font-weight="700" fill="#1f2328">IndexedDB cold replacement boundary</text>
  <rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${y(budgetMs) - margin.top}" fill="#ffebe9"/>
  <rect x="${margin.left}" y="${y(budgetMs)}" width="${plotWidth}" height="${margin.top + plotHeight - y(budgetMs)}" fill="#dafbe1"/>
  ${yTicks.map((tick) => `<line x1="${margin.left}" y1="${y(tick)}" x2="${margin.left + plotWidth}" y2="${y(tick)}" stroke="#d0d7de"/><text x="${margin.left - 12}" y="${y(tick) + 5}" text-anchor="end" font-family="sans-serif" font-size="12" fill="#57606a">${(tick / 1000).toFixed(1)}s</text>`).join('\n  ')}
  ${xTicks.map((tick) => `<line x1="${x(tick)}" y1="${margin.top}" x2="${x(tick)}" y2="${margin.top + plotHeight}" stroke="#d8dee4"/><text x="${x(tick)}" y="${margin.top + plotHeight + 24}" text-anchor="middle" font-family="sans-serif" font-size="12" fill="#57606a">${tick.toLocaleString('en-US')}</text>`).join('\n  ')}
  <line x1="${margin.left}" y1="${y(budgetMs)}" x2="${margin.left + plotWidth}" y2="${y(budgetMs)}" stroke="#cf222e" stroke-width="2" stroke-dasharray="8 5"/>
  <text x="${margin.left + plotWidth - 8}" y="${y(budgetMs) - 9}" text-anchor="end" font-family="sans-serif" font-size="13" font-weight="700" fill="#a40e26">10-second SLO</text>
  <path d="${path}" fill="none" stroke="#0969da" stroke-width="3"/>
  ${points.map((point) => `<circle cx="${x(point.totalRecords)}" cy="${y(point.coldReplaceMs)}" r="5" fill="#0969da"/><text x="${x(point.totalRecords)}" y="${y(point.coldReplaceMs) - 11}" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#24292f">${(point.coldReplaceMs / 1000).toFixed(2)}s</text>`).join('\n  ')}
  ${crossingX === null ? '' : `<line x1="${crossingX}" y1="${margin.top}" x2="${crossingX}" y2="${margin.top + plotHeight}" stroke="#8250df" stroke-width="2" stroke-dasharray="5 5"/><text x="${crossingX - 8}" y="${margin.top + 18}" text-anchor="end" font-family="sans-serif" font-size="13" font-weight="700" fill="#6639ba">Measured crossing ~${crossing.toLocaleString('en-US')} records</text>`}
  <text x="${margin.left + plotWidth / 2}" y="${height - 20}" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#24292f">Total canonical records</text>
  <text x="22" y="${margin.top + plotHeight / 2}" transform="rotate(-90 22 ${margin.top + plotHeight / 2})" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#24292f">Cold replacement latency</text>
</svg>
`;
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const points = [];
for (const scale of scales) {
  const pointOutput = join(outputRoot, `scale-${scale}`);
  try {
    await execFileAsync(process.execPath, ['./test/performance/canonical-storage.mjs'], {
      cwd: siteRoot,
      env: {
        ...process.env,
        DASHBOARD_STORAGE_PERFORMANCE_PROFILE: 'contract',
        DASHBOARD_STORAGE_PERFORMANCE_CORPUS_SCALE: String(scale),
        DASHBOARD_STORAGE_PERFORMANCE_MEASUREMENT_TIMEOUT_MS: '120000',
        DASHBOARD_STORAGE_PERFORMANCE_OUTPUT_DIR: pointOutput
      },
      maxBuffer: 1024 * 1024
    });
  } catch (error) {
    if (error?.code !== 42) throw error;
  }
  const summary = JSON.parse(await readFile(join(pointOutput, 'summary.json'), 'utf8'));
  if (!Number.isFinite(summary.metrics?.coldReplaceMs)) throw new Error(`Scale ${scale} did not produce a cold replacement measurement.`);
  points.push({
    scale,
    corpus: summary.corpus,
    totalRecords: totalRecords(summary.corpus),
    coldReplaceMs: summary.metrics.coldReplaceMs
  });
  console.log(`Scale ${scale}: ${points.at(-1).totalRecords} records in ${points.at(-1).coldReplaceMs.toFixed(2)} ms`);
}

const crossing = boundaryPoint(points);
const evaluationRecords = evaluationPoint(points);
const verdict = 'KEEP_INDEXEDDB';
const nextAction = crossing === null ? 'NONE' : 'EVALUATE_SQLITE_WASM';
const evidence = {
  generatedAt: new Date().toISOString(),
  budgetMs,
  crossingRecords: crossing,
  evaluationRecords,
  verdict,
  nextAction,
  decision: crossing === null
    ? 'Keep IndexedDB; the measured range does not cross the cold replacement budget.'
    : `IndexedDB cold replacement crosses the measured SLO at approximately ${crossing.toLocaleString('en-US')} canonical records; begin SQLite-WASM evaluation by ${evaluationRecords.toLocaleString('en-US')} records. This benchmark does not compare storage engines.`,
  points
};
await Promise.all([
  writeFile(join(outputRoot, 'summary.json'), `${JSON.stringify(evidence, null, 2)}\n`),
  writeFile(join(outputRoot, 'boundary.svg'), chart(points, crossing))
]);
console.log(`Boundary evidence: ${outputRoot}`);
console.log('');
console.log('=== STORAGE ENGINE VERDICT ===');
console.log(`VERDICT: ${verdict}`);
console.log(`NEXT_ACTION: ${nextAction}`);
console.log(`RATIONALE: ${evidence.decision}`);