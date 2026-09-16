/**
 * Dashboard Language Specification constants used by the validator.
 */

import octiconNames from './octicon-names.json' with { type: 'json' };
import { DASHBOARD_QUERY_LIMITS } from './data/queries/declarative.js';
export {
  OUTCOME_DETAIL_SECTION_BODY_VALUES,
  PACKAGE_ROUTE_BODY_VALUES,
  WORK_VIEW_BODY_VALUES,
  WORK_VIEW_SECTION_KEYS,
  WORKFLOW_ROUTE_BODY_VALUES,
  WORKFLOW_ROUTE_PAGE_BODY_VALUES
} from './components/route-body-specification.js';

export const LANGUAGE_VERSION = '0.1.0';

export const IDENTIFIER_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const ROOT_KEYS = ['language-version', 'dashboard'];
export const DASHBOARD_KEYS = ['id', 'title', 'description', 'defaults', 'units', 'queries', 'card-templates', 'views', 'pages', 'github-url-base', 'repository', 'navigation', 'horizon', 'callouts', 'cli-actions'];
export const CARD_TEMPLATE_KEYS = ['id', 'icon', 'title', 'labels', 'details'];
export const DASHBOARD_HORIZON_KEYS = ['label', 'tooltip'];
export const CLI_ACTION_KEYS = ['id', 'label', 'description', 'icon', 'command', 'placement', 'arguments'];
export const CLI_ACTION_PLACEMENT_VALUES = ['toolbar', 'settings', 'view', 'row'];
export const CLI_ACTION_ARGUMENT_KEYS = ['id', 'label', 'description', 'type', 'flag', 'default'];
export const CLI_ACTION_ARGUMENT_TYPE_VALUES = ['boolean'];
export const MAX_CLI_ACTIONS = 20;
export const MAX_CLI_ACTION_ARGUMENTS = 10;
export const MAX_CLI_ACTION_COMMAND_LENGTH = 1000;

export const QUERY_KEYS = ['name', 'intent', 'description', 'from', 'time', 'joins', 'filter', 'compute', 'aggregate', 'predict', 'select', 'order-by', 'limit'];
export const QUERY_JOIN_KEYS = ['source', 'type', 'on', 'fields'];
export const QUERY_JOIN_TYPE_VALUES = ['inner', 'left'];
export const QUERY_JOIN_ON_KEYS = ['left', 'right'];
export const QUERY_JOIN_FIELD_KEYS = ['field', 'as'];
export const QUERY_FILTER_KEYS = ['predicates'];
export const QUERY_PREDICATE_KEYS = ['field', 'equals', 'in', 'includes', 'gte', 'lt', 'optional'];
export const QUERY_COMPUTE_KEYS = ['as', 'function', 'args'];
export const QUERY_COMPUTE_ARGUMENT_KEYS = ['field', 'value', 'context'];
export const QUERY_AGGREGATE_KEYS = ['by', 'values'];
export const QUERY_AGGREGATE_VALUE_KEYS = ['field', 'as', 'reducer', 'filter'];
export const QUERY_AGGREGATE_FILTER_PREDICATE_KEYS = ['field', 'equals', 'in'];
export const QUERY_PREDICT_KEYS = ['field', 'on', 'method', 'order', 'groupby', 'as'];
export const QUERY_REDUCER_VALUES = ['count', 'distinct-count', 'distinct-list', 'distinct-values', 'calendar-week-rhythm', 'sum', 'mean', 'min', 'max'];
export const QUERY_SELECT_KEYS = ['field', 'as'];
export const QUERY_NUMERIC_REDUCER_VALUES = ['sum', 'mean', 'min', 'max'];
export const INFERRED_FIELD_NAMES = ['package-link'];
export { COMPUTE_FUNCTION_ARITY, NUMERIC_COMPUTE_FUNCTIONS, PREDICTION_METHODS, TEXT_COMPUTE_FUNCTIONS } from './data-operations.js';
export { DASHBOARD_QUERY_LIMITS };
export const QUERY_MAX_JOINS = DASHBOARD_QUERY_LIMITS['max-joins'];
export const SITE_CALLOUT_KEYS = ['id', 'title', 'description', 'icon', 'navigation-page', 'visible-when'];
export const SITE_CALLOUT_VISIBILITY_KEYS = ['source', 'field', 'equals'];
export const TOOLTIP_KEYS = ['label', 'description', 'icon'];
export const DEFAULTS_KEYS = ['scope', 'time', 'filters'];
export const UNIT_DEFINITION_KEYS = ['name', 'symbol', 'significant', 'format'];
export const UNIT_FORMAT_VALUES = ['duration', 'number', 'usd'];
export const NAVIGATION_SECTION_KEYS = ['label', 'pages', 'experimental'];
export const BUILT_IN_PAGE_KEYS = ['id', 'kind', 'page', 'title', 'navigation-label', 'description', 'icon', 'class-name', 'definition'];
export const CUSTOM_PAGE_KEYS = ['id', 'kind', 'title', 'navigation-label', 'description', 'icon', 'class-name', 'route', 'views', 'sections'];
export const PAGE_ROUTE_KEYS = ['hash-query-parameter', 'navigation-page'];

