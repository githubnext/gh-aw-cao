import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ArchivingReader, CaptureJournal, CollectionJob, DependencyIndex, EVALUATOR, IMPLEMENTATION,
  GenerationQueue, MetricCache, ObjectStore, QuestionRegistry, contract,
  advanceDeadlines, createCapture, digest, dueCutoffs, fullMetric, readiness, replayCapture, timerKey,
} from './value-graph-model.mjs';

const lines = count => 'line\n'.repeat(count);
const condition = cutoff => ({ kind: 'repository-condition', cutoff });
const contribution = subject => ({ kind: 'merge-change', subject });
const snapshotEvidence = (revision, cutoff, observedAt = cutoff) => ({
  repository: 'example/repo', targetRef: 'refs/heads/main', coverage: 'complete', revision, cutoff, observedAt,
});
const pullEvidence = (subject, state, observedAt, extra = {}) => ({
  repository: 'example/repo', targetRef: 'refs/heads/main', coverage: 'complete', subject, state, observedAt,
  outputLinks: ['native-output-1'],
  boundary: { kind: 'first-parent', basis: 'verified-squash' },
  ...extra,
});

function setup(rule = contract()) {
  const source = new ObjectStore();
  const archive = new ObjectStore();
  const metric = new MetricCache(new ArchivingReader(source, archive));
  return { source, archive, metric, rule };
}

function record(fixture, question, evidence, observedAt) {
  return createCapture({ ...fixture, question, evidence, observedAt });
}

test('native outputs do not automatically become acceptance watches', () => {
  const registry = new QuestionRegistry();
  for (const kind of ['comment', 'noop', 'label', 'issue', 'pull-request']) {
    registry.recordNativeOutput({ id: kind, type: kind, nativeEvidence: 'fixture-only' });
  }
  assert.equal(registry.nativeOutputs.size, 5);
  assert.equal(registry.questions.size, 0);
  registry.register(contract(), contribution('pr-1'));
  registry.register(contract(), contribution('pr-1'));
  assert.equal(registry.questions.size, 1);
});

test('same contract version cannot change its frozen definition', () => {
  const registry = new QuestionRegistry();
  registry.register(contract(), condition(0));
  assert.throws(() => registry.register(contract({ threshold: 20 }), condition(0)), /Frozen contract/);
  registry.register(contract({ version: 2, threshold: 20 }), condition(0));
  assert.equal(registry.questions.size, 2);
});

test('new objects invalidate a discovery root even before their IDs are known', () => {
  const index = new DependencyIndex();
  index.subscribe('lineage-query', ['discovery:example/repo:pulls']);
  index.subscribe('condition', ['ref:example/repo:main']);
  index.subscribe('known-pr', ['pr:123']);
  assert.deepEqual(index.affected(['pr:new', 'discovery:example/repo:pulls']), ['lineage-query']);
  assert.deepEqual(index.affected(['comment:unrelated']), []);
  assert.deepEqual(index.affected(['ref:example/repo:main', 'pr:123']), ['condition', 'known-pr']);
});

test('duplicate blobs are measured once and counted per eligible occurrence', () => {
  const f = setup();
  const revision = f.source.snapshot({
    'src/a.js': lines(11), 'src/b.js': lines(11), 'src/c.js': lines(10),
    'src/ignored.test.js': lines(11), 'docs/example.js': lines(11),
  });
  assert.deepEqual(f.metric.measure(revision, f.rule), { oversized: 2, eligible: 3 });
  assert.equal(f.metric.stats.blobMeasurements, 2);
  assert.deepEqual(f.metric.measure(revision, f.rule), fullMetric(f.source, revision, f.rule));
});

test('cached aggregates handle edits, deletion, copies and eligibility-changing renames', () => {
  const f = setup();
  const states = [
    { 'src/a.js': lines(15), 'src/b.js': lines(3), 'docs/c.js': lines(20) },
    { 'src/a.test.js': lines(15), 'src/b.js': lines(3), 'docs/c.js': lines(20) },
    { 'src/b.js': lines(3), 'src/c.js': lines(20) },
    { 'src/b.js': lines(3), 'src/c.js': lines(20), 'src/copy.js': lines(20) },
    { 'src/b.js': '', 'src/c.js': 'one line without a newline' },
    {},
  ];
  let previous = null;
  for (const files of states) {
    const revision = f.source.snapshot(files, previous);
    assert.deepEqual(f.metric.measure(revision, f.rule), fullMetric(f.source, revision, f.rule));
    previous = revision;
  }
});

