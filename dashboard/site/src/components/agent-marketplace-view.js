import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { formatNumber } from '../view-formatters.js';
import { findLink } from './link-content.js';
import { renderIconSpan } from './ui-primitives.js';
import { rowsFor } from './source-rows.js';

const LONG_RUNNING_SECONDS = 30 * 60;
const STALE_HOURS = 24;
const SMELLS_ICON_URL = new URL('../smells.svg', import.meta.url).href;

/** @typedef {{ name: string, role: string }} AgentMember */
/** @typedef {{ id: string, name: string, icon: string, description: string, permissions: string, state: string, owner: string, repositoryLink: import('./link-content.js').SafeLink | null, totalRuntimeSeconds: number, runCount: number, observedAt: string, lastObserved: string, featured: boolean, slow: boolean, stale: boolean, kind: string, workItemId: string, workflowKeys: string[], smellReasons: string[], members: AgentMember[] }} AgentCatalogEntry */

/**
 * @param {import('./ui-elements.js').ElementRenderContext} context
 * @returns {HTMLElement}
 */
export function renderAgentMarketplaceView(context) {
  const agents = catalogAgents(
    rowsFor(context.sources, 'workflows'),
    rowsFor(context.sources, 'agent-assignments'),
    rowsFor(context.sources, 'security-observations'),
    rowsFor(context.sources, 'agent-smells')
  );
  const grid = h('div', { className: 'agent-marketplace-grid', role: 'list' });
  const search = /** @type {HTMLInputElement} */ (h('input', {
    type: 'search', placeholder: 'Search agents', 'aria-label': 'Search agents', spellcheck: 'false'
  }));
  const owner = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Filter agents by owner' },
    h('option', { value: '' }, 'All owners'),
    ...[...new Set(agents.map((agent) => agent.owner))].sort().map((name) => h('option', { value: name }, name))
  ));
  const status = /** @type {HTMLSelectElement} */ (h('select', { 'aria-label': 'Filter agents by status' },
    h('option', { value: 'all' }, 'All statuses'),
    h('option', { value: 'smells' }, `Smells (${agents.filter((agent) => agentSmellReasons(agent).length > 0).length})`),
    h('option', { value: 'disabled' }, `Disabled (${agents.filter((agent) => agent.state === 'disabled').length})`),
    h('option', { value: 'slow' }, `Slow (${agents.filter((agent) => agent.slow).length})`),
    h('option', { value: 'stale' }, `Stale (${agents.filter((agent) => agent.stale).length})`)
  ));
  const count = h('span', { className: 'agent-marketplace-count', 'aria-live': 'polite' });
  let sortOrder = 'runtime';
  let activeKind = agents.some((agent) => agent.kind === 'package') ? 'package' : 'all';
  /** @type {HTMLButtonElement[]} */
  const facetButtons = [];
  const render = () => {
    const query = search.value.trim().toLowerCase();
    const visible = agents.filter((agent) => (activeKind === 'all' || agent.kind === activeKind)
      && (status.value === 'all'
        || (status.value === 'smells' && agentSmellReasons(agent).length > 0)
        || (status.value === 'disabled' && agent.state === 'disabled')
        || (status.value === 'stale' && agent.stale)
        || (status.value === 'slow' && agent.slow))
      && (!owner.value || agent.owner === owner.value)
      && (!query || [agent.name, agent.description, ...agent.members.map((member) => member.name)].join(' ').toLowerCase().includes(query)));
    const sorted = visible.sort(agentComparator(sortOrder));
    grid.replaceChildren(...sorted.map((agent) => renderAgentTile(agent)));
    count.textContent = `${visible.length} of ${agents.length} agents`;
    for (const button of facetButtons) {
      if (button.dataset.facet === activeKind) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    }
  };

  /**
   * @param {string} label
   * @param {string} facet
   * @param {string} icon
   * @param {number} facetCount
   */
  const facetButton = (label, facet, icon, facetCount) => {
    const button = /** @type {HTMLButtonElement} */ (h('button', {
      type: 'button', className: 'agent-marketplace-facet', 'data-facet': facet,
      onClick: () => { activeKind = facet; render(); }
    }, icon === 'smell' ? scentLines() : renderIconSpan('agent-marketplace-facet-icon', icon, { ariaHidden: true }),
    h('span', null, label),
    h('small', null, formatNumber(facetCount))));
    facetButtons.push(button);
    return button;
  };
  const facets = h('nav', { className: 'agent-marketplace-filters', 'aria-label': 'Agent filters' },
    facetButton('Packages', 'package', 'package', agents.filter((agent) => agent.kind === 'package').length),
    facetButton('Standalone', 'standalone', 'workflow', agents.filter((agent) => agent.kind === 'standalone').length),
    facetButton('All agents', 'all', 'apps', agents.length)
  );

  const sort = h(
    'label',
    { className: 'agent-marketplace-sort' },
    'Sort by ',
    h(
      'select',
      {
        'aria-label': 'Sort agents',
        onChange: (/** @type {Event} */ event) => {
          sortOrder = /** @type {HTMLSelectElement} */ (event.currentTarget).value;
          render();
        }
      },
      h('option', { value: 'runtime' }, 'Total time run'),
      h('option', { value: 'name' }, 'Name'),
      h('option', { value: 'status' }, 'Status')
    )
  );
  search.addEventListener('input', render);
  owner.addEventListener('change', render);
  status.addEventListener('change', render);
  render();

  return h(
    'section',
    { className: 'agent-marketplace-view', 'aria-label': context.title },
    h('div', { className: 'agent-marketplace-toolbar' },
      h('label', { className: 'agent-marketplace-search' }, renderIconSpan('agent-marketplace-search-icon', 'search', { ariaHidden: true }), search),
      status,
      owner,
      sort,
      count),
    facets,
    agents.length > 0 ? grid : h('p', { role: 'status' }, 'No installed agents are available in the selected scope.')
  );
}