export const VIEW_KEYS = ['id', 'title', 'description', 'intent', 'locked', 'data', 'mark', 'element', 'config', 'callout', 'chart', 'metric', 'list', 'tree', 'layout', 'disclosure', 'disclosure-label', 'controls', 'lazy-list', 'column-summaries', 'empty-message', 'title-link', 'encoding'];
export const VIEW_DATA_KEYS = ['source', 'sources', 'scope', 'time', 'filters', 'arguments', 'route-field', 'limit', 'order-by', 'source-metadata'];
export const VIEW_DATA_ARGUMENT_KEYS = ['name', 'field'];
export const VIEW_ELEMENT_CONFIG_KEYS = ['body', 'sections', 'labels', 'animate'];
export const VIEW_ELEMENT_ANIMATION_VALUES = ['number'];
export const PLURAL_TEXT_KEYS = ['singular', 'plural'];
export const PLURAL_LABEL_ELEMENTS = ['outcomes-overview'];
export const VIEW_TITLE_LINK_KEYS = ['href-field', 'identifier-field'];
export const CALLOUT_KEYS = ['label', 'icon'];
export const VIEW_MARK_VALUES = ['metric', 'table', 'list', 'chart', 'element', 'callout'];
export const VIEW_ELEMENT_VALUES = [
  'domain-attention',
  'package-status-grid',
  'summary-grid',
  'readiness-verdict',
  'context-summary',
  'anomaly-readiness',
  'signal-list',
  'package-activity',
  'package-activity-shell',
  'package-utilization',
  'package-run-trend',
  'package-summary-table',
  'package-insights',
  'package-detail',
  'package-dispatches',
  'package-reports',
  'package-route',
  'workflow-route',
  'workflow-route-page',
  'outcome-detail',
  'outcome-detail-section',
  'configuration-policy',
  'configuration-actions',
  'local-database',
  'work-project-view',
  'agent-marketplace-view',
  'insights-overview',
  'outcomes-overview'
];
export const VIEW_CHART_VALUES = ['bar', 'dot', 'heatmap', 'histogram', 'line', 'pie', 'scatter', 'swimlane'];
export const VIEW_METRIC_KEYS = ['style', 'icon', 'tone', 'navigation-page', 'animate'];
export const VIEW_METRIC_STYLE_VALUES = ['card'];
export const VIEW_METRIC_TONE_VALUES = ['attention', 'danger', 'neutral', 'review'];
export const VIEW_METRIC_ANIMATION_VALUES = ['number'];
export const VIEW_LIST_KEYS = ['style', 'icon', 'action', 'card', 'drill'];
export const VIEW_LIST_STYLE_VALUES = ['cards', 'issues', 'entity-cards'];
export const VIEW_LIST_DRILL_KEYS = ['type', 'field', 'page', 'query', 'title-field', 'arguments'];
export const VIEW_LIST_DRILL_TYPE_VALUES = ['external', 'query'];
export const VIEW_LIST_DRILL_ARGUMENT_KEYS = ['name', 'field'];
export const VIEW_LAYOUT_VALUES = ['full', 'full-view', 'half', 'third', 'horizontal'];
export const VIEW_DISCLOSURE_VALUES = ['essential', 'supplemental'];
export const VIEW_CONTROL_VALUES = ['interactive', 'static'];
export const MAX_ESSENTIAL_VIEWS_PER_PAGE = 4;
export const GRAPHICAL_LAYOUT_EXEMPT_PAGE_IDS = new Set([
  'overview',
  'overview-failed-runs',
  'overview-blocked-work',
  'overview-awaiting-review',
  'overview-security-findings',
  'agent',
  'agents',
  'work',
  'work-tasks',
  'work-roadmap',
  'evidence',
  'insights'
]);
export const VIEW_ENCODING_KEYS = ['value', 'columns', 'x', 'y', 'color', 'reference', 'href', 'actions'];
export const TABLE_ACTION_KEYS = ['intent', 'action', 'presentation', 'icon', 'label', 'context', 'when'];
export const TABLE_ACTION_PRESENTATION_VALUES = ['copy-prompt', 'cli-action'];
export const TABLE_ACTION_WHEN_KEYS = ['field', 'equals'];
export const TREE_TABLE_KEYS = ['id-field', 'parent-field'];
export const FIELD_DEFINITION_KEYS = ['field', 'type', 'aggregate', 'time-unit', 'title', 'as', 'display', 'filter', 'format', 'unit'];
export const FIELD_TYPE_VALUES = ['nominal', 'ordinal', 'quantitative', 'temporal'];
export const FIELD_DISPLAY_VALUES = ['text', 'status', 'grader-status', 'mode', 'active-state', 'label', 'digest', 'outcome-link', 'run-link', 'repository-link', 'workflow-link', 'evidence-link'];
export const FIELD_FORMAT_VALUES = ['human-friendly-timestamp', 'workflow-relative-path', 'workflow-run-url', 'shortened-url'];
export const AGGREGATE_VALUES = ['count', 'distinct-count', 'sum', 'mean', 'min', 'max', 'none'];
export const TIME_UNIT_VALUES = ['hour', 'day', 'week', 'month'];
export const LINK_RELATION_VALUES = [
  'organization',
  'repository',
  'workflow',
  'run',
  'issue',
  'pull-request',
  'evidence',
  'external'
];
export const LINK_OBJECT_KEYS = ['relation', 'href', 'label'];
export const RELATION_LINK_FIELD_RELATIONS = {
  'organization-link': 'organization',
  'repository-link': 'repository',
  'workflow-link': 'workflow',
  'issue-link': 'issue',
  'pull-request-link': 'pull-request',
  'run-link': 'run',
  'evidence-link': 'evidence',
  'external-link': 'external'
};
export const LINK_FIELD_NAMES = Object.keys(RELATION_LINK_FIELD_RELATIONS);
export const DATASET_METADATA_KEYS = [
  'source-id',
  'source-kind',
  'as-of',
  'retrieved-at',
  'coverage-start',
  'coverage-end',
  'completeness',
  'freshness',
  'provenance-link',
  'availability'
];
export const DATASET_COMPLETENESS_VALUES = ['complete', 'partial', 'unknown'];
export const DATASET_FRESHNESS_VALUES = ['fresh', 'stale', 'unknown'];
export const DATASET_AVAILABILITY_VALUES = ['available', 'empty', 'unavailable'];
export const SCOPE_KEYS = ['organizations', 'repositories', 'workflows'];
export const TIME_KEYS = ['range', 'start', 'end'];

export const ORDER_BY_KEYS = ['field', 'direction'];
export const ORDER_DIRECTION_VALUES = ['asc', 'desc'];