for (const seed of [1, 17, 413, 2026]) {
  test(`incremental/full equivalence across 250 deterministic mutations, seed ${seed}`, () => {
    const f = setup();
    let randomState = seed;
    const random = max => {
      randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
      return randomState % max;
    };
    const paths = Array.from({ length: 20 }, (_, i) =>
      `${i % 4 === 0 ? 'docs' : 'src'}/group-${i % 3}/f-${i}${i % 5 === 0 ? '.test' : ''}.js`);
    const files = {};
    let previous = null;
    for (let step = 0; step < 250; step++) {
      const path = paths[random(paths.length)];
      const operation = random(5);
      if (operation < 3) files[path] = lines(random(22));
      else if (operation === 3) delete files[path];
      else {
        const from = paths[random(paths.length)];
        if (Object.hasOwn(files, from) && from !== path) {
          files[path] = files[from];
          delete files[from];
        }
      }
      const revision = f.source.snapshot(files, previous);
      assert.deepEqual(f.metric.measure(revision, f.rule), fullMetric(f.source, revision, f.rule));
      previous = revision;
    }
  });
}

test('a changed recipe cannot reuse an old aggregate', () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15), 'docs/a.js': lines(25) });
  assert.equal(f.metric.measure(revision, f.rule).oversized, 1);
  const nextRule = contract({ version: 2, threshold: 20 });
  assert.deepEqual(f.metric.measure(revision, nextRule), { oversized: 0, eligible: 1 });
  const movedScope = contract({ version: 3, prefix: 'docs/', threshold: 20 });
  assert.deepEqual(f.metric.measure(revision, movedScope), { oversized: 1, eligible: 1 });
});

test('irrelevant content changes reuse the eligible subtree but still produce a new observation', () => {
  const f = setup();
  const before = f.source.snapshot({ 'src/a.js': lines(15), 'docs/readme.txt': 'old' });
  const first = record(f, condition(0), snapshotEvidence(before, 0), 0);
  const after = f.source.snapshot({ 'src/a.js': lines(15), 'docs/readme.txt': 'new' }, before);
  f.metric.resetStats();
  const second = record(f, condition(10), snapshotEvidence(after, 10), 10);
  assert.equal(f.metric.stats.blobMeasurements, 0);
  assert.equal(first.measurement.oversized, second.measurement.oversized);
  assert.notEqual(first.measurement.id, second.measurement.id);
  assert.equal(second.measurement.effectiveAt, 10);
  assert.equal(second.observedAt, 10);
});

test('human delay leaves a dormant question without reading Git content', () => {
  const f = setup();
  for (const now of [0, 30, 60, 90, 180]) {
    const capture = record(f, contribution('pr-1'), pullEvidence('pr-1', 'open', now), now);
    assert.equal(capture.gate.readiness, 'waiting');
    assert.equal(capture.measurement, null);
    assert.equal(capture.gate.nextDue, now + 30);
  }
  assert.equal(f.source.reads, 0);
  assert.equal(f.metric.stats.blobMeasurements, 0);
});

test('maturation is anchored at actual acceptance, not proposal or discovery time', () => {
  const f = setup();
  const parent = f.source.snapshot({ 'src/a.js': lines(15) });
  const merged = f.source.snapshot({ 'src/a.js': lines(3) }, parent);
  const pending = record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 60, { revision: merged, acceptedAt: 60 }), 60);
  assert.equal(pending.gate.readiness, 'waiting');
  assert.equal(pending.gate.nextDue, 67);
  assert.equal(pending.measurement, null);
  const mature = record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 67, { revision: merged, acceptedAt: 60 }), 67);
  assert.equal(mature.measurement.reductions, 1);
  assert.equal(mature.measurement.effectiveAt, 60);
  assert.equal(mature.observedAt, 67);
});

test('the before state is the actual first parent, not the original proposal baseline', () => {
  const f = setup();
  const proposal = f.source.snapshot({ 'src/a.js': lines(15), 'src/b.js': lines(15) });
  const intervening = f.source.snapshot({ 'src/a.js': lines(15), 'src/b.js': lines(3) }, proposal);
  const mergedTree = f.source.read(f.source.snapshot({ 'src/a.js': lines(3), 'src/b.js': lines(3) }), 'commit').tree;
  const merged = f.source.put('commit', { tree: mergedTree, parents: [intervening, proposal] });
  const capture = record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 67, {
      revision: merged, acceptedAt: 60, proposalRevision: proposal,
      boundary: { kind: 'first-parent', basis: 'verified-merge' },
    }), 67);
  assert.equal(capture.measurement.beforeRevision, intervening);
  assert.equal(capture.measurement.reductions, 1);
});

