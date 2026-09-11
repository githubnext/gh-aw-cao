import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { adaptCachedGhAwJsonl, adaptGhAwLogs } from '../../src/data/adapters/gh-aw-logs.js';
import { relationshipErrors } from '../../src/data/model/schema.js';
import { normalize } from '../../src/data/normalize/index.js';

const fixtureRoot = resolve('test/fixtures/gh-aw-logs');

/** @param {string} directory */
function files(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => {
      const filePath = join(entry.parentPath, entry.name);
      return {
        path: relative(fixtureRoot, filePath),
        content: readFileSync(filePath, 'utf8')
      };
    });
}

describe('gh-aw logs adapter', () => {
  it('converts agent, gateway, and firewall JSONL into one ordered operational session', () => {
    const context = JSON.parse(readFileSync(join(fixtureRoot, 'context.json'), 'utf8'));
    const adapted = adaptGhAwLogs({ ...context, files: files(fixtureRoot) });
    const batch = normalize(adapted.observations);

    expect(relationshipErrors(batch)).toEqual([]);
    expect(batch.sessions).toEqual([
      expect.objectContaining({
        runId: 'github:run:303:attempt:1',
        jobId: 'github:job:404',
        kind: 'unified-operational-log'
      })
    ]);
    expect(batch.events.map((event) => [event.sequence, event.source, event.type])).toEqual([
      [0, 'agent', 'agent_turn'],
      [1, 'gateway', 'tool_call'],
      [2, 'agent', 'agent_tool_start'],
      [3, 'agent', 'agent_tool_done'],
      [4, 'firewall', 'net_allowed'],
      [5, 'agent', 'assistant_message']
    ]);
    expect(batch.events.filter((event) => event.correlationId === 'call-1')).toHaveLength(3);
  });

  it('maps cached raw runs and agentic runs into unified runs, sessions, and events', () => {
    const content = [
      {
        schema_version: 2,
        kind: 'workflow_runs',
        request: {
          host: 'github.com',
          repository: 'githubnext/gh-aw-cao',
          args: ['run', 'list']
        },
        payload: [{
          databaseId: 303,
          attempt: 1,
          number: 7,
          workflowName: 'Dashboard',
          displayTitle: 'Build dashboard',
          event: 'workflow_dispatch',
          status: 'completed',
          conclusion: 'success',
          headBranch: 'main',
          headSha: 'abc123',
          createdAt: '2026-09-09T03:59:00Z',
          startedAt: '2026-09-09T04:00:00Z',
          updatedAt: '2026-09-09T04:01:00Z',
          url: 'https://github.com/githubnext/gh-aw-cao/actions/runs/303'
        }]
      },
      {
        schema_version: 2,
        kind: 'run',
        run: {
          run_id: 303,
          run_attempt: '1',
          organization: 'githubnext',
          repository: 'githubnext/gh-aw-cao',
          workflow_name: 'Dashboard',
          workflow_path: '.github/workflows/dashboard.md',
          display_title: 'Build dashboard',
          event: 'workflow_dispatch',
          status: 'completed',
          conclusion: 'success',
          classification: 'success',
          created_at: '2026-09-09T03:59:00Z',
          started_at: '2026-09-09T04:00:00Z',
          updated_at: '2026-09-09T04:01:00Z',
          token_usage_summary: { total_aic: 2.5 },
          agentic_assessments: [{
            kind: 'deterministic',
            severity: 'low',
            summary: 'Stable result'
          }]
        }
      },
      {
        schema_version: 2,
        kind: 'github_api_rate_limit',
        rate_limit: {
          host: 'github.com',
          start: { limit: 15000, remaining: 15000, reset: 1, used: 0 },
          end: { limit: 15000, remaining: 14990, reset: 2, used: 10 }
        }
      }
    ].map((record) => JSON.stringify(record)).join('\n');
    const adapted = adaptCachedGhAwJsonl(content, {
      context: JSON.parse(readFileSync(join(fixtureRoot, 'context.json'), 'utf8'))
    });
    const batch = normalize(adapted.observations);

    expect(adapted).toMatchObject({
      records: 3,
      rawPayloadRecords: 1,
      rawRuns: 1,
      agenticRuns: 1,
      sessions: 2,
      rateLimits: 1,
      mappedRateLimits: 1
    });
    expect(relationshipErrors(batch)).toEqual([]);
    expect(batch.runs).toEqual([
      expect.objectContaining({
        id: 'github:run:303:attempt:1',
        workflowPath: '.github/workflows/dashboard.md',
        number: 7,
        aicTotal: 2.5
      })
    ]);
    expect(batch.sessions).toHaveLength(2);
    expect(batch.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'workflow_run_started',
      'workflow_run_completed',
      'workflow_run_usage',
      'workflow_run_assessment',
      'github_api_rate_limit'
    ]));
  });

  it('rejects unsupported cached JSONL schema versions and kinds', () => {
    expect(() => adaptCachedGhAwJsonl(
      '{"schema_version":3,"kind":"run","run":{}}\n'
    )).toThrow('Unsupported gh-aw JSONL schema version');
    expect(() => adaptCachedGhAwJsonl(
      '{"schema_version":2,"kind":"unknown"}\n'
    )).toThrow('Unsupported gh-aw JSONL kind');
  });
});