export const FILTER_DIMENSION_VALUES = [
  'organization',
  'repository',
  'workflow',
  'package',
  'experiment',
  'variant',
  'workflow-role',
  'workflow-active',
  'admission-status',
  'check-status',
  'resource',
  'credential',
  'operation',
  'phase',
  'risk-status',
  'is-unhealthy',
  'is-current',
  'has-history',
  'attribution-status',
  'run-status',
  'run-conclusion',
  'lifecycle-state',
  'job',
  'job-status',
  'outcome-category',
  'outcome-state',
  'rollout-mode',
  'engine',
  'requested-model',
  'resolved-model',
  'status',
  'eval-result',
  'operational-value-definition',
  'finding-status',
  'finding-severity',
  'security-feature',
  'security-analysis',
  'security-status',
  'detection-state',
  'decision',
  'drift-state',
  'review-state',
  'protocol',
  'policy-rule-id',
  'firewall-enabled',
  'evidence-state'
];

export const PAGE_KIND_VALUES = ['built-in', 'custom'];
export const PAGE_ICON_VALUES = octiconNames;

export const BUILT_IN_PAGE_VALUES = [
  'overview',
  'organizations',
  'repositories',
  'packages',
  'workflows',
  'runs',
  'sessions',
  'events',
  'experiments',
  'graders',
  'evals',
  'usage',
  'engines-models',
  'operational-value',
  'findings',
  'issues'
];

export const BUILT_IN_PAGE_DEFINITION_KEYS = ['views', 'sections', 'data-state'];

export const BUILT_IN_PAGE_DATA_STATE_KEYS = ['availability'];
export const PAGE_SECTION_KEYS = ['id', 'title', 'description', 'layout', 'views', 'count-source', 'count-sources', 'count-field', 'count-label'];
export const PAGE_SECTION_LAYOUT_VALUES = ['full', 'wide', 'narrow', 'horizontal'];

export const BUILT_IN_PAGE_REQUIRED_SOURCES = {
  overview: ['repositories', 'workflows', 'runs', 'usage', 'findings', 'operational-values'],
  organizations: ['organizations', 'repositories', 'workflows', 'runs', 'usage'],
  repositories: ['repository-activity'],
  packages: ['package-inventory'],
  workflows: ['workflow-inventory'],
  runs: ['runs'],
  experiments: ['experiments'],
  graders: ['graders', 'grader-observations'],
  evals: ['evals', 'eval-observations'],
  usage: ['usage'],
  'engines-models': ['model-usage-summary', 'engine-usage-summary', 'run-aggregate-summary'],
  'operational-value': ['operational-values'],
  findings: ['findings'],
  issues: ['issues']
};

export const BUILT_IN_PAGE_REQUIRED_FIELDS = {
  overview: {
    repositories: ['repository'],
    workflows: ['workflow-active', 'rollout-mode'],
    runs: ['run-status', 'run-conclusion', 'repository', 'workflow'],
    usage: ['aic'],
    findings: ['observed-at', 'issue-link', 'pull-request-link', 'run-link'],
    'operational-values': ['operational-value', 'operational-value-definition', 'observed-at']
  },
  organizations: {
    organizations: ['organization'],
    repositories: ['repository'],
    workflows: ['workflow'],
    runs: ['run'],
    usage: ['aic']
  },
  repositories: {
    'repository-activity': ['repository', 'runs', 'failure-summary', 'aic', 'workflows', 'status']
  },
  packages: {
    'package-inventory': ['package-name', 'workflows', 'roles', 'modes', 'registration', 'runs', 'aic']
  },
  workflows: {
    'workflow-inventory': ['runs']
  },
  runs: {
    runs: ['run', 'run-status', 'run-conclusion', 'repository-coordinate', 'workflow', 'rollout-mode', 'engine', 'engine-version', 'requested-model', 'resolved-model', 'started-at']
  },
  experiments: {
    experiments: ['experiment']
  },
  graders: {
    graders: ['grader'],
    'grader-observations': ['grader', 'run', 'value', 'status', 'observed-at']
  },
  evals: {
    evals: ['eval'],
    'eval-observations': ['eval', 'run', 'eval-result', 'requested-model', 'resolved-model', 'observed-at']
  },
  usage: {
    usage: ['input-tokens', 'output-tokens', 'cache-read-tokens', 'cache-write-tokens', 'reasoning-tokens', 'aic', 'estimated-usd', 'engine', 'engine-version', 'requested-model', 'resolved-model', 'organization', 'repository', 'workflow', 'rollout-mode', 'observed-at']
  },
  'engines-models': {
    'model-usage-summary': ['model', 'engine', 'requested-model', 'runs', 'invocations', 'total-aic', 'estimated-usd', 'pricing'],
    'engine-usage-summary': ['engine', 'runs', 'invocations', 'total-aic', 'estimated-usd', 'min-engine-version', 'max-engine-version', 'models'],
    'run-aggregate-summary': ['engine', 'engine-version', 'requested-model', 'resolved-model', 'run-conclusion', 'runs', 'run-link']
  },
  'operational-value': {
    'operational-values': ['observed-at', 'operational-value', 'operational-value-definition', 'operational-case', 'evaluator-digest', 'requested-evidence-at', 'evidence-cutoff', 'maturity-at', 'maturity-status', 'evidence-link', 'experiment', 'delta-from-baseline']
  },
  findings: {
    findings: ['finding-summary', 'finding-severity', 'finding-status', 'organization', 'repository', 'workflow', 'observed-at', 'issue-link', 'pull-request-link', 'run-link']
  },
  issues: {
    issues: ['github-entity-type', 'safe-output-type', 'event-summary', 'entity-url', 'repository', 'workflow', 'run', 'run-link', 'observed-at']
  }
};