test('multiple output links do not multiply an implementation measurement', () => {
  const f = setup();
  const before = f.source.snapshot({ 'src/a.js': lines(15) });
  const merged = f.source.snapshot({ 'src/a.js': lines(3) }, before);
  const single = record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 67, { revision: merged, acceptedAt: 60 }), 67);
  const multiple = record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 68, { revision: merged, acceptedAt: 60, outputLinks: ['output-a', 'output-b', 'output-c'] }), 68);
  assert.equal(single.measurement.id, multiple.measurement.id);
  assert.equal(multiple.measurement.reductions, 1);
});

test('a multi-commit rebase requires a verified whole-integration boundary', () => {
  const f = setup(contract({ maturation: 0 }));
  const before = f.source.snapshot({ 'src/a.js': lines(15), 'src/b.js': lines(15) });
  const first = f.source.snapshot({ 'src/a.js': lines(3), 'src/b.js': lines(15) }, before);
  const last = f.source.snapshot({ 'src/a.js': lines(3), 'src/b.js': lines(3) }, first);
  const ambiguous = pullEvidence('pr-rebase', 'merged', 10, {
    revision: last, acceptedAt: 10, boundary: null,
  });
  assert.equal(record(f, contribution('pr-rebase'), ambiguous, 10).measurement, null);
  const captured = record(f, contribution('pr-rebase'), {
    ...ambiguous,
    boundary: {
      kind: 'range', basis: 'verified-target-update', unitId: 'rebase-integration-1',
      before, after: last, subjects: ['pr-rebase'],
    },
  }, 10);
  assert.equal(captured.measurement.reductions, 2);
  assert.equal(captured.measurement.beforeRevision, before);
  assert.equal(captured.measurement.grouped, false);
});

test('a grouped integration has one fact, not its full improvement credited to every PR', () => {
  const f = setup(contract({ maturation: 0 }));
  const before = f.source.snapshot({ 'src/a.js': lines(15), 'src/b.js': lines(15) });
  const after = f.source.snapshot({ 'src/a.js': lines(3), 'src/b.js': lines(3) }, before);
  const captures = ['pr-1', 'pr-2'].map(subject => record(f, contribution(subject),
    pullEvidence(subject, 'merged', 10, {
      revision: after, acceptedAt: 10,
      boundary: {
        kind: 'range', basis: 'verified-target-update', unitId: 'shared-integration-1',
        before, after, subjects: ['pr-1', 'pr-2'],
      },
    }), 10));
  const journal = new CaptureJournal();
  journal.publishBatch(captures, 10);
  assert.equal(journal.captures.size, 2);
  assert.equal(journal.measurements.size, 1);
  const [{ measurement }] = journal.measurements.values();
  assert.equal(measurement.grouped, true);
  assert.equal(measurement.reductions, 2);
});

test('a later capture cannot silently rewrite the original acceptance time or immutable value', () => {
  const f = setup(contract({ maturation: 0 }));
  const before = f.source.snapshot({ 'src/a.js': lines(15) });
  const after = f.source.snapshot({ 'src/a.js': lines(3) }, before);
  const journal = new CaptureJournal();
  const first = record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 10, { revision: after, acceptedAt: 10 }), 10);
  journal.publishBatch([first], 10);
  const rewritten = record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 20, { revision: after, acceptedAt: 11 }), 20);
  assert.throws(() => journal.publishBatch([rewritten], 20), /Immutable measurement changed/);
  assert.equal(journal.captures.size, 1);
  assert.equal(journal.measurements.size, 1);
});

test('zero and negative contributions survive assessment', () => {
  const f = setup(contract({ maturation: 0 }));
  const before = f.source.snapshot({ 'src/a.js': lines(15) });
  const unchanged = f.source.snapshot({ 'src/a.js': lines(15), 'docs/a.txt': 'changed' }, before);
  const worse = f.source.snapshot({ 'src/a.js': lines(15), 'src/b.js': lines(15) }, unchanged);
  const same = record(f, contribution('pr-zero'),
    pullEvidence('pr-zero', 'merged', 1, { revision: unchanged, acceptedAt: 1 }), 1);
  const regression = record(f, contribution('pr-negative'),
    pullEvidence('pr-negative', 'merged', 2, { revision: worse, acceptedAt: 2 }), 2);
  assert.equal(same.measurement.reductions, 0);
  assert.equal(regression.measurement.reductions, -1);
});

