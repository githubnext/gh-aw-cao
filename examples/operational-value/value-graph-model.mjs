import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Synthetic reference model, not a Git parser, API adapter, gh-aw runtime, or dashboard engine.
export const EVALUATOR = 'synthetic-file-count/v1';
export const IMPLEMENTATION = Object.freeze({
  sourceSha256: createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex'),
  runtime: process.version,
});

function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError('Non-finite value');
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError('Unsupported value');
    return encoded;
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function contract(overrides = {}) {
  const result = {
    id: 'oversized-files', version: 1, repository: 'example/repo', workflow: 'synthetic-file-diet',
    targetRef: 'refs/heads/main',
    prefix: 'src/', extension: '.js', excludedSuffix: '.test.js', threshold: 10,
    cadence: 10, maturation: 7, reconcileEvery: 30, requireChecks: false,
    ...overrides,
  };
  for (const field of ['version', 'threshold', 'cadence', 'maturation', 'reconcileEvery']) {
    if (!Number.isSafeInteger(result[field]) || result[field] < 0) throw new TypeError(`Invalid ${field}`);
  }
  if (!result.version || !result.cadence || !result.reconcileEvery) throw new TypeError('Nonpositive interval/version');
  for (const field of ['id', 'repository', 'workflow', 'targetRef', 'prefix', 'extension', 'excludedSuffix']) {
    if (typeof result[field] !== 'string' || !result[field]) throw new TypeError(`Invalid ${field}`);
  }
  if (!result.prefix.endsWith('/') || typeof result.requireChecks !== 'boolean') throw new TypeError('Invalid contract');
  return Object.freeze(result);
}

export class ObjectStore {
  objects = new Map();
  reads = 0;
  enabled = true;

  put(type, value) {
    const object = { type, value: structuredClone(value) };
    const id = digest(object);
    this.objects.set(id, object);
    return id;
  }

  read(id, type) {
    if (!this.enabled) throw new Error('Source unavailable');
    this.reads++;
    const object = this.objects.get(id);
    if (!object || object.type !== type) throw new Error(`Missing ${type} ${id}`);
    if (digest(object) !== id) throw new Error(`Corrupt ${type} ${id}`);
    return structuredClone(object.value);
  }

  snapshot(files, parent = null) {
    if (parent !== null) this.read(parent, 'commit');
    const root = new Map();
    for (const [path, content] of Object.entries(files)) {
      const components = path.split('/');
      if (components.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
        throw new TypeError('Invalid path');
      }
      if (typeof content !== 'string') throw new TypeError('Non-text synthetic blob');
      let directory = root;
      for (const name of components.slice(0, -1)) {
        if (!directory.has(name)) directory.set(name, new Map());
        const child = directory.get(name);
        if (!(child instanceof Map)) throw new TypeError('File/directory collision');
        directory = child;
      }
      const name = components.at(-1);
      if (directory.get(name) instanceof Map) throw new TypeError('File/directory collision');
      directory.set(name, this.put('blob', content));
    }
    const save = directory => this.put('tree', [...directory].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, child]) => ({
        name, type: child instanceof Map ? 'tree' : 'blob',
        id: child instanceof Map ? save(child) : child,
      })));
    return this.put('commit', { tree: save(root), parents: parent === null ? [] : [parent] });
  }
}

export class ArchivingReader {
  constructor(source, archive) {
    this.source = source;
    this.archive = archive;
  }

  read(id, type) {
    const value = this.source.read(id, type);
    if (this.archive.put(type, value) !== id) throw new Error('Object identity mismatch');
    return value;
  }
}

function eligible(path, rule) {
  return path.startsWith(rule.prefix) && path.endsWith(rule.extension) && !path.endsWith(rule.excludedSuffix);
}

function intersects(prefix, rule) {
  return prefix.startsWith(rule.prefix) || rule.prefix.startsWith(prefix);
}

function add(a, b) {
  return { oversized: a.oversized + b.oversized, eligible: a.eligible + b.eligible };
}

const zero = () => ({ oversized: 0, eligible: 0 });
const freshStats = () => ({ treeEntries: 0, occurrences: 0, blobMeasurements: 0, aggregateReuses: 0 });

export class MetricCache {
  aggregates = new Map();
  blobLines = new Map();
  stats = freshStats();

  constructor(reader, { subtreeReuse = true } = {}) {
    this.reader = reader;
    this.subtreeReuse = subtreeReuse;
  }

  resetStats() { this.stats = freshStats(); }

  measure(revision, rule) {
    const current = this.reader.read(revision, 'commit');
    return this.tree(current.tree, '', rule);
  }