export const SOURCE_VALUES = [
  'organizations',
  'packages',
  'repositories',
  'workflows',
  'runs',
  'sessions',
  'events',
  'transactions',
  'admissions',
  'admission-checks',
  'run-performance',
  'job-performance',
  'safe-output-performance',
  'experiments',
  'experiment-assignments',
  'graders',
  'grader-observations',
  'evals',
  'eval-observations',
  'usage',
  'mcp-calls',
  'mcp-servers',
  'security-observations',
  'detection-observations',
  'firewall-observations',
  'firewall-policy-rules',
  'coverage-diagnostics',
  'repository-coverage',
  'runtime-episode-summary',
  'runtime-attribution-gaps',
  'workflow-topology-summary',
  'standalone-workflows',
  'outcomes',
  'findings',
  'operational-values',
  'github-api-rate-limits',
  'github-api-collector-health',
  'github-api-call-stacks',
  'configuration-summary',
  'configuration-policy',
  'configuration-actions',
  'overview-status',
  'overview-vitals',
  'overview-execution-health',
  'failed-runs',
  'overview-attention',
  'overview-managed-packages',
  'overview-package-utilization',
  'readiness-activity',
  'readiness-checks',
  'readiness-summary',
  'readiness-signals',
  'security-summary',
  'security-signals',
  'value-summary',
  'value-signals',
  'value-workflows',
  'cost-summary',
  'cost-signals',
  'runtime-anomaly-readiness',
  'runtime-signals',
  'factory-rhythm-baseline',
  'dispatch-activation-summary',
  'package-dispatch-state',
  'repository-summary',
  'repository-detail-summary',
  'repository-workflow-status',
  'repository-workflow-usage',
  'repository-workflows',
  'model-usage-summary',
  'engine-usage-summary',
  'data-health-collections',
  'data-health-coverage',
  'data-health-schema',
  'source-metadata',
  'work-items',
  'attention-signals',
  'agent-assignments',
  'agent-smells',
  'workflow-smells',
  'security-findings',
  'control-plane-smells',
  'evidence-records'
];