test('the primary condition follows unrelated changes and reversals', () => {
  const f = setup(contract({ maturation: 0 }));
  const initial = f.source.snapshot({ 'src/a.js': lines(15) });
  const merged = f.source.snapshot({ 'src/a.js': lines(3) }, initial);
  const reversed = f.source.snapshot({ 'src/a.js': lines(15), 'src/b.js': lines(15) }, merged);
  const linked = record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 1, { revision: merged, acceptedAt: 1 }), 1);
  const repository = record(f, condition(10), snapshotEvidence(reversed, 10), 10);
  assert.equal(linked.measurement.reductions, 1);
  assert.equal(repository.measurement.oversized, 2);
  assert.equal(linked.measurement.reductions, 1);
});

test('closed without merge is not a fabricated zero; reopening is observable', () => {
  const f = setup();
  const closed = record(f, contribution('pr-1'), pullEvidence('pr-1', 'closed-without-merge', 30), 30);
  assert.equal(closed.gate.domainState, 'closed-without-merge');
  assert.equal(closed.measurement, null);
  const reopened = record(f, contribution('pr-1'), pullEvidence('pr-1', 'open', 31), 31);
  assert.equal(reopened.gate.readiness, 'waiting');
});

test('elapsed time cannot substitute for missing acceptance, lineage or checks', () => {
  const f = setup(contract({ requireChecks: true }));
  const parent = f.source.snapshot({ 'src/a.js': lines(15) });
  const merged = f.source.snapshot({ 'src/a.js': lines(3) }, parent);
  const observed = pullEvidence('pr-1', 'merged', 100, { revision: merged, acceptedAt: 60 });
  const missingCheck = record(f, contribution('pr-1'), observed, 100);
  assert.equal(missingCheck.gate.readiness, 'unavailable');
  assert.equal(missingCheck.measurement, null);
  assert.equal(record(f, contribution('pr-1'), { ...observed, checks: 'verified' }, 100).measurement.reductions, 1);
  assert.equal(record(f, contribution('pr-1'), { ...observed, outputLinks: [] }, 100).gate.readiness, 'unavailable');
  assert.equal(record(f, contribution('pr-1'), { ...observed, acceptedAt: null }, 100).gate.readiness, 'unavailable');
});

test('missing coverage yields unknown without consuming the partial tree', () => {
  const f = setup();
  const unavailable = record(f, condition(10), {
    ...snapshotEvidence('missing-revision', 10), coverage: 'partial',
  }, 10);
  assert.equal(unavailable.gate.readiness, 'unavailable');
  assert.equal(unavailable.measurement, null);
  assert.equal(f.source.reads, 0);
  const journal = new CaptureJournal();
  journal.publishBatch([record(f, condition(0), undefined, 0)], 0);
  assert.equal(journal.knownAt(0)[0].measurement, null);
});

test('source and observation times cannot leak future knowledge', () => {
  const rule = contract();
  assert.throws(() => readiness(rule, condition(10), snapshotEvidence('r', 10, 11), 10), /future evidence/);
  assert.throws(() => readiness(rule, condition(10), snapshotEvidence('r', 10, 5), 10), /Future cutoff/);
  assert.throws(() => readiness(rule, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 5, { revision: 'r', acceptedAt: 10 }), 20), /Acceptance after/);
  assert.throws(() => readiness(rule, condition(0),
    { ...snapshotEvidence('r', 0), repository: 'outside/scope' }, 0), /outside contract scope/);
});

test('late discovery preserves acceptance time without rewriting earlier knowledge', () => {
  const f = setup();
  const parent = f.source.snapshot({ 'src/a.js': lines(15) });
  const merged = f.source.snapshot({ 'src/a.js': lines(3) }, parent);
  const journal = new CaptureJournal();
  journal.publishBatch([record(f, contribution('pr-1'), pullEvidence('pr-1', 'open', 0), 0)], 0);
  journal.publishBatch([record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 90, { revision: merged, acceptedAt: 60 }), 90)], 90);
  assert.equal(journal.knownAt(80)[0].measurement, null);
  assert.equal(journal.knownAt(90)[0].measurement.effectiveAt, 60);
  assert.equal(journal.knownAt(90)[0].observedAt, 90);
});