  tree(id, prefix, rule) {
    if (!intersects(prefix, rule)) return zero();
    const key = digest([IMPLEMENTATION, rule, prefix, id]);
    if (this.subtreeReuse && this.aggregates.has(key)) {
      this.stats.aggregateReuses++;
      return structuredClone(this.aggregates.get(key));
    }
    const entries = this.reader.read(id, 'tree');
    this.stats.treeEntries += entries.length;
    let result = zero();
    for (const entry of entries) result = add(result, this.entry(entry, prefix, rule));
    if (this.subtreeReuse) this.aggregates.set(key, structuredClone(result));
    return result;
  }

  entry(entry, prefix, rule) {
    const path = prefix + entry.name;
    if (entry.type === 'tree') {
      return this.tree(entry.id, `${path}/`, rule);
    }
    if (!eligible(path, rule)) return zero();
    this.stats.occurrences++;
    if (!this.blobLines.has(entry.id)) {
      const content = this.reader.read(entry.id, 'blob');
      const lines = content === '' ? 0 : content.split('\n').length - Number(content.endsWith('\n'));
      this.blobLines.set(entry.id, lines);
      this.stats.blobMeasurements++;
    }
    return { oversized: Number(this.blobLines.get(entry.id) > rule.threshold), eligible: 1 };
  }
}

// Deliberately independent oracle: no tree pruning and no blob memoization.
export function fullMetric(source, revision, rule) {
  const result = zero();
  function walk(tree, prefix) {
    for (const entry of source.read(tree, 'tree')) {
      const path = prefix + entry.name;
      if (entry.type === 'tree') {
        walk(entry.id, `${path}/`);
      } else if (path.startsWith(rule.prefix) && path.endsWith(rule.extension) && !path.endsWith(rule.excludedSuffix)) {
        const text = source.read(entry.id, 'blob');
        const lines = (text.match(/\n/g) ?? []).length + Number(text.length > 0 && !text.endsWith('\n'));
        result.eligible++;
        result.oversized += Number(lines > rule.threshold);
      }
    }
  }
  walk(source.read(revision, 'commit').tree, '');
  return result;
}

export function dueCutoffs(nextCutoff, now, cadence, limit = 32) {
  if (!Number.isFinite(nextCutoff) || !Number.isFinite(now) || !Number.isSafeInteger(cadence)
      || cadence < 1 || !Number.isSafeInteger(limit) || limit < 1) throw new TypeError('Invalid cadence request');
  const cutoffs = [];
  let next = nextCutoff;
  while (next <= now && cutoffs.length < limit) {
    cutoffs.push(next);
    next += cadence;
  }
  return { cutoffs, next };
}

export class QuestionRegistry {
  nativeOutputs = new Map();
  questions = new Map();
  contracts = new Map();

  recordNativeOutput(output) {
    const previous = this.nativeOutputs.get(output.id);
    if (previous && digest(previous) !== digest(output)) throw new Error('Conflicting native output');
    this.nativeOutputs.set(output.id, structuredClone(output));
  }

  register(rule, question) {
    if (!['repository-condition', 'merge-change'].includes(question.kind)) throw new Error('Unsupported question');
    const identity = digest([rule.repository, rule.workflow, rule.id, rule.version]);
    if (this.contracts.has(identity) && this.contracts.get(identity) !== digest(rule)) {
      throw new Error('Frozen contract changed without a new version');
    }
    this.contracts.set(identity, digest(rule));
    const key = digest([rule, question]);
    this.questions.set(key, structuredClone(question));
    return key;
  }
}

export class DependencyIndex {
  consumers = new Map();

  subscribe(questionId, keys) {
    for (const key of keys) {
      if (!this.consumers.has(key)) this.consumers.set(key, new Set());
      this.consumers.get(key).add(questionId);
    }
  }

  affected(keys) {
    return [...new Set(keys.flatMap(key => [...(this.consumers.get(key) ?? [])]))].sort();
  }
}

