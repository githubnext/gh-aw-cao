import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  ArchivingReader, MetricCache, ObjectStore, contract, createCapture,
  fullMetric, replayCapture,
} from './value-graph-model.mjs';

const lines = count => 'line\n'.repeat(count);
const rule = contract();
const output = new URL('./value-graph-study.json', import.meta.url);

if (process.argv.includes('--replay')) {
  const saved = JSON.parse(await readFile(output, 'utf8'));
  const archive = new ObjectStore();
  for (const [id, object] of saved.replayFixture.objects) {
    if (archive.put(object.type, object.value) !== id) throw new Error('Retained object integrity failure');
  }
  const reproduced = replayCapture(saved.replayFixture.capture, archive);
  console.log(JSON.stringify({
    mode: 'offline-replay', effectiveAt: reproduced.measurement.effectiveAt,
    observedAt: reproduced.observedAt, reductions: reproduced.measurement.reductions,
    implementation: reproduced.implementation,
  }, null, 2));
} else {
const scenarios = [];
for (const layout of ['nested-localized', 'nested-spread', 'flat-localized', 'nested-all-directories']) {
  const source = new ObjectStore();
  const files = {};
  const flatLayout = layout.startsWith('flat');
  const directories = flatLayout ? 1 : 1000;
  const perDirectory = 100000 / directories;
  const pathFor = (directory, file) => flatLayout ? `src/file-${file}.js` : `src/group-${directory}/file-${file}.js`;
  for (let directory = 0; directory < directories; directory++) {
    for (let file = 0; file < perDirectory; file++) files[pathFor(directory, file)] = `file ${directory}/${file}\n${lines(7)}`;
  }
  const baseline = source.snapshot(files);
  const flat = new MetricCache(source, { subtreeReuse: false });
  const pruned = new MetricCache(source);
  assert.deepEqual(flat.measure(baseline, rule), pruned.measure(baseline, rule));
  const edits = layout === 'nested-all-directories' ? 1000 : 12;
  for (let edit = 0; edit < edits; edit++) {
    const spread = layout === 'nested-spread' || layout === 'nested-all-directories';
    files[pathFor(spread ? edit : 0, spread ? 0 : edit)] = lines(11 + edit % 3);
  }
  const changed = source.snapshot(files, baseline);
  flat.resetStats();
  pruned.resetStats();
  const flatResult = flat.measure(changed, rule);
  const prunedResult = pruned.measure(changed, rule);
  assert.deepEqual(prunedResult, flatResult);
  assert.deepEqual(prunedResult, fullMetric(source, changed, rule));
  assert.equal(prunedResult.oversized, edits);
  assert.equal(flat.stats.blobMeasurements, 3);
  assert.equal(pruned.stats.blobMeasurements, 3);
  assert.ok(pruned.stats.treeEntries <= flat.stats.treeEntries);
  scenarios.push({
    layout, eligibleFiles: 100000, baselineDistinctBlobs: 100000,
    directories, modifiedPaths: edits, distinctNewBlobs: 3,
    result: prunedResult,
    flatInventoryWithBlobCache: flat.stats,
    subtreeReuseWithBlobCache: pruned.stats,
  });
}

const smallSource = new ObjectStore();
const archive = new ObjectStore();
const metric = new MetricCache(new ArchivingReader(smallSource, archive));
const proposal = smallSource.snapshot({ 'src/a.js': lines(15), 'src/b.js': lines(15) });
const actualParent = smallSource.snapshot({ 'src/a.js': lines(15), 'src/b.js': lines(3) }, proposal);
const merged = smallSource.snapshot({ 'src/a.js': lines(3), 'src/b.js': lines(3) }, actualParent);
const question = { kind: 'merge-change', subject: 'pr-1' };
const baseEvidence = {
  repository: rule.repository, targetRef: rule.targetRef, subject: question.subject, coverage: 'complete',
  outputLinks: ['native-output-a', 'native-output-b'],
  boundary: { kind: 'first-parent', basis: 'verified-squash' },
};
const captures = [
  createCapture({ rule, metric, question, observedAt: 0, evidence: { ...baseEvidence, state: 'open', observedAt: 0 } }),
  createCapture({
    rule, metric, question, observedAt: 60,
    evidence: { ...baseEvidence, state: 'merged', acceptedAt: 60, observedAt: 60, revision: merged },
  }),
  createCapture({
    rule, metric, question, observedAt: 67,
    evidence: { ...baseEvidence, state: 'merged', acceptedAt: 60, observedAt: 67, revision: merged },
  }),
];
smallSource.enabled = false;
assert.deepEqual(replayCapture(captures[2], archive), captures[2]);
const modelBytes = await readFile(new URL('./value-graph-model.mjs', import.meta.url));
const report = {
  scope: 'Synthetic executable design study; not production performance, API cost, or a security proof.',
  modelSha256: createHash('sha256').update(modelBytes).digest('hex'),
  nodeVersion: process.version,
  metric: 'Count eligible synthetic .js files with more than 10 lines; not a replacement for the storyboard contract.',
  scenarios,
  limits: [
    'Both strategies already cache blobs; subtree reuse can save metadata traversal and occurrence evaluation, not extra blob reads in these cases.',
    'Logical operation counts only; no GitHub API calls, network timing or real repository benchmark.',
    'Flat or widely changed trees require broad traversal. The pruned fold examines no more tree entries than the baseline in these fixtures, but cache lookup overhead remains unbenchmarked.',
    'The model assumes already-verified source facts and atomic in-process coordination; production adapters and distributed races are not validated here.',
    'Verified merge/squash integration can use the first parent. Rebase or grouped integration requires a verified before/after boundary; a current PR base or final commit parent is not a substitute.',
    'The model archives immutable fixture inputs. It does not implement enterprise storage, retention, the canonical packet schema, or forecast fitting.',
  ],
  designCorrections: [
    'Native outputs are evidence, not automatic acceptance watches; explicitly declared questions determine follow-up.',
    'Independent per-question deadlines prevent lifecycle updates, missing evidence, and late repairs from postponing the repository cadence.',
    'Event time, capture time, and first publication availability are distinct; late publication cannot backfill a historical forecasting view.',
    'Completed immutable questions retire their timers. Zero and negative results remain; pending or unavailable results are not zero.',
    'Changed-tree folding replaced old/new tree subtraction to avoid doubled metadata traversal for flat layouts.',
    'Dirty-key overflow becomes a full-scope invalidation; it does not drop the newest changes.',
    'Shared integration facts have one identity, while several output or PR links can refer to them.',
  ],
  delayedMerge: captures.map(capture => ({
    observedAt: capture.observedAt,
    domainState: capture.gate.domainState,
    readiness: capture.gate.readiness,
    nextDue: capture.gate.nextDue,
    measurement: capture.measurement,
  })),
  offlineReplay: { originalObservedAt: captures[2].observedAt, preserved: true, liveSourceEnabled: smallSource.enabled },
  replayFixture: { capture: captures[2], objects: [...archive.objects] },
};
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
const { replayFixture, ...summary } = report;
console.log(JSON.stringify(summary, null, 2));
}