/** @param {ReturnType<typeof normalizeAgent>} agent */
function renderAgentTile(agent) {
  const smellReasons = agentSmellReasons(agent);
  const badges = [
    smellReasons.length > 0 ? h('span', { className: 'agent-badge agent-badge-smell', title: smellReasons.join(', ') }, 'Smells') : null,
    agent.state === 'disabled' ? h('span', { className: 'agent-badge agent-badge-disabled' }, 'Disabled') : null,
    agent.slow ? h('span', { className: 'agent-badge agent-badge-warning' }, 'Slow') : null,
    agent.stale ? h('span', { className: 'agent-badge agent-badge-stale' }, 'Stale') : null
  ];
  const indicators = [
    agent.state === 'disabled' ? h('span', { className: 'agent-icon-indicator agent-icon-disabled', title: 'Disabled', 'aria-label': 'Disabled' }, octicon('stop')) : null,
    agent.slow ? h('span', { className: 'agent-icon-indicator agent-icon-slow', title: 'Slow average runtime', 'aria-label': 'Slow' }, octicon('clock-fill')) : null,
    agent.stale ? h('span', { className: 'agent-icon-indicator agent-icon-stale', title: 'Stale runtime telemetry', 'aria-label': 'Stale' }, octicon('history')) : null
  ];
  return h(
    'article',
    { className: 'agent-marketplace-tile', role: 'listitem', 'data-agent-name': agent.name },
    h(
      'a',
      { className: 'agent-marketplace-summary', href: agentDetailHref(agent), 'aria-label': `View ${agent.name}` },
      h('span', { className: 'agent-marketplace-icon-wrap' },
        renderIconSpan('agent-marketplace-icon', agent.icon, { ariaHidden: true }),
        ...indicators
      ),
      h('span', { className: 'agent-marketplace-copy' },
        h('span', { className: 'agent-marketplace-heading' },
          h('span', { className: 'agent-marketplace-title' }, agent.name),
          h('span', { className: `agent-marketplace-kind agent-marketplace-kind-${agent.kind}` }, agent.kind === 'package' ? 'Package' : 'Standalone')
        ),
        h('span', { className: 'agent-marketplace-description' }, agent.description),
        h('span', { className: 'agent-marketplace-owner' }, agent.owner),
        h('span', { className: 'agent-marketplace-badges' }, ...badges)
      )
    )
  );
}

/** @param {AgentCatalogEntry} agent */
function agentDetailHref(agent) {
  if (agent.kind === 'package') return `#page-package-detail?package=${encodeURIComponent(agent.id.replace(/^package:[^:]+:/, ''))}`;
  const workflowKey = agent.workflowKeys[0];
  return workflowKey ? `#page-workflow-runtime?workflow=${encodeURIComponent(workflowKey)}` : '#page-agents';
}

/** @param {AgentCatalogEntry} agent */
export function agentSmellReasons(agent) {
  return agent.smellReasons;
}