export function readiness(rule, question, evidence, now) {
  if (!Number.isFinite(now)) throw new TypeError('Invalid capture time');
  if (!['repository-condition', 'merge-change'].includes(question.kind)) throw new Error('Unsupported question');
  if (question.kind === 'repository-condition' && !Number.isFinite(question.cutoff)) throw new TypeError('Invalid cutoff');
  if (question.kind === 'merge-change' && (typeof question.subject !== 'string' || !question.subject)) {
    throw new TypeError('Invalid question subject');
  }
  const later = now + rule.reconcileEvery;
  const state = evidence?.state ?? 'unknown';
  if (evidence) {
    if (!Number.isFinite(evidence.observedAt) || evidence.observedAt > now) throw new Error('Invalid/future evidence time');
    if (evidence.repository !== rule.repository) throw new Error('Evidence outside contract scope');
    if (evidence.targetRef !== rule.targetRef) throw new Error('Evidence outside target ref');
    if (question.kind === 'merge-change' && evidence.subject !== question.subject) throw new Error('Evidence subject mismatch');
    if (question.kind === 'repository-condition' && Number.isFinite(evidence.cutoff) && evidence.cutoff > evidence.observedAt) {
      throw new Error('Future cutoff evidence');
    }
  }
  if (question.kind === 'repository-condition' && question.cutoff > now) {
    return { readiness: 'waiting', domainState: 'scheduled', nextDue: question.cutoff };
  }
  if (!evidence || evidence.coverage !== 'complete') {
    return { readiness: 'unavailable', domainState: state, nextDue: later, reason: 'Incomplete source coverage' };
  }
  if (question.kind === 'repository-condition') {
    if (evidence.cutoff !== question.cutoff || !evidence.revision) {
      return { readiness: 'unavailable', domainState: 'unknown', nextDue: later, reason: 'Missing exact-cutoff evidence' };
    }
    return { readiness: 'ready', domainState: 'observed', nextDue: question.cutoff + rule.cadence };
  }
  if (!Array.isArray(evidence.outputLinks) || !evidence.outputLinks.length) {
    return { readiness: 'unavailable', domainState: state, nextDue: later, reason: 'No verified implementation lineage' };
  }
  if (state === 'open') {
    return { readiness: 'waiting', domainState: 'open', nextDue: later, reason: 'Waiting for an acceptance event' };
  }
  if (state === 'closed-without-merge') {
    return { readiness: 'ready', domainState: state, nextDue: later, reason: 'No accepted implementation as observed' };
  }
  if (state !== 'merged' || !evidence.revision || !Number.isFinite(evidence.acceptedAt) || evidence.acceptedAt > now) {
    return { readiness: 'unavailable', domainState: state, nextDue: later, reason: 'Missing authoritative acceptance' };
  }
  if (evidence.acceptedAt > evidence.observedAt) throw new Error('Acceptance after its observation');
  // A time boundary permits evaluation; it is not evidence of durable benefit.
  const matureAt = evidence.acceptedAt + rule.maturation;
  if (now < matureAt) {
    return { readiness: 'waiting', domainState: 'merged', nextDue: matureAt, reason: 'Waiting for the frozen maturation boundary' };
  }
  if (rule.requireChecks && evidence.checks !== 'verified') {
    return { readiness: 'unavailable', domainState: 'merged', nextDue: later, reason: 'Required checks are not verified' };
  }
  const boundary = evidence.boundary;
  const firstParent = boundary?.kind === 'first-parent'
    && ['verified-merge', 'verified-squash'].includes(boundary.basis);
  const range = boundary?.kind === 'range' && boundary.basis === 'verified-target-update'
    && typeof boundary.unitId === 'string' && boundary.unitId.length > 0
    && typeof boundary.before === 'string' && boundary.before.length > 0 && boundary.after === evidence.revision
    && Array.isArray(boundary.subjects) && boundary.subjects.includes(question.subject);
  if (!firstParent && !range) {
    return { readiness: 'unavailable', domainState: 'merged', nextDue: later, reason: 'Integration boundary is not verified' };
  }
  return { readiness: 'ready', domainState: 'merged', nextDue: null };
}

export function createCapture({ rule, question, evidence, observedAt, metric }) {
  const gate = readiness(rule, question, evidence, observedAt);
  let measurement = null;
  if (gate.readiness === 'ready' && gate.domainState === 'observed') {
    measurement = {
      id: digest([rule, 'repository-condition', question.cutoff]),
      effectiveAt: question.cutoff, ...metric.measure(evidence.revision, rule),
    };
  } else if (gate.readiness === 'ready' && gate.domainState === 'merged') {
    const boundary = evidence.boundary;
    let beforeRevision = boundary.before;
    if (boundary.kind === 'first-parent') {
      const commit = metric.reader.read(evidence.revision, 'commit');
      const validShape = boundary.basis === 'verified-squash' ? commit.parents.length === 1 : commit.parents.length >= 2;
      if (!validShape) throw new Error('Accepted revision does not match the verified merge method');
      beforeRevision = commit.parents[0];
    }
    const before = metric.measure(beforeRevision, rule);
    const after = metric.measure(evidence.revision, rule);
    measurement = {
      id: digest([rule, 'integration', boundary.kind === 'range' ? boundary.unitId : evidence.revision]),
      effectiveAt: evidence.acceptedAt,
      before: before.oversized, after: after.oversized,
      reductions: before.oversized - after.oversized,
      beforeRevision, afterRevision: evidence.revision,
      grouped: boundary.kind === 'range' && boundary.subjects.length > 1,
    };
  }
  return {
    evaluator: EVALUATOR, implementation: IMPLEMENTATION,
    rule: structuredClone(rule), question: structuredClone(question),
    evidence: structuredClone(evidence ?? null), observedAt, gate, measurement,
  };
}

