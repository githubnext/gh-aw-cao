import { h } from '../dom.js';
import { formatClockDuration, formatNumber } from '../view-formatters.js';
import { renderDlRow, renderIconSpan } from './ui-primitives.js';

const LONG_RUNNING_SECONDS = 30 * 60;
const STALE_HOURS = 24;

/**
 * @param {Array<Record<string, unknown>>} rows
 */
export function buildAgentMarketplaceModel(rows) {
  return [...rows
    .map(normalizeAgent)
    .reduce((byId, agent) => {
      const existing = byId.get(agent.id);
      if (!existing || agent.totalRuntimeSeconds > existing.totalRuntimeSeconds) byId.set(agent.id, agent);
      return byId;
    }, new Map()).values()];
}

/** @param {ReturnType<typeof normalizeAgent>} agent */
export function renderAgentTile(agent) {
  const badges = [
    agent.longRunning ? h('span', { className: 'agent-badge agent-badge-warning' }, 'Long running') : null,
    agent.stale ? h('span', { className: 'agent-badge agent-badge-stale' }, 'Stale') : null
  ];
  return h(
    'details',
    { className: 'agent-marketplace-tile', role: 'listitem', open: false, 'data-agent-name': agent.name },
    h(
      'summary',
      { className: 'agent-marketplace-summary' },
      renderIconSpan('agent-marketplace-icon', agent.icon, { ariaHidden: true }),
      h('span', { className: 'agent-marketplace-title' }, agent.name),
      h('span', { className: 'agent-marketplace-state' }, agent.state)
    ),
    h('div', { className: 'agent-marketplace-card' },
      h('p', { className: 'agent-marketplace-description' }, agent.description),
      h('div', { className: 'agent-marketplace-badges' }, ...badges),
      h('dl', { className: 'agent-marketplace-facts' },
        renderDlRow('Total time run', formatClockDuration(agent.totalRuntimeSeconds)),
        renderDlRow('Runs', formatNumber(agent.runCount)),
        renderDlRow('Last observed', agent.lastObserved || 'Unknown'),
        renderDlRow('Permissions', agent.permissions)
      )
    )
  );
}

/** @param {string} sort */
export function agentComparator(sort) {
  /** @param {ReturnType<typeof normalizeAgent>} left @param {ReturnType<typeof normalizeAgent>} right */
  return (left, right) => sort === 'name'
    ? left.name.localeCompare(right.name)
    : sort === 'status'
      ? left.state.localeCompare(right.state) || right.totalRuntimeSeconds - left.totalRuntimeSeconds
      : right.totalRuntimeSeconds - left.totalRuntimeSeconds || left.name.localeCompare(right.name);
}

/** @param {Record<string, unknown>} row */
function normalizeAgent(row) {
  const runtime = Number(row['total-runtime-seconds'] ?? row['total-run-time-seconds']);
  const totalRuntimeSeconds = Number.isFinite(runtime) ? Math.max(0, runtime) : 0;
  const observed = text(row['last-observed-at'] ?? row['observed-at'] ?? '');
  const ageHours = observed ? (Date.now() - Date.parse(observed)) / 3_600_000 : Number.POSITIVE_INFINITY;
  return {
    id: text(row['agent-id']) || text(row['agent-name']) || 'unknown-agent',
    name: text(row['agent-name']) || 'Unknown agent',
    icon: text(row['agent-icon']) || 'copilot',
    description: text(row['agent-description']) || 'Agent assignment and runtime telemetry.',
    permissions: text(row.permissions) || 'Not declared',
    state: text(row['agent-state']) || 'unknown',
    totalRuntimeSeconds,
    runCount: Number(row['run-count']) || 0,
    lastObserved: observed ? new Date(observed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    longRunning: Boolean(row['long-running']) || totalRuntimeSeconds >= LONG_RUNNING_SECONDS,
    stale: Boolean(row.stale) || !Number.isFinite(Date.parse(observed)) || ageHours >= STALE_HOURS
  };
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}