test('replay needs only retained inputs and never substitutes live evidence', () => {
  const f = setup();
  const parent = f.source.snapshot({ 'src/a.js': lines(15), 'docs/private.txt': 'not an input' });
  const merged = f.source.snapshot({ 'src/a.js': lines(3) }, parent);
  const captured = record(f, contribution('pr-1'),
    pullEvidence('pr-1', 'merged', 67, { revision: merged, acceptedAt: 60 }), 67);
  f.source.enabled = false;
  assert.deepEqual(replayCapture(captured, f.archive), captured);
  assert.equal(replayCapture(captured, f.archive).observedAt, 67);
  const missing = [...f.archive.objects].find(([, object]) => object.type === 'blob')[0];
  f.archive.objects.delete(missing);
  assert.throws(() => replayCapture(captured, f.archive), /Missing blob/);
  assert.throws(() => replayCapture({ ...captured, evaluator: 'unavailable/v2' }, f.archive), /Evaluator version/);
});

test('tampered retained inputs fail rather than becoming a successful replay', () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const captured = record(f, condition(0), snapshotEvidence(revision, 0), 0);
  const [, blob] = [...f.archive.objects].find(([, object]) => object.type === 'blob');
  blob.value = 'tampered';
  assert.throws(() => replayCapture(captured, f.archive), /Corrupt blob/);
});

test('same-capture conflicts reject the complete publication batch', () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const captured = record(f, condition(0), snapshotEvidence(revision, 0), 0);
  const journal = new CaptureJournal();
  journal.publishBatch([captured], 0);
  const conflicting = structuredClone(captured);
  conflicting.measurement.oversized = 99;
  const another = record(f, condition(10), snapshotEvidence(revision, 10), 10);
  assert.throws(() => journal.publishBatch([another, conflicting], 10), /Conflicting same-capture/);
  assert.equal(journal.captures.size, 1);
  assert.equal(journal.revision, 1);
  journal.publishBatch([captured], 10);
  assert.equal(journal.revision, 1);
});

test('duplicate and irrelevant deliveries cause no new measurement work', async () => {
  const queue = new GenerationQueue();
  queue.finish(queue.begin(0), 10);
  assert.equal(queue.admitVerified('irrelevant', []), false);
  assert.equal(queue.begin(1), null);
  assert.equal(queue.admitVerified('delivery-1', ['pr-1']), true);
  assert.equal(queue.admitVerified('delivery-1', ['pr-1']), false);
  assert.equal(queue.generation, 1);
  const batch = queue.begin(1);
  queue.finish(batch, 10);
  let reads = 0;
  const job = new CollectionJob(queue, new CaptureJournal());
  assert.equal(await job.run(2, { authorized: () => true, acquire: async () => { reads++; return []; } }), 'idle');
  assert.equal(reads, 0);
});

test('an event arriving during acquisition is retained and rearmed', async () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const queue = new GenerationQueue();
  queue.admitVerified('old-a', ['a']);
  queue.admitVerified('old-b', ['b']);
  const journal = new CaptureJournal();
  const job = new CollectionJob(queue, journal);
  await job.run(0, {
    authorized: () => true,
    acquire: async () => {
      queue.admitVerified('new-a', ['a']);
      return [record(f, condition(0), snapshotEvidence(revision, 0), 0)];
    },
  });
  assert.equal(queue.acknowledged, 2);
  assert.equal(queue.generation, 3);
  assert.deepEqual([...queue.dirty], [['a', 3]]);
  assert.equal(queue.queued, true);
  assert.equal(journal.revision, 1);
});

test('acquisition failure does not acknowledge events or advance publication', async () => {
  const queue = new GenerationQueue();
  queue.admitVerified('event', ['a']);
  const journal = new CaptureJournal();
  const job = new CollectionJob(queue, journal);
  await assert.rejects(job.run(0, {
    authorized: () => true, acquire: async () => { throw new Error('API unavailable'); },
  }), /API unavailable/);
  assert.equal(queue.acknowledged, 0);
  assert.equal(queue.nextDue, 0);
  assert.equal(queue.queued, true);
  assert.equal(journal.revision, 0);
  assert.equal(job.prepared, null);
});

