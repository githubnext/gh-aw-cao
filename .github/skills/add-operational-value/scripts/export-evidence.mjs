import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { validateEventLedger } from './pulse-model.mjs';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = (value) => digest(value);
const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

/** Export validated originals, never eventPulse's computed presentation model. */
export function exportOperationalValueEvidence(ledger) {
  const events = validateEventLedger(ledger);
  const facts = [];
  const add = (kind, id, fields) => facts.push(defined({ 'fact-kind': kind, 'fact-id': id, ...fields }));
  const snapshot = ledger.repositoryState?.metric;
  add('contract', 'contract', {
    goal: ledger.intent.goal, acceptance: ledger.intent.acceptance,
    'metric-id': ledger.metric.id, 'metric-name': ledger.metric.name,
    'metric-unit': ledger.metric.unit, 'metric-direction': ledger.metric.direction,
    'metric-version': ledger.metric.version, 'metric-formula': ledger.metric.formula,
    'result-label': ledger.resultLabel, 'measurement-basis': ledger.basis,
    'snapshot-name': snapshot?.name, 'snapshot-unit': snapshot?.unit, 'snapshot-direction': snapshot?.direction,
    'snapshot-id': snapshot?.id, 'snapshot-version': snapshot?.version, 'snapshot-formula': snapshot?.formula,
    'outputs-available': ledger.outputs !== undefined, 'repository-state-available': ledger.repositoryState !== undefined,
    'checks-available': ledger.checks !== undefined, 'cadence-days': ledger.cadenceDays,
    'maturation-days': ledger.maturationDays, 'output-unit': ledger.outputs?.unit,
    'implementation-unit': ledger.outputs?.implementationUnit, 'output-scope': ledger.outputs?.scope,
    'output-coverage': ledger.outputs?.coverage, 'workflow-name': ledger.workflowName
  });
  const references = (kind, parent, items) => {
    const seen = new Set();
    for (const item of items ?? []) {
      const id = identity([item.label, item.url, item.at]);
      if (seen.has(id)) continue;
      seen.add(id);
      add(kind, id, { 'parent-id': parent, label: item.label, url: item.url, at: item.at });
    }
  };
  references('intent-source', undefined, ledger.intent.sources);
  for (const requirement of new Set(ledger.intent.requirements ?? [])) add('requirement', identity(requirement), { label: requirement });
  for (const output of ledger.outputs?.items ?? []) {
    add('output', output.id, { label: output.label, title: output.title, url: output.url,
      at: output.createdAt, state: output.state, origin: output.origin });
    for (const id of output.implementationIds) add('output-implementation', id, { 'parent-id': output.id, 'related-id': id });
    references('output-evidence', output.id, output.evidence);
  }
  for (const event of events) {
    add('implementation', event.id, { at: event.at, 'accepted-at': event.acceptance.at, value: event.value, label: event.label,
      title: event.title, detail: event.detail, ref: event.acceptance.ref, origin: event.attribution,
      url: event.evidence.find((item) => /implement|pull|PR/i.test(item.label))?.url });
    references('implementation-evidence', event.id, event.evidence);
    for (const edge of event.lineage ?? []) add('implementation-lineage', identity(edge), {
      'parent-id': event.id, 'related-id': edge.outputId, label: edge.relation, at: edge.at,
      url: ledger.outputs?.items.find((output) => output.id === edge.outputId)?.url
    });
  }
  for (const observation of ledger.repositoryState?.observations ?? []) {
    const id = identity([observation.at, observation.ref]);
    add('snapshot', id, { at: observation.at, value: observation.value, ref: observation.ref,
      url: observation.url, 'items-available': observation.items !== undefined });
    references('snapshot-item', id, observation.items);
  }
  for (const check of ledger.checks ?? []) add('quality-check', identity(check.name), {
    label: check.name, status: check.status, detail: check.detail
  });
  for (const interval of ledger.coverage) add('coverage', identity([interval.startAt, interval.endAt]), {
    at: interval.startAt, 'end-at': interval.endAt, 'coverage-status': interval.status
  });
  for (const limitation of new Set(ledger.limitations)) add('limitation', identity(limitation), {
    label: 'Evidence limitation', detail: limitation
  });
  if (ledger.repositoryState?.limitation) add('limitation', 'repository-state', {
    label: 'Independent repository state', detail: ledger.repositoryState.limitation
  });
  const packet = {
    schemaVersion: 1,
    id: `operational-value-evidence:${encodeURIComponent(`${ledger.repository.toLowerCase()}:${ledger.workflowSlug}:${ledger.metric.id}:${ledger.metric.version}`)}`,
    repository: ledger.repository, workflow: ledger.workflowSlug, sourcePath: ledger.sourcePath, observedAt: ledger.observedAt,
    windowStart: ledger.window.startAt, windowEnd: ledger.window.endAt,
    contractDigest: digest({ intent: ledger.intent, metric: ledger.metric, basis: ledger.basis, snapshot,
      cadenceDays: ledger.cadenceDays, maturationDays: ledger.maturationDays }), facts
  };
  if (facts.length > 20000 || Buffer.byteLength(JSON.stringify(packet)) > 8 * 1024 * 1024) {
    throw new Error('Evidence packet exceeds the bounded publication budget');
  }
  const timestamp = (value) => typeof value === 'string'
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
  if (packet.sourcePath !== `.github/workflows/${packet.workflow}.md`
    || ![packet.observedAt, packet.windowStart, packet.windowEnd].every(timestamp)
    || Date.parse(packet.windowEnd) > Date.parse(packet.observedAt)) {
    throw new Error('Invalid evidence source identity, UTC capture or cutoff');
  }
  const keys = new Set();
  for (const fact of facts) {
    const key = JSON.stringify([fact['fact-kind'], fact['parent-id'] ?? '', fact['fact-id']]);
    if (keys.has(key)) throw new Error('Duplicate evidence fact identity');
    keys.add(key);
    for (const [field, value] of Object.entries(fact)) {
      if (typeof value === 'string' && (!value.trim() || value.length > 16384)) throw new Error('Invalid bounded evidence text');
      if (['at', 'end-at', 'accepted-at'].includes(field)
        && (!timestamp(value) || Date.parse(value) > Date.parse(packet.observedAt))) throw new Error('Invalid evidence timestamp');
      if (field === 'url') {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid safe HTTPS evidence URL');
      }
      if (field === 'ref' && (!/^[A-Za-z0-9][A-Za-z0-9:._/-]*$/.test(value)
        || /^(?:HEAD|main|master|refs\/heads\/)/i.test(value))) throw new Error('Invalid immutable evidence reference');
    }
  }
  return packet;
}

export function operationalValueEvidenceJsonl(ledger) {
  return `${JSON.stringify({ schema_version: 2, kind: 'operational_value_evidence',
    operational_value_evidence: exportOperationalValueEvidence(ledger) })}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const input = JSON.parse(readFileSync(process.argv[2] ?? 0, 'utf8'));
  const jsonl = operationalValueEvidenceJsonl(input);
  if (process.argv[3]) writeFileSync(process.argv[3], jsonl);
  else process.stdout.write(jsonl);
}