export function smellMark() {
  return h('span', { className: 'agent-smell-mark', 'aria-hidden': 'true' }, octicon('copilot'), scentLines());
}

/**
 * @param {Record<string, unknown>[]} workflows
 * @param {Record<string, unknown>[]} assignments
 * @param {Record<string, unknown>[]} securityObservations
 * @param {Record<string, unknown>[]} smellObservations
 */
export function agentSmellNotifications(workflows, assignments, securityObservations = [], smellObservations = []) {
  const legacySecurityObservations = smellObservations.length > 0 ? [] : securityObservations;
  return catalogAgents(workflows, assignments, legacySecurityObservations, smellObservations).flatMap((agent) => {
    const reasons = agentSmellReasons(agent);
    if (reasons.length === 0) return [];
    const observedAt = Date.parse(agent.observedAt);
    const repositoryHref = agent.repositoryLink?.externalHref ?? agent.repositoryLink?.href;
    return [{
      'attention-signal-id': `agent-smell:${agent.id}`,
      'signal-type': 'agent-smell',
      objective: `Agent smell: ${agent.name}`,
      scope: agent.owner,
      reason: reasons.join(', '),
      'expected-actor': 'repository-owner',
      'age-seconds': Number.isFinite(observedAt) ? Math.max(0, Math.floor((Date.now() - observedAt) / 1000)) : 0,
      'consequence-tier': 'high',
      priority: 1,
      icon: 'copilot',
      ...(repositoryHref ? { 'evidence-link': {
        relation: 'evidence',
        href: repositoryHref,
        label: `View ${agent.name}`,
        'dashboard-href': '#page-agents',
        'dashboard-label': `View ${agent.name} in Agents`
      } } : {})
    }];
  });
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {{ signalType: string, objectivePrefix: string, icon: string, expectedActor: string, navigationHref: string }} options
 */
export function smellObservationNotifications(rows, options) {
  return rows.map((row) => {
    const observedAt = Date.parse(text(row['observed-at']));
    const severity = text(row['smell-severity']);
    const evidenceLink = findLink(row, 'evidence-link') ?? findLink(row, 'run-link') ?? findLink(row, 'repository-link');
    return {
      'attention-signal-id': `${options.signalType}:${text(row['smell-observation-id']) || text(row['smell-id'])}`,
      'signal-type': options.signalType,
      objective: `${options.objectivePrefix}: ${text(row['smell-name']) || text(row['smell-id']) || 'Smell detected'}`,
      scope: repositoryOwner(row),
      reason: text(row['smell-summary']) || text(row['smell-evidence']) || 'Review the supporting evidence.',
      action: text(row['smell-recommendation']) || 'Review and remediate the finding.',
      'expected-actor': options.expectedActor,
      'age-seconds': Number.isFinite(observedAt) ? Math.max(0, Math.floor((Date.now() - observedAt) / 1000)) : 0,
      'consequence-tier': severity === 'high' ? 'high' : severity === 'low' ? 'low' : 'medium',
      priority: severity === 'high' ? 1 : severity === 'low' ? 3 : 2,
      icon: options.icon,
      ...(evidenceLink ? { 'evidence-link': {
        relation: 'evidence',
        href: evidenceLink.href,
        label: evidenceLink.label,
        'dashboard-href': options.navigationHref,
        'dashboard-label': 'Review finding'
      } } : {})
    };
  });
}

function scentLines() {
  return h('svg', {
    className: 'agent-scent-lines', viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false'
  },
  h('use', { href: `${SMELLS_ICON_URL}#smells-icon` })
  );
}

/**
 * @param {Record<string, unknown>[]} workflows
 * @param {Record<string, unknown>[]} assignmentRows
 * @param {Record<string, unknown>[]} securityObservations
 * @param {Record<string, unknown>[]} smellObservations
 */
function catalogAgents(workflows, assignmentRows, securityObservations = [], smellObservations = []) {
  const assignments = assignmentRows.map(normalizeAgent);
  if (workflows.length === 0) {
    const agents = [...assignments.reduce((byId, agent) => {
      const existing = byId.get(agent.id);
      if (!existing || agent.totalRuntimeSeconds > existing.totalRuntimeSeconds) byId.set(agent.id, agent);
      return byId;
    }, /** @type {Map<string, AgentCatalogEntry>} */ (new Map())).values()];
    return agents
      .filter((agent) => isPresentableAgentName(agent.name))
      .map((agent) => ({ ...agent, smellReasons: smellReasons(agent.workflowKeys, securityObservations, smellObservations) }));
  }

  /** @type {Map<string, Record<string, unknown>[]>} */
  const groups = new Map();
  for (const workflow of workflows) {
    const packageId = text(workflow.package);
    const packaged = packageId && packageId !== 'standalone';
    const key = packaged ? `package:${repositoryOwner(workflow)}:${packageId}` : `workflow:${workflowKey(workflow)}`;
    const entries = groups.get(key) ?? [];
    entries.push(workflow);
    groups.set(key, entries);
  }
  return [...groups].map(([key, members]) => {
    const primary = members.find((member) => text(member['workflow-role']) === 'orchestrator') ?? members[0];
    const memberKeys = new Set(members.map(workflowKey));
    const runtime = assignments.filter((assignment) => memberKeys.has(assignment.workItemId.replace(/:run:.+$/, '')));
    const totalRuntimeSeconds = runtime.reduce((total, assignment) => total + assignment.totalRuntimeSeconds, 0);
    const runCount = runtime.reduce((total, assignment) => total + assignment.runCount, 0);
    const observed = runtime.map((assignment) => assignment.observedAt).filter(Boolean).sort().at(-1) ?? '';
    const packageEntry = key.startsWith('package:');
    const orchestratorCount = members.filter((member) => text(member['workflow-role']) === 'orchestrator').length;
    const workerCount = members.filter((member) => text(member['workflow-role']) === 'worker').length;
    const permissions = [...new Set(members.flatMap(workflowPermissions))];
    const states = runtime.map((assignment) => assignment.state);
    const state = states.includes('active') ? 'active'
      : states.includes('blocked') ? 'blocked'
        : text(primary['workflow-active']) === 'false' ? 'disabled' : 'available';
    return {
      id: key,
      name: packageEntry ? text(primary['package-name']) || text(primary['workflow-name']) : text(primary['workflow-name']) || text(primary.workflow),
      icon: text(primary['package-icon']) || (packageEntry ? 'package' : 'workflow'),
      description: text(primary['agent-description']) || text(primary['package-description']) || text(primary['workflow-description']) || (packageEntry
        ? `${members.length} workflow${members.length === 1 ? '' : 's'} with ${orchestratorCount} orchestrator${orchestratorCount === 1 ? '' : 's'}${workerCount ? ` and ${workerCount} worker${workerCount === 1 ? '' : 's'}` : ''}.`
        : `${text(primary['workflow-name']) || 'Agent'} automation.`),
      permissions: permissions.join(', ') || 'Not declared',
      state,
      owner: repositoryOwner(primary),
      repositoryLink: findLink(primary, 'repository-link'),
      totalRuntimeSeconds,
      runCount,
      observedAt: observed,
      lastObserved: observed ? new Date(observed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
      featured: packageEntry && primary['inventory-ready'] === true && Number(primary['package-rollout-percent']) === 100,
      slow: runCount > 0 && totalRuntimeSeconds / runCount >= LONG_RUNNING_SECONDS,
      stale: runtime.length > 0 && runtime.every((assignment) => assignment.stale),
      kind: packageEntry ? 'package' : 'standalone',
      workItemId: '',
      workflowKeys: [...memberKeys],
      smellReasons: smellReasons([...memberKeys], securityObservations, smellObservations),
      members: members.map((member) => ({
        name: text(member['workflow-name']) || text(member.workflow),
        role: text(member['workflow-role']) || 'standalone'
      }))
    };
  }).filter((agent) => isPresentableAgentName(agent.name));
}

/** @param {string} name */
function isPresentableAgentName(name) {
  const normalized = name.trim().replaceAll('\\', '/');
  return normalized.length > 0
    && !normalized.startsWith('/')
    && !normalized.startsWith('[')
    && !normalized.startsWith('1.')
    && !/^\.github\/workflows(?:\/|$)/i.test(normalized);
}

/** @param {Record<string, unknown>} workflow */
function workflowKey(workflow) {
  return `${text(workflow.organization)}/${text(workflow.repository)}:${text(workflow.workflow)}`.toLowerCase();
}

/** @param {Record<string, unknown>} workflow */
function workflowPermissions(workflow) {
  const permissions = workflow['gh-aw-metadata'] && typeof workflow['gh-aw-metadata'] === 'object'
    ? /** @type {Record<string, unknown>} */ (workflow['gh-aw-metadata']).permissions
    : null;
  return permissions && typeof permissions === 'object'
    ? Object.entries(permissions).map(([name, level]) => `${name}: ${level}`)
    : [];
}

/** @param {Record<string, unknown>} row @returns {AgentCatalogEntry} */
function normalizeAgent(row) {
  const runtime = Number(row['total-runtime-seconds'] ?? row['total-run-time-seconds']);
  const totalRuntimeSeconds = Number.isFinite(runtime) ? Math.max(0, runtime) : 0;
  const observed = String(row['last-observed-at'] ?? row['observed-at'] ?? '');
  const ageHours = observed ? (Date.now() - Date.parse(observed)) / 3_600_000 : Number.POSITIVE_INFINITY;
  return {
    id: text(row['agent-id']) || text(row['agent-name']) || 'unknown-agent',
    name: text(row['agent-name']) || 'Unknown agent',
    icon: text(row['agent-icon']) || 'copilot',
    description: text(row['agent-description']) || 'Agent assignment and runtime telemetry.',
    permissions: text(row.permissions) || 'Not declared',
    state: text(row['agent-state']) || 'unknown',
    owner: repositoryOwner(row),
    repositoryLink: findLink(row, 'repository-link'),
    totalRuntimeSeconds,
    runCount: Number(row['run-count']) || 0,
    lastObserved: observed ? new Date(observed).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    featured: Boolean(row.featured),
    slow: Boolean(row['long-running']) || (Number(row['run-count']) > 0 && totalRuntimeSeconds / Number(row['run-count']) >= LONG_RUNNING_SECONDS),
    stale: Boolean(row.stale) || !Number.isFinite(Date.parse(observed)) || ageHours >= STALE_HOURS,
    kind: 'standalone',
    workItemId: text(row['work-item-id']).toLowerCase(),
    workflowKeys: [text(row['work-item-id']).replace(/:run:.+$/, '').toLowerCase()].filter(Boolean),
    smellReasons: [],
    observedAt: observed,
    members: /** @type {AgentMember[]} */ ([])
  };
}

/** @param {string[]} agentWorkflowKeys @param {Record<string, unknown>[]} observations */
function threatReasons(agentWorkflowKeys, observations) {
  const keys = new Set(agentWorkflowKeys.map(threatWorkflowKey));
  return [...new Set(observations
    .filter((row) => text(row['security-feature']) === 'threat-detection'
      && text(row['security-status']) === 'detected'
      && keys.has(threatWorkflowKey(workflowKey(row))))
    .map((row) => `${text(row['security-signal']) || 'Threat'} detected`))];
}

/**
 * @param {string[]} agentWorkflowKeys
 * @param {Record<string, unknown>[]} securityObservations
 * @param {Record<string, unknown>[]} smellObservations
 */
function smellReasons(agentWorkflowKeys, securityObservations, smellObservations) {
  const keys = new Set(agentWorkflowKeys.map(threatWorkflowKey));
  const structured = smellObservations
    .filter((row) => keys.has(threatWorkflowKey(workflowKey(row))))
    .map((row) => {
      const name = text(row['smell-name']) || text(row['smell-id']) || 'Agent smell';
      const summary = text(row['smell-summary']);
      return summary ? `${name}: ${summary}` : name;
    });
  return [...new Set([...structured, ...threatReasons(agentWorkflowKeys, securityObservations)])];
}

/** @param {string} key */
function threatWorkflowKey(key) {
  return key.replace(/\.lock\.ya?ml$/i, '').replace(/\.(?:md|ya?ml)$/i, '');
}

/** @param {string} sort */
function agentComparator(sort) {
  /** @param {ReturnType<typeof normalizeAgent>} left @param {ReturnType<typeof normalizeAgent>} right */
  return (left, right) => sort === 'name'
    ? left.name.localeCompare(right.name)
    : sort === 'status'
      ? left.state.localeCompare(right.state) || right.totalRuntimeSeconds - left.totalRuntimeSeconds
      : right.totalRuntimeSeconds - left.totalRuntimeSeconds || left.name.localeCompare(right.name);
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** @param {Record<string, unknown>} row */
function repositoryOwner(row) {
  const organization = text(row.organization);
  const repository = text(row.repository);
  if (organization && repository) return `${organization}/${repository}`;
  const workItemRepository = text(row['work-item-id']).split(':')[0];
  return organization || repository || (/^[^/\s]+\/[^/\s]+$/.test(workItemRepository) ? workItemRepository : 'Unknown owner');
}
