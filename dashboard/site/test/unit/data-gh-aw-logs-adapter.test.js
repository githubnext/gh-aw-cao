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
          job_details: [{
            id: 404,
            name: 'agent',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-09-09T04:00:00Z',
            completed_at: '2026-09-09T04:01:00Z'
          }],
          mcp_tool_usage: {
            tool_calls: [{
              tool_call_id: 'call-7',
              timestamp: '2026-09-09T04:00:15Z',
              server_name: 'github',
              tool_name: 'get_file',
              input_size: 42,
              output_size: 128,
              status: 'success'
            }]
          },
          agentic_assessments: [{
            kind: 'deterministic',
            severity: 'low',
            summary: 'Stable result'
          }]
        }
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
          job_details: [{
            id: 404,
            name: 'agent',
            status: 'completed',
            conclusion: 'success',
            started_at: '2026-09-09T04:00:00Z',
            completed_at: '2026-09-09T04:01:00Z'
          }],
          audit_path: '/tmp/run-303/audit.json',
          audit: {
            mcp_tool_usage: {
              tool_calls: [{
                tool_call_id: 'call-7',
                timestamp: '2026-09-09T04:00:15Z',
                server_name: 'github',
                tool_name: 'get_file',
                input_size: 42,
                output_size: 128,
                status: 'success'
              }]
            },
            key_findings: [{ title: 'Slow response', severity: 'medium' }],
            missing_tools: [{ tool: 'search', timestamp: '2026-09-09T04:00:20Z' }],
            skill_activations: [{ name: 'review', status: 'success', timestamp: '2026-09-09T04:00:30Z' }],
            created_items: [{
              type: 'create_issue',
              url: 'https://github.com/githubnext/gh-aw-cao/issues/42',
              number: 42,
              repo: 'githubnext/gh-aw-cao',
              timestamp: '2026-09-09T04:00:45Z'
            }]
          },
          firewall_analysis: {
            requests_by_domain: {
              'api.github.com:443': { allowed: 3, blocked: 1 },
              'objects.githubusercontent.com:443': { allowed: 2, blocked: 0 }
            }
          },
          agent_id: '',
          agent_version: '',
          model_id: '',
          engine_id: '',
          model: '',
          aw_info: {
            engine_id: 'copilot',
            engine_name: 'GitHub Copilot CLI',
            model: 'gpt-5.4',
            agent_version: '1.0.83',
            cli_version: 'v0.89.4',
            workflow_name: 'Dashboard',
            staged: false,
            cache_memory: true,
            created_at: '2026-09-09T03:59:00Z',
            awf_version: 'v0.28.15'
          }
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
      records: 4,
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
        aicTotal: 2.5,
        agentId: 'copilot',
        agentVersion: '1.0.83',
        modelId: 'gpt-5.4',
        ghAwVersion: 'v0.89.4',
        engine: 'GitHub Copilot CLI',
        engineId: 'copilot',
        engineVersion: '1.0.83',
        requestedModel: 'gpt-5.4',
        resolvedModel: 'gpt-5.4',
        firewallVersion: 'v0.28.15'
      })
    ]);
    expect(batch.jobs).toEqual([
      expect.objectContaining({
        id: 'github:job:404',
        runId: 'github:run:303:attempt:1',
        name: 'agent',
        conclusion: 'success'
      })
    ]);
    expect(batch.sessions).toHaveLength(2);
    expect(batch.events.map((event) => event.type)).toEqual(expect.arrayContaining([
      'workflow_run_started',
      'workflow_run_completed',
      'workflow_run_usage',
      'workflow_run_assessment',
      'agent.session',
      'tool.call',
      'tool.result',
      'audit.finding',
      'audit.missing_tool',
      'audit.skill_activation',
      'net_allowed',
      'net_blocked',
      'safe_output.created',
      'github_api_rate_limit'
    ]));
    expect(batch.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'mcp',
        type: 'tool.call',
        correlationId: 'call-7',
        summary: 'github/get_file'
      }),
      expect.objectContaining({
        source: 'mcp',
        type: 'tool.result',
        correlationId: 'call-7',
        status: 'success'
      }),
      expect.objectContaining({
        source: 'safe-output',
        type: 'safe_output.created',
        correlationId: 'https://github.com/githubnext/gh-aw-cao/issues/42'
      }),
      expect.objectContaining({
        source: 'firewall',
        type: 'net_allowed',
        domain: 'api.github.com',
        decision: 'allowed',
        requestCount: 3
      }),
      expect.objectContaining({
        source: 'firewall',
        type: 'net_blocked',
        domain: 'api.github.com',
        decision: 'denied',
        requestCount: 1
      })
    ]));
  });

  it('resolves pathless raw runs from declared workflow name hints', () => {
    const content = JSON.stringify({
      schema_version: 2,
      kind: 'workflow_runs',
      request: { repository: 'githubnext/gh-aw-cao' },
      payload: [{
        databaseId: 303,
        attempt: 1,
        workflowName: 'Dashboard',
        displayTitle: 'Build dashboard',
        status: 'completed',
        conclusion: 'success',
        createdAt: '2026-09-09T03:59:00Z',
        updatedAt: '2026-09-09T04:01:00Z'
      }]
    });

    const batch = normalize(adaptCachedGhAwJsonl(content, {
      workflowHints: [{
        owner: 'githubnext',
        repository: 'gh-aw-cao',
        name: 'Dashboard',
        path: '.github/workflows/dashboard.md'
      }]
    }).observations);

    expect(batch.workflows).toEqual([
      expect.objectContaining({
        id: 'workflow:githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fdashboard.md',
        path: '.github/workflows/dashboard.md'
      })
    ]);
    expect(batch.runs).toEqual([
      expect.objectContaining({
        workflowId: batch.workflows[0].id,
        workflowPath: '.github/workflows/dashboard.md'
      })
    ]);
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