export const SOURCE_FIELDS = {
  organizations: ['organization', 'organization-name', 'observed-at', 'organization-link'],
  packages: ['package', 'package-name', 'package-description', 'package-icon', 'package-mode', 'package-enabled', 'package-registration', 'package-max-repositories', 'package-rollout-percent', 'package-monthly-ai-credit-budget', 'package-aic-allowance', 'package-worker-count', 'package-inventory-warnings', 'package-workers', 'package-targets', 'package-min-version', 'package-version', 'package-current-version', 'package-update-state', 'package-experimental', 'package-readme-path', 'package-readme', 'observed-at', 'package-link'],
  repositories: ['organization', 'repository', 'repository-name', 'repository-coordinate', 'rollout-mode', 'observed-at', 'organization-link', 'repository-link'],
  workflows: ['organization', 'repository', 'package', 'package-name', 'package-icon', 'workflow', 'workflow-name', 'workflow-role', 'workflow-active', 'admission-status', 'admission-reason', 'gh-aw-version', 'gh-aw-current-version', 'gh-aw-version-label', 'gh-aw-update-state', 'gh-aw-metadata', 'gh-aw-manifest', 'rollout-mode', 'max-ai-credits', 'package-aic-allowance', 'package-worker-count', 'package-inventory-warnings', 'inventory-ready', 'observed-at', 'organization-link', 'repository-link', 'workflow-link', 'external-link'],
  runs: ['organization', 'repository', 'workflow', 'run', 'run-attempt', 'run-title', 'target-repository', 'event', 'branch', 'head-sha', 'created-at', 'started-at', 'ended-at', 'updated-at', 'run-status', 'run-conclusion', 'classification', 'duration', 'action-minutes', 'github-api-calls', 'safe-items-count', 'error-count', 'admission-status', 'admission-reason', 'failure-job', 'failure-message', 'failure-step', 'failure-detail', 'resource', 'resource-reset-at', 'resource-wait-hours', 'rollout-mode', 'agent-id', 'agent-version', 'model-id', 'gh-aw-version', 'aic-total', 'engine', 'engine-id', 'engine-version', 'requested-model', 'resolved-model', 'agent-runtime', 'firewall-version', 'gateway-version', 'data', 'logs-payload', 'organization-link', 'repository-link', 'workflow-link', 'run-link'],
  sessions: ['organization', 'repository', 'workflow', 'run', 'run-attempt', 'job-id', 'session', 'session-kind', 'session-status', 'started-at', 'ended-at', 'observed-at'],
  events: ['organization', 'repository', 'workflow', 'run', 'run-attempt', 'session', 'event', 'event-timestamp', 'event-source', 'event-type', 'event-summary', 'event-status', 'request-count', 'correlation-id', 'payload-ref', 'mcp-server', 'mcp-tool', 'safe-output-type', 'github-entity-type', 'source-sequence', 'observed-at', 'run-link', 'target-repo', 'target-organization', 'target-repository', 'target-workflow-path', 'optimizer-run-attempt', 'optimizer-workflow-path', 'optimizer-workflow-name', 'claim-run-id', 'claim-run-attempt', 'actor', 'source-provenance', 'opportunity-id', 'opportunity-kind', 'assignment-run', 'experiment', 'evidence-window-start', 'evidence-window-end', 'evidence-state', 'evidence-confidence', 'cost-grain', 'evidence-provenance', 'attributable-run-ids', 'intervention-id', 'lifecycle-observation-id', 'previous-intervention-state', 'intervention-state', 'previous-recommendation-disposition', 'recommendation-disposition', 'supersedes-intervention-id', 'superseded-by-intervention-id', 'recommendation-churn-count', 'recommendation-churn-rate', 'control-variant', 'optimized-variant', 'proposed-savings-aic', 'missing-reason', 'safe-output-id', 'safe-output-url', 'implementation-change-id', 'implementation-pull-request-url', 'implementation-run-ids', 'accepted-at', 'implementation-started-at', 'implementation-completed-at', 'rejected-at', 'superseded-at'],
  transactions: ['id', 'kind', 'createdAt', 'payloadScope', 'payloadHash', 'payloadEtag', 'records', 'committedRecords', 'rawPayloadRecords', 'rawRuns', 'agenticRunRecords', 'agenticRuns', 'duplicateRawRunObservations', 'duplicateAgenticRunObservations', 'unenrichedRuns', 'error'],
  admissions: ['organization', 'repository', 'workflow', 'run', 'observed-at', 'package', 'workflow-role', 'worker', 'target-repository', 'admission-status', 'admission-reason', 'failed-check', 'github-api-status', 'github-api-remaining', 'github-api-required', 'github-api-reset-at', 'runner-disk-status', 'runner-disk-available-mb', 'runner-disk-required-mb', 'run-link'],
  'admission-checks': ['organization', 'repository', 'workflow', 'run', 'observed-at', 'package', 'workflow-role', 'worker', 'target-repository', 'admission-status', 'admission-reason', 'failed-check', 'check', 'check-order', 'check-status', 'github-api-status', 'github-api-remaining', 'github-api-required', 'github-api-reset-at', 'runner-disk-status', 'runner-disk-available-mb', 'runner-disk-required-mb', 'run-link'],
  'run-performance': ['organization', 'repository', 'workflow', 'run', 'started-at', 'run-conclusion', 'rollout-mode', 'run-duration-seconds', 'sandbox-runtime', 'engine', 'model', 'run-link'],
  'job-performance': ['organization', 'repository', 'workflow', 'run', 'run-attempt', 'started-at', 'run-conclusion', 'rollout-mode', 'job-id', 'job', 'job-status', 'job-conclusion', 'job-duration-seconds', 'runner', 'runner-name', 'runner-group', 'sandbox-runtime', 'engine', 'model', 'run-link'],
  experiments: ['organization', 'repository', 'package', 'workflow', 'experiment', 'experiment-name', 'control-variant', 'candidate-variant', 'primary-metric', 'primary-source', 'state', 'readiness', 'decision', 'normalized-effect', 'evidence-strength', 'last-observation', 'observed-at'],
  'experiment-assignments': ['organization', 'repository', 'package', 'workflow', 'run', 'experiment', 'variant', 'assignment-at', 'included', 'exclusion-reason', 'observed-at', 'assignment-link', 'artifact-link', 'trace-link'],
  graders: ['grader', 'grader-name', 'role', 'direction', 'unit', 'threshold', 'observed-at'],
  'grader-observations': ['organization', 'repository', 'workflow', 'run', 'experiment', 'variant', 'grader', 'value', 'status', 'included', 'exclusion-reason', 'role', 'direction', 'unit', 'threshold', 'rollout-mode', 'maturity-status', 'baseline-value', 'delta-from-baseline', 'evaluator-digest', 'observed-at', 'run-link', 'evidence-link', 'grader-link'],
  evals: ['eval', 'eval-name', 'eval-question', 'requested-model', 'role', 'direction', 'observed-at'],
  'eval-observations': ['organization', 'repository', 'workflow', 'run', 'experiment', 'variant', 'eval', 'eval-result', 'status', 'included', 'exclusion-reason', 'role', 'direction', 'requested-model', 'resolved-model', 'rollout-mode', 'observed-at', 'evidence-link', 'eval-link'],
  usage: ['organization', 'repository', 'workflow', 'run', 'invocation', 'engine', 'engine-version', 'requested-model', 'resolved-model', 'rollout-mode', 'input-tokens', 'output-tokens', 'cache-read-tokens', 'cache-write-tokens', 'reasoning-tokens', 'aic', 'estimated-usd', 'observed-at', 'organization-link', 'repository-link', 'workflow-link', 'run-link'],
  'mcp-calls': ['organization', 'repository', 'workflow', 'run', 'mcp-observation', 'mcp-server', 'mcp-server-version', 'mcp-protocol-version', 'mcp-tool', 'mcp-status', 'response-bytes', 'rollout-mode', 'engine-version', 'gh-aw-version', 'observed-at', 'run-link'],
  'mcp-servers': ['organization', 'repository', 'workflow', 'run', 'mcp-server-observation', 'mcp-server', 'mcp-server-version', 'mcp-protocol-version', 'mcp-status', 'tool-calls', 'failed-calls', 'total-response-bytes', 'max-response-bytes', 'rollout-mode', 'engine-version', 'gh-aw-version', 'observed-at', 'run-link'],
  'security-observations': ['organization', 'repository', 'workflow', 'run', 'security-observation', 'security-feature', 'security-analysis', 'security-signal', 'security-status', 'security-subject', 'security-count', 'observed-at', 'run-link'],
  'detection-observations': ['organization', 'repository', 'workflow', 'run', 'observed-at', 'run-link', 'rollout-mode', 'detection-expected', 'detection-applicable', 'detection-executed', 'verdict-available', 'usable-verdict-percent', 'detection-state', 'detection-state-label', 'detection-count', 'prompt-injection-detected', 'secret-leak-detected', 'malicious-patch-detected', 'inspection-warning-count', 'inspection-warning', 'detection-signal', 'attention-priority', 'job-status', 'job-conclusion', 'job-duration-seconds', 'runner', 'engine', 'requested-model', 'resolved-model'],
  'firewall-observations': ['organization', 'repository', 'workflow', 'run', 'firewall-observation', 'run-conclusion', 'rollout-mode', 'observed-at', 'firewall-expected', 'firewall-enabled', 'enforcement-label', 'firewall-evidence-available', 'evidence-state', 'evidence-label', 'evidence-completeness', 'evidence-freshness', 'evidence-error', 'evidence-source', 'evidence-reference', 'evidence-horizon-start', 'evidence-horizon-end', 'requested-horizon-start', 'requested-horizon-end', 'evidence-coverage-percent', 'last-successful-collection-at', 'gh-aw-firewall-version', 'policy-manifest-available', 'policy-source', 'policy-manifest-identity', 'domain', 'host', 'port', 'protocol', 'decision', 'decision-label', 'request-count', 'policy-rule-id', 'policy-rule-order', 'policy-rule-action', 'policy-rule-protocol', 'policy-domain-pattern', 'policy-rule-description', 'baseline-request-count', 'request-volume-change', 'previous-decision', 'current-decision', 'is-new-destination', 'is-removed-destination', 'decision-changed', 'first-seen-at', 'last-seen-at', 'drift-state', 'drift-label', 'review-state', 'review-label', 'review-priority', 'run-link', 'evidence-link'],
  'firewall-policy-rules': ['organization', 'repository', 'workflow', 'run', 'observed-at', 'rule-id', 'rule-order', 'action', 'protocol', 'domain-pattern', 'description', 'hit-count', 'ssl-bump-enabled', 'dlp-enabled', 'host-access-enabled', 'policy-source', 'policy-manifest-identity', 'run-link', 'evidence-link'],
  'coverage-diagnostics': ['kind', 'title', 'effect', 'technical-detail', 'endpoint', 'rate-limit-reset', 'snapshot-age-seconds'],
  'repository-coverage': ['label', 'value'],
  'data-health-collections': ['operation', 'source', 'state', 'failure-class', 'progress', 'collector-completed-at', 'retrieved-at', 'source-as-of', 'evidence-horizon', 'fallback', 'snapshot-age', 'provenance', 'technical-detail', 'reason'],
  'data-health-coverage': ['area', 'expected', 'observed', 'missing', 'coverage-percent', 'state', 'reason', 'requested-horizon', 'observed-horizon'],
  'data-health-schema': ['source', 'schema'],
  'source-metadata': ['source', 'row-count', 'source-id', 'source-kind', 'as-of', 'retrieved-at', 'availability', 'completeness', 'freshness', 'collection-operation', 'collection-state', 'collection-progress', 'collection-reason', 'failure-class', 'collector-completed-at', 'coverage-start', 'coverage-end', 'requested-coverage-start', 'requested-coverage-end', 'coverage-expected', 'coverage-observed', 'snapshot-age-seconds', 'fallback-used'],
  'runtime-episode-summary': ['label', 'value'],
  'runtime-attribution-gaps': ['run', 'run-title', 'workflow', 'status', 'control-transition', 'reason-code', 'evidence', 'run-link'],
  outcomes: ['organization', 'repository', 'package', 'runtime-repository', 'workflow', 'workflow-name', 'run', 'run-conclusion', 'safe-output', 'safe-output-kind', 'outcome-number', 'outcome-title', 'outcome-summary', 'outcome-body-html', 'outcome-category', 'outcome-status', 'outcome-state', 'outcome-warning', 'evidence-strength', 'rollout-mode', 'engine', 'engine-version', 'requested-model', 'resolved-model', 'published-at', 'observed-at', 'issue-link', 'pull-request-link', 'run-link', 'external-link', 'organization-link', 'repository-link', 'workflow-link'],
  'safe-output-performance': ['organization', 'repository', 'workflow', 'run', 'run-conclusion', 'rollout-mode', 'safe-output-kind', 'safe-output-label', 'safe-output-status', 'safe-output-count', 'observed-at', 'run-link'],
  findings: ['organization', 'repository', 'workflow', 'run', 'safe-output', 'finding', 'finding-kind', 'finding-severity', 'finding-status', 'finding-summary', 'observed-at', 'engine', 'engine-version', 'requested-model', 'resolved-model', 'issue-link', 'pull-request-link', 'run-link', 'external-link', 'organization-link', 'repository-link', 'workflow-link'],
  'operational-values': ['organization', 'repository', 'repository-name', 'workflow', 'run', 'run-attempt', 'observation-id', 'experiment', 'operational-case', 'evaluator-digest', 'rollout-mode', 'operational-value', 'operational-value-definition', 'requested-evidence-at', 'evidence-cutoff', 'maturity-at', 'maturity-status', 'baseline-value', 'delta-from-baseline', 'accepted-evidence-provenance', 'diagnostics', 'diagnostic-definitions', 'observed-at', 'evidence-link', 'organization-link', 'repository-link', 'workflow-link', 'run-link'],
  'github-api-rate-limits': ['observation-id', 'operation-execution-id', 'observed-at', 'phase', 'operation', 'outcome', 'credential', 'credential-type', 'resource', 'bucket', 'maximum-lane', 'history-series', 'has-history', 'limit', 'used', 'remaining', 'remaining-percent', 'reset-at', 'minutes-to-reset', 'consumed-since-previous', 'burn-rate-per-minute', 'projected-remaining-at-reset', 'projected-exhaustion-at', 'runway-ratio', 'risk-status', 'risk-order', 'is-unhealthy', 'is-current', 'attribution-status', 'operation-consumed', 'run-link'],
  'github-api-collector-health': ['observed-at', 'operation-execution-id', 'phase', 'operation', 'outcome', 'credential', 'cache-hydrated', 'cache-bytes', 'cache-entries', 'cache-folders', 'rate-limit-error'],
  'github-api-call-stacks': ['observed-at', 'operation-execution-id', 'phase', 'operation', 'outcome', 'credential', 'stack-frame-id', 'stack-parent-id', 'stack-depth', 'stack-frame'],
  'configuration-summary': ['status', 'count'],
  'configuration-policy': ['path', 'document', 'raw', 'diagnostics'],
  'configuration-actions': ['action', 'path', 'current', 'recommended', 'prompt'],
  'failed-runs': ['organization', 'repository', 'workflow', 'run', 'run-attempt', 'run-title', 'started-at', 'ended-at', 'run-status', 'run-conclusion', 'failure-detail', 'run-link'],
  'readiness-activity': ['activity-hour', 'workflow-role', 'run-count'],
  'readiness-checks': ['check', 'readiness-state', 'detail'],
  'readiness-summary': ['label', 'value'],
  'readiness-signals': ['priority', 'urgency', 'count', 'tone', 'icon', 'kind', 'title', 'detail', 'evidence', 'action', 'navigation-page', 'run-link', 'external-link'],
  'security-summary': ['label', 'value'],
  'security-signals': ['priority', 'count', 'tone', 'icon', 'kind', 'title', 'detail', 'evidence', 'action', 'navigation-page', 'navigation-href', 'run-link', 'external-link'],
  'value-summary': ['label', 'value'],
  'value-signals': ['priority', 'count', 'tone', 'icon', 'kind', 'title', 'detail', 'evidence', 'action', 'navigation-page', 'run-link', 'external-link'],
  'value-workflows': ['organization', 'repository', 'workflow', 'run', 'operational-value-definition', 'opportunities', 'mature-observations', 'mean-operational-value', 'mean-baseline', 'observed-at', 'evidence-link', 'run-link', 'organization-link', 'repository-link', 'workflow-link'],
  'cost-summary': ['label', 'value'],
  'cost-signals': ['priority', 'count', 'tone', 'icon', 'kind', 'title', 'detail', 'evidence', 'action', 'navigation-page'],
  'runtime-anomaly-readiness': ['icon', 'title', 'detail'],
  'runtime-signals': ['priority', 'count', 'tone', 'icon', 'kind', 'title', 'detail', 'evidence', 'action', 'navigation-href'],
  'factory-rhythm-baseline': ['daily-averages', 'weeks'],
  'dispatch-activation-summary': ['label', 'value'],
  'package-dispatch-state': ['package', 'package-name', 'dispatch-runs', 'skipped', 'failed', 'succeeded', 'worker-dispatches', 'aic', 'agent', 'model'],
  'repository-summary': ['label', 'value', 'items'],
  'repository-activity': ['repository', 'workflows', 'reports', 'evaluated-workflows', 'runs', 'failure-summary', 'aic', 'status', 'repository-link'],
  'repository-detail-summary': ['repository', 'workflows', 'latest-update', 'external-link'],
  'repository-workflow-status': ['repository', 'status', 'workflows'],
  'repository-workflow-usage': ['repository', 'workflow', 'invocation', 'aic', 'workflow-link'],
  'repository-workflows': ['repository', 'workflow', 'workflow-name', 'workflow-role', 'package-name', 'rollout-mode', 'workflow-active', 'observed-at', 'aic', 'workflow-link'],
  'model-usage-summary': ['model', 'resolved-model', 'engine', 'requested-model', 'runs', 'invocations', 'total-aic', 'estimated-usd', 'pricing'],
  'engine-usage-summary': ['engine', 'runs', 'invocations', 'total-aic', 'estimated-usd', 'min-engine-version', 'max-engine-version', 'models'],
  'run-aggregate-summary': ['engine', 'engine-version', 'requested-model', 'resolved-model', 'run-conclusion', 'runs', 'run-link'],
  'workflow-topology-summary': ['label', 'value'],
  'packaged-workflows': ['package', 'package-name', 'repository', 'workflow', 'workflow-name', 'workflow-role', 'rollout-mode', 'workflow-active', 'runs', 'aic', 'package-link', 'repository-link', 'workflow-link', 'external-link'],
  'standalone-workflows': ['repository', 'workflow', 'workflow-name', 'rollout-mode', 'workflow-active', 'runs', 'aic', 'repository-link', 'workflow-link'],
  'work-items': ['work-item-id', 'name', 'objective', 'organization', 'repository', 'workflow', 'workflow-name', 'workflow-icon', 'workflow-role', 'scope', 'domain', 'package', 'package-name', 'package-icon', 'work-type', 'lifecycle-state', 'phase', 'reason', 'reason-evidence-class', 'next-action', 'next-actor', 'safe-output-kind', 'waiting-on', 'waiting-since', 'owner', 'consequence-tier', 'verification-state', 'outcome-state', 'started-at', 'ended-at', 'observed-at', 'evidence-link', 'repository-link', 'run-link'],
  'attention-signals': ['attention-signal-id', 'signal-type', 'work-item-id', 'objective', 'scope', 'reason', 'action', 'expected-actor', 'age-seconds', 'consequence-tier', 'priority', 'observed-at', 'evidence-link', 'repository-link', 'run-link'],
  'agent-assignments': ['assignment-id', 'agent-id', 'agent-name', 'agent-icon', 'agent-description', 'permissions', 'agent-state', 'work-item-id', 'objective', 'assignment-state', 'handoff-state', 'dependency-state', 'conflict-state', 'run-count', 'total-runtime-seconds', 'last-observed-at', 'long-running', 'stale', 'observed-at', 'evidence-link', 'repository-link', 'run-link'],
  'agent-smells': ['smell-observation-id', 'smell-id', 'smell-name', 'smell-category', 'smell-severity', 'smell-summary', 'smell-evidence', 'smell-recommendation', 'organization', 'repository', 'workflow', 'run', 'observed-at', 'evidence-link', 'repository-link', 'workflow-link', 'run-link'],
  'workflow-smells': ['smell-observation-id', 'smell-id', 'smell-name', 'smell-category', 'smell-severity', 'smell-summary', 'smell-evidence', 'smell-recommendation', 'organization', 'repository', 'workflow', 'run', 'observed-at', 'evidence-link', 'repository-link', 'workflow-link', 'run-link'],
  'security-findings': ['smell-observation-id', 'smell-id', 'smell-name', 'smell-category', 'smell-severity', 'smell-summary', 'smell-evidence', 'smell-recommendation', 'organization', 'repository', 'workflow', 'run', 'observed-at', 'evidence-link', 'repository-link', 'workflow-link', 'run-link'],
  'control-plane-smells': ['smell-observation-id', 'smell-id', 'smell-name', 'smell-category', 'smell-severity', 'smell-summary', 'smell-evidence', 'smell-recommendation', 'organization', 'repository', 'workflow', 'run', 'observed-at', 'evidence-link', 'repository-link', 'workflow-link', 'run-link'],
  'evidence-records': ['evidence-id', 'evidence-class', 'evidence-kind', 'work-item-id', 'objective', 'claim', 'verification-state', 'provenance-state', 'source-revision', 'observed-at', 'evidence-link', 'repository-link', 'run-link']
};

