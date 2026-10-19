import { parseUnifiedSessionDocument } from '../src/data/adapters/unified-session.js';
import fixture from './fixtures/model-resolution-sessions.json' with { type: 'json' };

/** @typedef {{ line: number|null, envelope: { type: string, data: Record<string, unknown>, provenance: Record<string, unknown> } }} FixtureRecord */
/** @typedef {{ workflow: string, run: number, attempt: number, repository: string, 'head-sha': string, 'session-clock': string|null, records: FixtureRecord[] }} FixtureSession */

export const originalSessions = /** @type {FixtureSession[]} */ (fixture.sessions);

/** @param {string} workflow */
export function realSession(workflow) {
  const found = originalSessions.find((entry) => entry.workflow === workflow);
  if (!found) throw new Error(`missing fixture session ${workflow}`);
  return found;
}

/**
 * Builds a documented controlled replay from a real envelope: only the identified
 * resolution line is kept, its data changes are applied, and the run identity and
 * session clock are the variant's declared test values.
 * @param {string} id
 * @returns {FixtureSession}
 */
export function replay(id) {
  const variant = fixture['controlled-replays'].variants.find((entry) => entry.id === id);
  if (!variant) throw new Error(`missing controlled replay ${id}`);
  const base = originalSessions.find((entry) => entry.run === variant['derived-from'].run);
  if (!base) throw new Error(`missing replay base ${variant['derived-from'].run}`);
  const clock = variant['session-clock'] === null ? undefined : Date.parse(variant['session-clock']);
  const records = base.records
    .filter((record) => record.envelope.type !== 'model.resolution' || record.line === variant['derived-from'].line)
    .map((record) => {
      const envelope = structuredClone(record.envelope);
      if (envelope.type === 'workflow.info') {
        envelope.data.run_id = variant['test-run'];
        if (clock === undefined) delete envelope.provenance.timestampMs;
        else envelope.provenance.timestampMs = clock;
      }
      if (envelope.type === 'model.resolution') Object.assign(envelope.data, variant.changes);
      return { line: record.line, envelope };
    });
  return { ...base, run: variant['test-run'], 'session-clock': variant['session-clock'], records };
}

/**
 * Wraps one fixture session in the cached gh-aw run envelope consumed by ingestion.
 * @param {FixtureSession} source @param {number} now @param {{ attempt?: number, workflow?: string }} [overrides]
 */
export function runCacheLine(source, now, overrides = {}) {
  const attempt = overrides.attempt ?? source.attempt;
  const text = source.records.map((record) => JSON.stringify(record.envelope)).join('\n');
  const document = parseUnifiedSessionDocument(text, 'usage/aw_session.jsonl', { runId: String(source.run), attempt });
  const engine = source.records.find((record) => record.envelope.type === 'workflow.info')?.envelope.data.engine_id;
  return JSON.stringify({
    schema_version: 5, kind: 'run',
    run: { run_id: source.run, run_attempt: attempt, organization: 'github', repository: source.repository,
      workflow_name: overrides.workflow ?? source.workflow, workflow_path: `.github/workflows/${source.workflow}.lock.yml`,
      // Cache-envelope bookkeeping only; routing clocks come from recorded session events.
      created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString(),
      ...(typeof engine === 'string' ? { engine, engine_id: engine } : {}),
      head_sha: source['head-sha'], status: 'completed', conclusion: 'success',
      cao_unified_session: { version: 1, path: 'usage/aw_session.jsonl', ...document }
    }
  });
}