test('publish-before-ack failure resumes the same capture without invented freshness', async () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const queue = new GenerationQueue();
  queue.admitVerified('event', ['a']);
  const journal = new CaptureJournal();
  const firstJob = new CollectionJob(queue, journal);
  await assert.rejects(firstJob.run(0, {
    authorized: () => true,
    acquire: async () => [record(f, condition(0), snapshotEvidence(revision, 0), 0)],
    afterPublish: async () => { throw new Error('Simulated process loss before acknowledgment'); },
  }), /process loss/);
  assert.equal(journal.revision, 1);
  assert.equal(queue.acknowledged, 0);
  queue.admitVerified('newer-event', ['a']);
  const restartedJob = new CollectionJob(queue, journal, firstJob.prepared);
  await restartedJob.run(90, {
    authorized: () => true,
    acquire: async () => { throw new Error('Retry must not replace frozen acquisition'); },
  });
  assert.equal(journal.revision, 1);
  assert.equal(journal.knownAt(100)[0].observedAt, 0);
  assert.equal(queue.acknowledged, 1);
  assert.equal(queue.generation, 2);
  assert.equal(queue.queued, true);
  assert.deepEqual([...queue.dirty], [['a', 2]]);
});

test('current authorization is rechecked before publishing prepared work', async () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const queue = new GenerationQueue();
  const journal = new CaptureJournal();
  const job = new CollectionJob(queue, journal);
  let authorized = true;
  await assert.rejects(job.run(0, {
    authorized: () => authorized,
    acquire: async () => {
      authorized = false;
      return [record(f, condition(0), snapshotEvidence(revision, 0), 0)];
    },
  }), /withdrawn/);
  assert.equal(journal.revision, 0);
  assert.equal(queue.queued, true);
});

test('bounded catch-up preserves overdue checkpoints instead of jumping to now', () => {
  assert.deepEqual(dueCutoffs(10, 60, 10, 2), { cutoffs: [10, 20], next: 30 });
  const queue = new GenerationQueue();
  queue.finish(queue.begin(60), 30);
  assert.equal(queue.queued, true);
  assert.equal(queue.nextDue, 30);
});

test('an answered immutable question retires its timer but can be explicitly invalidated again', async () => {
  const f = setup(contract({ maturation: 0 }));
  const before = f.source.snapshot({ 'src/a.js': lines(15) });
  const merged = f.source.snapshot({ 'src/a.js': lines(3) }, before);
  const queue = new GenerationQueue();
  const journal = new CaptureJournal();
  const job = new CollectionJob(queue, journal);
  await job.run(10, {
    authorized: () => true,
    acquire: async () => [record(f, contribution('pr-1'),
      pullEvidence('pr-1', 'merged', 10, { revision: merged, acceptedAt: 10 }), 10)],
  });
  assert.equal(queue.nextDue, null);
  assert.equal(queue.queued, false);
  assert.equal(queue.begin(1000), null);
  queue.admitVerified('new-lineage', ['pr-1']);
  assert.notEqual(queue.begin(1000), null);
});

test('dirty-set overflow becomes a bounded full-scope invalidation without dropping newer events', () => {
  const queue = new GenerationQueue(2);
  queue.admitVerified('a', ['a']);
  queue.admitVerified('b', ['b']);
  queue.admitVerified('c', ['c']);
  assert.deepEqual([...queue.dirty], [['*', 3]]);
  const batch = queue.begin(0);
  queue.admitVerified('d', ['d']);
  queue.finish(batch, 10);
  assert.deepEqual([...queue.dirty], [['*', 4]]);
  assert.equal(queue.queued, true);
  const next = queue.begin(1);
  queue.finish(next, 10);
  assert.equal(queue.dirty.size, 0);
});

test('flat layouts degrade to the cached full fold rather than doubling tree traversal', () => {
  const source = new ObjectStore();
  const rule = contract();
  const files = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`src/f-${i}.js`, lines(8)]));
  const before = source.snapshot(files);
  const flat = new MetricCache(source, { subtreeReuse: false });
  const pruned = new MetricCache(source);
  flat.measure(before, rule);
  pruned.measure(before, rule);
  files['src/f-1.js'] = lines(15);
  const after = source.snapshot(files, before);
  flat.resetStats();
  pruned.resetStats();
  assert.deepEqual(flat.measure(after, rule), pruned.measure(after, rule));
  assert.equal(pruned.stats.treeEntries, flat.stats.treeEntries);
  assert.equal(pruned.stats.occurrences, flat.stats.occurrences);
});

test('replay rejects a different implementation or runtime even when the metric name matches', () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const captured = record(f, condition(0), snapshotEvidence(revision, 0), 0);
  assert.deepEqual(captured.implementation, IMPLEMENTATION);
  assert.throws(() => replayCapture({
    ...captured, implementation: { ...IMPLEMENTATION, sourceSha256: 'unavailable' },
  }, f.archive), /Pinned implementation/);
});