export const ROLLOUT_MODE_VALUES = ['review', 'live', 'unknown'];
export const DETECTION_STATE_VALUES = ['clean', 'threat', 'degraded', 'tooling-failure', 'skipped', 'unknown'];
export const WORKFLOW_ACTIVE_VALUES = ['true', 'false', 'unknown'];
export const WORKFLOW_ROLE_VALUES = ['orchestrator', 'worker', 'standalone'];
export const RUN_STATUS_VALUES = ['queued', 'in-progress', 'completed', 'unknown'];
export const RUN_CONCLUSION_VALUES = [
  'success',
  'failure',
  'cancelled',
  'timed-out',
  'action-required',
  'neutral',
  'skipped',
  'stale',
  'startup-failure',
  'unknown'
];
export const GRADER_STATUS_VALUES = ['pass', 'fail', 'error', 'unavailable'];
export const DISPATCH_STATUS_VALUES = [...RUN_CONCLUSION_VALUES, ...RUN_STATUS_VALUES];
export const EVAL_RESULT_VALUES = ['YES', 'NO', 'UNKNOWN'];
export const OUTCOME_STATE_VALUES = ['accepted', 'rejected', 'ignored', 'pending', 'lifecycle', 'lifecycle-close'];
export const FINDING_STATUS_VALUES = ['open', 'resolved', 'dismissed', 'unknown'];
export const FINDING_SEVERITY_VALUES = ['critical', 'high', 'medium', 'low', 'informational', 'unknown'];