export class CaptureJournal {
  captures = new Map();
  availableAt = new Map();
  measurements = new Map();
  revision = 0;

  publishBatch(captures, availableAt) {
    if (!Number.isFinite(availableAt)) throw new TypeError('Missing publication time');
    const writes = new Map();
    const facts = new Map();
    for (const capture of captures) {
      if (!Number.isFinite(capture.observedAt) || capture.observedAt > availableAt) throw new Error('Publication before observation');
      const id = digest([capture.rule, capture.question, capture.observedAt]);
      const known = writes.get(id) ?? this.captures.get(id);
      if (known && digest(known) !== digest(capture)) throw new Error('Conflicting same-capture assessment');
      writes.set(id, structuredClone(capture));
      if (capture.measurement) {
        const fact = capture.measurement;
        const previous = facts.get(fact.id) ?? this.measurements.get(fact.id)?.measurement;
        if (previous && digest(previous) !== digest(fact)) throw new Error('Immutable measurement changed');
        facts.set(fact.id, structuredClone(fact));
      }
    }
    for (const [id, measurement] of facts) {
      if (!this.measurements.has(id)) this.measurements.set(id, { measurement, availableAt });
    }
    let changed = false;
    for (const [id, capture] of writes) {
      if (!this.captures.has(id)) {
        this.captures.set(id, capture);
        this.availableAt.set(id, availableAt);
        changed = true;
      }
    }
    if (changed) this.revision++;
  }

  // Archive selection for the model's assertions, not an alternative dashboard query engine.
  knownAt(time) {
    if (!Number.isFinite(time)) throw new TypeError('Invalid historical cutoff');
    const latest = new Map();
    for (const [id, capture] of this.captures) {
      if (this.availableAt.get(id) > time) continue;
      if (capture.observedAt > time || (capture.measurement && capture.measurement.effectiveAt > time)) continue;
      const key = digest([capture.rule, capture.question]);
      if (!latest.has(key) || latest.get(key).observedAt < capture.observedAt) latest.set(key, structuredClone(capture));
    }
    return [...latest.values()];
  }
}

export function timerKey(rule, question) {
  return digest([rule, question.kind === 'repository-condition' ? 'cadence' : question]);
}

function updateDeadline(deadlines, key, at) {
  if (at !== null && !Number.isFinite(at)) throw new TypeError('Invalid deadline');
  if (at === null) deadlines.delete(key);
  else deadlines.set(key, at);
}

function earliestDeadline(deadlines) {
  let earliest = null;
  for (const at of deadlines.values()) if (earliest === null || at < earliest) earliest = at;
  return earliest;
}

export function advanceDeadlines(current, captures) {
  const next = new Map(current);
  const ordered = [...captures].sort((a, b) => (a.question.cutoff ?? 0) - (b.question.cutoff ?? 0));
  for (const capture of ordered) {
    const { rule, question, gate, observedAt } = capture;
    const key = timerKey(rule, question);
    if (question.kind !== 'repository-condition') {
      updateDeadline(next, key, gate.nextDue);
      continue;
    }
    const cursor = next.get(key) ?? question.cutoff;
    if (question.cutoff > observedAt) {
      updateDeadline(next, key, Math.min(cursor, question.cutoff));
      continue;
    }
    if (question.cutoff > cursor) throw new Error('Skipped a scheduled repository cutoff');
    updateDeadline(next, key, Math.max(cursor, question.cutoff + rule.cadence));
    const repairKey = digest([rule, 'repair', question]);
    updateDeadline(next, repairKey, gate.readiness === 'unavailable' ? gate.nextDue : null);
  }
  return next;
}