test('same numeric value does not remove subsequent cadence observations', () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const journal = new CaptureJournal();
  for (const cutoff of [0, 10, 20, 30]) {
    journal.publishBatch([record(f, condition(cutoff), snapshotEvidence(revision, cutoff), cutoff)], cutoff);
  }
  assert.equal(journal.knownAt(30).length, 4);
  assert.deepEqual(journal.knownAt(30).map(capture => capture.measurement.oversized), [1, 1, 1, 1]);
  assert.equal(f.metric.stats.blobMeasurements, 1);
});

test('a current unavailable period does not become the previous known period', () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const journal = new CaptureJournal();
  journal.publishBatch([record(f, condition(0), snapshotEvidence(revision, 0), 0)], 0);
  journal.publishBatch([record(f, condition(10), { ...snapshotEvidence('unavailable', 10), coverage: 'partial' }, 10)], 10);
  const latestPeriod = journal.knownAt(10).sort((a, b) => b.question.cutoff - a.question.cutoff)[0];
  assert.equal(latestPeriod.question.cutoff, 10);
  assert.equal(latestPeriod.measurement, null);
  assert.equal(latestPeriod.gate.readiness, 'unavailable');
});

test('partial work cannot postpone an independent repository deadline', async () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const queue = new GenerationQueue();
  const job = new CollectionJob(queue, new CaptureJournal());
  await job.run(0, {
    authorized: () => true,
    acquire: async () => [
      record(f, condition(0), snapshotEvidence(revision, 0), 0),
      record(f, contribution('pr-1'), pullEvidence('pr-1', 'open', 0), 0),
    ],
  });
  assert.equal(queue.nextDue, 10);
  queue.admitVerified('pr-update', ['pr-1']);
  await job.run(5, {
    authorized: () => true,
    acquire: async () => [record(f, contribution('pr-1'), pullEvidence('pr-1', 'open', 5), 5)],
  });
  assert.equal(queue.nextDue, 10);
});

test('an unavailable source cannot stretch the fixed repository cadence', async () => {
  const f = setup();
  const queue = new GenerationQueue();
  const job = new CollectionJob(queue, new CaptureJournal());
  await job.run(0, {
    authorized: () => true,
    acquire: async () => [record(f, condition(0), null, 0)],
  });
  assert.equal(queue.nextDue, 10);
});

test('publication visibility cannot be backdated to evidence capture time', () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const captured = record(f, condition(0), snapshotEvidence(revision, 0), 0);
  const journal = new CaptureJournal();
  journal.publishBatch([captured], 90);
  assert.equal(journal.knownAt(80).length, 0);
  assert.equal(journal.knownAt(90)[0].observedAt, 0);
  journal.publishBatch([captured], 100);
  assert.deepEqual([...journal.availableAt.values()], [90]);
});

test('acquisition and publication can finish after planning without falsifying either clock', async () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const queue = new GenerationQueue();
  const journal = new CaptureJournal();
  const job = new CollectionJob(queue, journal);
  let clock = 0;
  await job.run(0, {
    authorized: () => true,
    clock: () => clock,
    acquire: async () => {
      clock = 5;
      return [record(f, condition(0), snapshotEvidence(revision, 0, 5), 5)];
    },
    afterPublish: async () => { clock = 15; },
  });
  assert.equal(journal.knownAt(4).length, 0);
  assert.equal(journal.knownAt(5)[0].observedAt, 5);
  assert.equal(journal.knownAt(5)[0].measurement.effectiveAt, 0);
  assert.equal(queue.nextDue, 10);
  assert.equal(queue.queued, true);
});

test('late repair preserves newer cadence and other maturity or reconciliation timers', () => {
  const f = setup();
  const revision = f.source.snapshot({ 'src/a.js': lines(15) });
  const initial = advanceDeadlines(new Map(), [
    record(f, condition(0), null, 0),
    record(f, contribution('pr-1'), pullEvidence('pr-1', 'open', 0), 0),
  ]);
  const advanced = advanceDeadlines(initial, [
    record(f, condition(10), snapshotEvidence(revision, 10), 10),
  ]);
  const repaired = advanceDeadlines(advanced, [
    record(f, condition(0), snapshotEvidence(revision, 0, 15), 15),
  ]);
  assert.equal(repaired.get(timerKey(f.rule, condition(0))), 20);
  assert.equal(repaired.get(timerKey(f.rule, contribution('pr-1'))), 30);
  assert.equal(initial.size, 3);
  assert.equal(repaired.size, 2);
  assert.equal(initial.get(timerKey(f.rule, condition(0))), 10);
});