export const SOURCE_ENTITY_IDENTIFIER_FIELDS = {
  organizations: ['organization'],
  repositories: ['repository'],
  workflows: ['workflow'],
  runs: ['run'],
  admissions: ['run'],
  'admission-checks': ['run', 'check'],
  'run-performance': ['run'],
  'job-performance': ['run', 'job'],
  'safe-output-performance': ['run', 'safe-output-kind'],
  experiments: ['experiment'],
  'experiment-assignments': ['run', 'experiment', 'variant'],
  graders: ['grader'],
  'grader-observations': ['grader', 'run'],
  evals: ['eval'],
  'eval-observations': ['eval', 'run'],
  usage: ['invocation'],
  'mcp-calls': ['mcp-observation'],
  'mcp-servers': ['mcp-server-observation'],
  'security-observations': ['security-observation'],
  'detection-observations': ['run'],
  'firewall-observations': ['firewall-observation'],
  'firewall-policy-rules': ['run', 'rule-id', 'domain-pattern'],
  'repository-coverage': ['label'],
  'runtime-episode-summary': ['label'],
  'runtime-episodes': ['run'],
  'runtime-attribution-gaps': ['run'],
  outcomes: ['safe-output'],
  findings: ['finding'],
  'operational-values': ['operational-value-definition', 'operational-case', 'run'],
  'github-api-rate-limits': ['observation-id'],
  'github-api-collector-health': ['operation-execution-id', 'observed-at'],
  'repository-summary': ['label'],
  'repository-activity': ['repository'],
  'repository-detail-summary': ['repository'],
  'repository-workflow-status': ['repository', 'status'],
  'repository-workflow-usage': ['invocation'],
  'repository-workflows': ['repository', 'workflow'],
  'workflow-runs': ['workflow-route', 'run'],
  'workflow-reports': ['workflow-route', 'safe-output'],
  'package-reports': ['package', 'safe-output'],
  'work-items': ['work-item-id'],
  'attention-signals': ['attention-signal-id'],
  'agent-assignments': ['assignment-id'],
  'evidence-records': ['evidence-id']
};