export function replayCapture(capture, archive) {
  if (capture.evaluator !== EVALUATOR) throw new Error('Evaluator version not available');
  if (digest(capture.implementation) !== digest(IMPLEMENTATION)) throw new Error('Pinned implementation/runtime not available');
  const replayed = createCapture({
    rule: capture.rule, question: capture.question, evidence: capture.evidence,
    observedAt: capture.observedAt, metric: new MetricCache(archive),
  });
  if (digest(replayed) !== digest(capture)) throw new Error('Assessment replay mismatch');
  return replayed;
}

export class GenerationQueue {
  generation = 0;
  acknowledged = 0;
  seen = new Set();
  dirty = new Map();
  deadlines = new Map();
  running = false;
  queued = true;
  nextDue = 0;

  constructor(maxDirty = 64) {
    if (!Number.isSafeInteger(maxDirty) || maxDirty < 1) throw new TypeError('Invalid dirty-set bound');
    this.maxDirty = maxDirty;
  }

  schedule(rule, question, at) {
    updateDeadline(this.deadlines, timerKey(rule, question), at);
    this.nextDue = earliestDeadline(this.deadlines);
  }

  admitVerified(deliveryId, dependencyKeys) {
    if (this.seen.has(deliveryId)) return false;
    this.seen.add(deliveryId);
    if (!dependencyKeys.length) return false;
    this.generation++;
    if (this.dirty.has('*')) {
      this.dirty.set('*', this.generation);
    } else {
      for (const key of dependencyKeys) this.dirty.set(key, this.generation);
      if (this.dirty.size > this.maxDirty) {
        this.dirty.clear();
        this.dirty.set('*', this.generation);
      }
    }
    if (!this.running) this.queued = true;
    return true;
  }

  begin(now) {
    if (!Number.isFinite(now)) throw new TypeError('Invalid planning time');
    if (this.running) throw new Error('Collection already running');
    if (!this.queued && (this.nextDue === null || now < this.nextDue)) return null;
    this.running = true;
    this.queued = false;
    return {
      generation: this.generation, keys: [...this.dirty.keys()], observedAt: now,
      due: [...this.deadlines].filter(([, at]) => at <= now).map(([key]) => key),
    };
  }

  resume() {
    if (this.running) throw new Error('Collection already running');
    this.running = true;
    this.queued = false;
  }

  finish(batch, nextDue, completedAt = batch.observedAt) {
    if (nextDue !== null && !Number.isFinite(nextDue)) throw new TypeError('Invalid next deadline');
    if (!Number.isFinite(completedAt) || completedAt < batch.observedAt) throw new TypeError('Invalid completion time');
    for (const [key, generation] of this.dirty) {
      if (generation <= batch.generation) this.dirty.delete(key);
    }
    this.acknowledged = Math.max(this.acknowledged, batch.generation);
    this.nextDue = nextDue;
    this.running = false;
    this.queued = this.generation > this.acknowledged || (nextDue !== null && nextDue <= completedAt);
  }

  fail() {
    this.running = false;
    this.queued = true;
  }
}

export class CollectionJob {
  constructor(queue, journal, prepared = null) {
    this.queue = queue;
    this.journal = journal;
    this.prepared = structuredClone(prepared);
  }

  async run(now, { authorized, acquire, clock = () => now, afterPublish = async () => {} }) {
    if (!authorized()) throw new Error('Collection is not currently authorized');
    if (this.prepared) {
      this.queue.resume();
    } else {
      const batch = this.queue.begin(now);
      if (!batch) return 'idle';
      try {
        const captures = await acquire(batch);
        const acquiredAt = clock();
        if (!Number.isFinite(acquiredAt) || !captures.length || captures.some(capture =>
          !Number.isFinite(capture.observedAt) || capture.observedAt < batch.observedAt
          || capture.observedAt > acquiredAt || capture.observedAt !== captures[0].observedAt)) {
          throw new Error('Capture does not match the acquisition interval');
        }
        this.prepared = { batch, captures: structuredClone(captures) };
      } catch (error) {
        this.queue.fail();
        throw error;
      }
    }
    try {
      if (!authorized()) throw new Error('Collection authorization was withdrawn');
      advanceDeadlines(this.queue.deadlines, this.prepared.captures);
      const availableAt = clock();
      this.journal.publishBatch(this.prepared.captures, availableAt);
      await afterPublish();
      const deadlines = advanceDeadlines(this.queue.deadlines, this.prepared.captures);
      const completedAt = clock();
      if (completedAt < availableAt) throw new Error('Completion clock moved backwards');
      this.queue.finish(this.prepared.batch, earliestDeadline(deadlines), completedAt);
      this.queue.deadlines = deadlines;
      this.prepared = null;
      return 'published';
    } catch (error) {
      this.queue.fail();
      throw error;
    }
  }
}