test('a lifecycle-only update cannot consume another question maturity boundary', async () => {
  const f = setup();
  const parent = f.source.snapshot({ 'src/a.js': lines(15) });
  const merged = f.source.snapshot({ 'src/a.js': lines(3) }, parent);
  const queue = new GenerationQueue();
  const job = new CollectionJob(queue, new CaptureJournal());
  await job.run(60, {
    authorized: () => true,
    acquire: async () => [
      record(f, condition(60), snapshotEvidence(merged, 60), 60),
      record(f, contribution('pr-1'), pullEvidence('pr-1', 'merged', 60, { revision: merged, acceptedAt: 60 }), 60),
    ],
  });
  queue.admitVerified('unrelated-pr-update', ['pr-2']);
  await job.run(61, {
    authorized: () => true,
    acquire: async () => [record(f, contribution('pr-2'), pullEvidence('pr-2', 'open', 61), 61)],
  });
  assert.equal(queue.nextDue, 67);
});

test('bounded cadence catch-up must account for every scheduled slot, including unknown ones', () => {
  const f = setup();
  const current = new Map([[timerKey(f.rule, condition(0)), 10]]);
  const at20 = record(f, condition(20), null, 20);
  const at10 = record(f, condition(10), null, 20);
  assert.throws(() => advanceDeadlines(current, [at20]), /Skipped a scheduled/);
  const next = advanceDeadlines(current, [at20, at10]);
  assert.equal(next.get(timerKey(f.rule, condition(0))), 30);
});

test('missed events are recovered when the declared reconciliation timer is due', async () => {
  const f = setup(contract({ maturation: 0 }));
  const before = f.source.snapshot({ 'src/a.js': lines(15) });
  const merged = f.source.snapshot({ 'src/a.js': lines(3) }, before);
  const queue = new GenerationQueue();
  const journal = new CaptureJournal();
  const job = new CollectionJob(queue, journal);
  await job.run(0, {
    authorized: () => true,
    acquire: async () => [record(f, contribution('pr-1'), pullEvidence('pr-1', 'open', 0), 0)],
  });
  await job.run(30, {
    authorized: () => true,
    acquire: async batch => {
      assert.deepEqual(batch.keys, []);
      assert.deepEqual(batch.due, [timerKey(f.rule, contribution('pr-1'))]);
      return [record(f, contribution('pr-1'), pullEvidence('pr-1', 'merged', 30, { revision: merged, acceptedAt: 12 }), 30)];
    },
  });
  assert.equal(journal.knownAt(29)[0].measurement, null);
  assert.equal(journal.knownAt(30)[0].measurement.reductions, 1);
  assert.equal(journal.knownAt(30)[0].measurement.effectiveAt, 12);
  assert.equal(queue.nextDue, null);
});

test('invalid questions and wrong subjects are rejected even without complete evidence', () => {
  const rule = contract();
  assert.throws(() => readiness(rule, { kind: 'unregistered' }, null, 0), /Unsupported question/);
  assert.throws(() => readiness(rule, contribution('pr-1'), {
    ...pullEvidence('pr-2', 'open', 0), coverage: 'partial',
  }, 0), /subject mismatch/);
  assert.throws(() => readiness(rule, condition(0), {
    ...snapshotEvidence('r', 0), targetRef: 'refs/heads/unrelated',
  }, 0), /target ref/);
  assert.equal(readiness(rule, condition(10), null, 0).readiness, 'waiting');
});

test('newline variants and empty files preserve the explicit strict threshold', () => {
  const f = setup();
  const revision = f.source.snapshot({
    'src/empty.js': '', 'src/one.js': '\n', 'src/crlf.js': 'line\r\n'.repeat(11),
    'src/exact.js': lines(10), 'src/no-final-newline.js': lines(10) + 'last line',
  });
  assert.deepEqual(f.metric.measure(revision, f.rule), { oversized: 2, eligible: 5 });
  assert.deepEqual(f.metric.measure(revision, f.rule), fullMetric(f.source, revision, f.rule));
});

test('the reference evaluator identity is explicit and content fingerprints are stable', () => {
  assert.equal(EVALUATOR, 'synthetic-file-count/v1');
  assert.equal(digest({ a: 1, b: 2 }), digest({ b: 2, a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});