export const TEMPORAL_FIELD_NAMES = [
  'observed-at',
  'started-at',
  'activity-hour',
  'ended-at',
  'requested-evidence-at',
  'evidence-cutoff',
  'maturity-at',
  'published-at',
  'reset-at',
  'projected-exhaustion-at',
  'evidence-horizon-start',
  'evidence-horizon-end',
  'requested-horizon-start',
  'requested-horizon-end',
  'last-successful-collection-at',
  'first-seen-at',
  'last-seen-at',
  'waiting-since'
];

export const ADDITIVE_MEASURE_FIELDS = [
  'input-tokens',
  'output-tokens',
  'cache-read-tokens',
  'cache-write-tokens',
  'reasoning-tokens',
  'aic',
  'security-count',
  'response-bytes',
  'tool-calls',
  'failed-calls',
  'total-response-bytes',
  'safe-output-count',
  'request-count',
  'hit-count'
];

export const NON_ADDITIVE_MEASURE_FIELDS = [
  'value',
  'operational-value',
  'limit',
  'used',
  'remaining',
  'remaining-percent',
  'minutes-to-reset',
  'consumed-since-previous',
  'burn-rate-per-minute',
  'projected-remaining-at-reset',
  'runway-ratio',
  'operation-consumed',
  'max-response-bytes',
  'port',
  'policy-rule-order',
  'baseline-request-count',
  'request-volume-change',
  'evidence-coverage-percent',
  'review-priority'
];

export const ERROR_CODES = {
  invalidYamlSyntax: 'DLS-E001',
  invalidDocumentShape: 'DLS-E002',
  missingOrInvalidRequiredField: 'DLS-E003',
  unknownOrDuplicateKey: 'DLS-E004',
  nonCanonicalVocabularyOrIdentifier: 'DLS-E005',
  incompatibleMarkChannelTypeOrTimeUnit: 'DLS-E007',
  invalidLinkReference: 'DLS-E009',
  invalidScopeFilterTimeAggregationOrOrderReference: 'DLS-E010',
  invalidEntityRelationshipOrSourceGrain: 'DLS-E011',
  missingRequiredProvenanceOrDataStateMetadata: 'DLS-E012',
  invalidProgressiveDisclosureConfiguration: 'DLS-E013',
  invalidGraphicalNesting: 'DLS-E014'
};
